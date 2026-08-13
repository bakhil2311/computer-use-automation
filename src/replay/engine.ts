import type { Page } from "playwright";
import type { Artifact, Step, ValueSpec } from "../types/artifact.js";
import { compileFieldSchema } from "../types/paramSchema.js";
import { RunLogger, newRunId } from "../logging/logger.js";
import { Allowlist, loadAllowlist, AllowlistViolation } from "../guardrails/allowlist.js";
import { evaluateRisk } from "../guardrails/risk.js";
import { resolveTarget, resolveFrame, LocatorResolutionError, type ResolvedTarget } from "./locator.js";
import { matchOutcome } from "./outcomeMatch.js";
import { launchSession, closeSession } from "../agent/browserSession.js";
import { registerDialogHandler, writeDialogPolicy } from "../agent/dialogPolicy.js";
import { initSessionState, updateSessionState } from "../escalation/sessionState.js";
import { escalate, EscalationTimeoutError } from "../escalation/controlTransfer.js";
import type { ReplayResult, FailureKind } from "./errors.js";

export interface ReplayOptions {
  /** Step ids the caller has pre-approved to run unattended despite being risky/irreversible. */
  approvedStepIds?: string[];
  evidenceRoot?: string;
  allowlistPath?: string;
  credentials?: { username: string; password: string };
  escalationTimeoutMs?: number;
  headful?: boolean;
}

class HardFailure extends Error {
  constructor(public kind: FailureKind, public expected: string, public observed: string) {
    super(`${kind}: expected ${expected}, observed ${observed}`);
  }
}
class BusinessOutcomeSignal extends Error {
  constructor(public code: string, public description: string) {
    super(code);
  }
}

function resolveValue(v: ValueSpec | undefined, params: Record<string, unknown>): string | undefined {
  if (!v) return undefined;
  if ("literal" in v) return String(v.literal);
  return params[v.paramRef] !== undefined ? String(params[v.paramRef]) : undefined;
}

async function ensureAuthenticated(page: Page, baseUrl: string, creds: { username: string; password: string }, logger: RunLogger) {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.fill("#ctl00_lgn_uname", creds.username);
  await page.fill("#ctl00_lgn_pwd", creds.password);
  await page.click("#ctl00_lgn_btnSubmit");
  await page.waitForLoadState("domcontentloaded");
  logger.event("authenticated", { username: creds.username });
}

async function performAction(page: Page, step: Step, params: Record<string, unknown>, logger: RunLogger, runDir: string): Promise<ResolvedTarget | undefined> {
  if (step.action === "navigate") {
    const url = resolveValue(step.value, params)!;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: step.timeoutMs });
    return undefined;
  }
  if (step.action === "waitFor") {
    if (!step.target) {
      await page.waitForTimeout(step.timeoutMs);
      return undefined;
    }
    return resolveTarget(page, step.target, { probeTimeoutMs: step.timeoutMs });
  }

  if (!step.target) throw new Error(`Step ${step.id} (${step.action}) has no target`);
  const resolved = await resolveTarget(page, step.target, { probeTimeoutMs: step.timeoutMs });
  // Arm the shared dialog policy rather than registering a listener here —
  // see agent/dialogPolicy.ts: the *one* persistent listener lives on the
  // connection that owns the page for the run's lifetime (registered once
  // in replayArtifact below), so it also covers dialogs a human operator
  // triggers from a separate attached connection during escalation.
  if (step.dialogPolicy !== "none") writeDialogPolicy(runDir, step.dialogPolicy);

  switch (step.action) {
    case "click": {
      if (resolved.kind === "locator") await resolved.locator.click({ timeout: step.timeoutMs });
      else await page.mouse.click(resolved.x, resolved.y);
      break;
    }
    case "type": {
      const text = resolveValue(step.value, params) ?? "";
      if (resolved.kind === "locator") await resolved.locator.fill(text, { timeout: step.timeoutMs });
      else {
        await page.mouse.click(resolved.x, resolved.y);
        await page.keyboard.type(text);
      }
      break;
    }
    case "select": {
      const val = resolveValue(step.value, params) ?? "";
      if (resolved.kind === "locator") await resolved.locator.selectOption(val, { timeout: step.timeoutMs });
      break;
    }
    case "keypress": {
      const key = resolveValue(step.value, params) ?? "Enter";
      if (resolved.kind === "locator") await resolved.locator.press(key, { timeout: step.timeoutMs });
      else await page.keyboard.press(key);
      break;
    }
    case "extract": {
      // handled by caller (needs to store into outputs); nothing to do here besides resolving.
      break;
    }
    case "assertCheckpoint":
      break;
  }
  return resolved;
}

/**
 * Deterministic replay: no model in the loop. Every decision — which
 * locator strategy to use, what a branch in the UI means, whether a state
 * is recoverable — was made once during discovery and is now just *read*
 * from the artifact. See REPORT.md section 3 for the full design.
 */
export async function replayArtifact(
  artifact: Artifact,
  params: Record<string, unknown>,
  opts: ReplayOptions = {}
): Promise<ReplayResult> {
  const runId = newRunId(`replay-${artifact.name}`);
  const evidenceRoot = opts.evidenceRoot ?? "evidence";
  const runDir = `${evidenceRoot}/${runId}`;
  const sensitiveKeys = [...artifact.params, ...artifact.outputs].filter((f) => f.sensitive).map((f) => f.name);
  const logger = new RunLogger(runId, runDir, sensitiveKeys);
  const startedAt = new Date().toISOString();
  let humanEscalations = 0;

  logger.event("replay_started", { artifactId: artifact.artifactId, artifactName: artifact.name, artifactVersion: artifact.version, params });

  // 1. Validate caller-supplied params against the artifact's own declared contract.
  let validatedParams: Record<string, unknown>;
  try {
    validatedParams = compileFieldSchema(artifact.params).parse(params) as Record<string, unknown>;
  } catch (err) {
    const failure = { kind: "invalid_params" as FailureKind, expected: "params matching artifact.params schema", observed: String(err) };
    logger.event("replay_failed", failure);
    logger.close();
    return finish("failure", { failure }, runId, artifact, startedAt, 0, humanEscalations);
  }

  const allowlist = new Allowlist(loadAllowlist(opts.allowlistPath));
  const creds = opts.credentials ?? {
    username: process.env.TARGET_APP_USERNAME ?? "operator1",
    password: process.env.TARGET_APP_PASSWORD ?? "Passw0rd!",
  };

  const session = await launchSession();
  registerDialogHandler(session.page, runDir, logger);
  initSessionState(runDir, runId, session.cdpUrl);
  const outputs: Record<string, unknown> = {};
  let stepsExecuted = 0;

  try {
    allowlist.assertDomainAllowed(artifact.target.baseUrl);
    await ensureAuthenticated(session.page, artifact.target.baseUrl, creds, logger);

    for (const step of [...artifact.steps].sort((a, b) => a.index - b.index)) {
      stepsExecuted += 1;
      logger.event("step_started", { stepId: step.id, index: step.index, action: step.action, description: step.description });

      allowlist.assertActionAllowed(step.action);
      if (step.action === "navigate") {
        const url = resolveValue(step.value, validatedParams);
        if (url) allowlist.assertRouteAllowed(new URL(url, artifact.target.baseUrl).pathname);
      }

      // --- risk gate ---
      const risk = evaluateRisk({
        risk: step.risk,
        requiresConfirmation: step.requiresConfirmation,
        approved: opts.approvedStepIds?.includes(step.id),
      });
      logger.event("risk_evaluated", { stepId: step.id, risk: step.risk, allowed: risk.allowed, reason: risk.reason });

      if (!risk.allowed) {
        humanEscalations += 1;
        const resumedState = await escalate(
          runDir,
          session.page,
          logger,
          `Step "${step.description}" is ${step.risk} and requires human approval before it can run unattended.`,
          "IRREVERSIBLE_STEP_REQUIRES_APPROVAL",
          { stepId: step.id, stepIndex: step.index, capability: artifact.name },
          opts.escalationTimeoutMs !== undefined ? { timeoutMs: opts.escalationTimeoutMs } : {}
        );
        // Safety rule: never auto-execute an irreversible action after a human
        // handoff — the human may have already performed it live. Instead we
        // check whether its declared "success" outcome is now true.
        const successOutcome = step.outcomes.find((o) => o.classification === "success");
        const satisfied = successOutcome
          ? await matchOutcome(session.page, successOutcome.match, 3000)
          : await matchOutcome(session.page, { urlPattern: artifact.checkpoint.urlPattern, textPattern: artifact.checkpoint.textPattern, locator: artifact.checkpoint.locator, frame: artifact.checkpoint.frame }, 3000);
        logger.event("post_handoff_check", { stepId: step.id, satisfied, humanActions: resumedState.humanActions.length });
        if (!satisfied) {
          throw new HardFailure("checkpoint_failed", `outcome of "${step.description}" after human handoff`, "condition not observed after resume");
        }
        continue; // step considered complete (performed by the human operator)
      }

      // --- execute with bounded retries ---
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          await performAction(session.page, step, validatedParams, logger, runDir);
          break;
        } catch (err) {
          if (err instanceof LocatorResolutionError && attempt < step.retry.max) {
            attempt += 1;
            logger.event("step_retry", { stepId: step.id, attempt, error: err.message });
            await new Promise((r) => setTimeout(r, step.retry.backoffMs * attempt));
            continue;
          }
          throw new HardFailure("element_not_found", step.target?.description ?? step.description, err instanceof Error ? err.message : String(err));
        }
      }

      if (step.action === "extract" && step.extractAs) {
        const resolved = await resolveTarget(session.page, step.target!, { probeTimeoutMs: step.timeoutMs });
        const text = resolved.kind === "locator" ? (await resolved.locator.textContent())?.trim() ?? "" : "";
        outputs[step.extractAs] = text;
        logger.event("output_extracted", { stepId: step.id, name: step.extractAs });
      }

      // --- declared outcome branches ---
      // Loop rather than a single pass so a `recoverable` branch (e.g. a
      // transient error page) can retry the step and re-evaluate the
      // branches against the fresh page state, bounded by step.retry.max.
      if (step.outcomes.length > 0) {
        let recoverAttempts = 0;
        outcomeLoop: while (true) {
          let matchedOutcome: (typeof step.outcomes)[number] | undefined;
          for (const outcome of step.outcomes) {
            if (await matchOutcome(session.page, outcome.match, 2000)) {
              matchedOutcome = outcome;
              break;
            }
          }
          if (!matchedOutcome) {
            throw new HardFailure(
              "unexpected_state",
              step.outcomes.map((o) => o.code).join(" | "),
              `page state after "${step.description}" matched none of the ${step.outcomes.length} declared outcome(s). url=${session.page.url()}`
            );
          }
          logger.event("outcome_matched", { stepId: step.id, code: matchedOutcome.code, classification: matchedOutcome.classification });

          switch (matchedOutcome.classification) {
            case "success":
              break outcomeLoop;
            case "business_outcome": {
              if (matchedOutcome.populatesOutputs) {
                for (const name of matchedOutcome.populatesOutputs) {
                  if (!(name in outputs)) outputs[name] = null;
                }
              }
              throw new BusinessOutcomeSignal(matchedOutcome.code, matchedOutcome.description);
            }
            case "hard_failure":
              throw new HardFailure("unexpected_state", matchedOutcome.description, `matched declared failure branch: ${matchedOutcome.code}`);
            case "recoverable": {
              recoverAttempts += 1;
              if (recoverAttempts > step.retry.max) {
                throw new HardFailure("unexpected_state", "recoverable condition to clear", `retries exhausted for ${matchedOutcome.code}`);
              }
              logger.event("recovering", { stepId: step.id, action: matchedOutcome.recoveryAction, attempt: recoverAttempts });
              // `retry`/`reauth` re-run the step's own action afterward; the others
              // just settle the page and re-probe outcomes without re-acting, since
              // the control the step targeted may not exist on the recovered page
              // (e.g. a full-page transient-error screen has no "Search" button).
              switch (matchedOutcome.recoveryAction) {
                case "reauth":
                  await ensureAuthenticated(session.page, artifact.target.baseUrl, creds, logger);
                  await performAction(session.page, step, validatedParams, logger, runDir);
                  break;
                case "retry":
                default:
                  await performAction(session.page, step, validatedParams, logger, runDir);
                  break;
                case "wait":
                  await session.page.waitForTimeout(1500 * recoverAttempts);
                  break;
                case "dismiss":
                  await session.page.keyboard.press("Escape").catch(() => {});
                  break;
                case "reload":
                  // Reload the frame that actually holds this app's content, not the
                  // top-level page — for an iframe-embedded app, page.reload() would
                  // reset the iframe to its original src (losing e.g. the query
                  // string that reproduced the transient error) rather than
                  // resubmitting the same request.
                  await resolveFrame(session.page, step.target?.frame)
                    .locator("html")
                    .evaluate(() => window.location.reload())
                    .catch(() => {});
                  await session.page.waitForTimeout(300);
                  break;
              }
              continue outcomeLoop;
            }
          }
        }
      }

      logger.event("step_completed", { stepId: step.id });
    }

    // --- final checkpoint ---
    const checkpointOk = await matchOutcome(
      session.page,
      { urlPattern: artifact.checkpoint.urlPattern, textPattern: artifact.checkpoint.textPattern, locator: artifact.checkpoint.locator, frame: artifact.checkpoint.frame },
      3000
    );
    if (!checkpointOk) {
      throw new HardFailure("checkpoint_failed", artifact.checkpoint.description, `not satisfied at url=${session.page.url()}`);
    }

    logger.event("replay_succeeded", { outputs });
    updateSessionState(runDir, { status: "completed" });
    return finish("success", { outputs }, runId, artifact, startedAt, stepsExecuted, humanEscalations);
  } catch (err) {
    if (err instanceof BusinessOutcomeSignal) {
      logger.event("replay_business_outcome", { code: err.code, description: err.description });
      updateSessionState(runDir, { status: "completed" });
      return finish("business_outcome", { outcome: { code: err.code, description: err.description }, outputs }, runId, artifact, startedAt, stepsExecuted, humanEscalations);
    }
    const screenshotPath = logger.screenshotPath("failure");
    await session.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const failure =
      err instanceof HardFailure
        ? { kind: err.kind, expected: err.expected, observed: err.observed, evidence: { screenshot: screenshotPath, url: session.page.url() } }
        : err instanceof AllowlistViolation
        ? { kind: "guardrail_block" as FailureKind, expected: "action within allowlist", observed: err.message, evidence: { screenshot: screenshotPath, url: session.page.url() } }
        : err instanceof EscalationTimeoutError
        ? { kind: "escalation_timed_out" as FailureKind, expected: "a human operator to resume within the escalation timeout", observed: err.message, evidence: { screenshot: screenshotPath, url: session.page.url() } }
        : { kind: "unexpected_state" as FailureKind, expected: "no error", observed: err instanceof Error ? err.message : String(err), evidence: { screenshot: screenshotPath, url: session.page.url() } };
    logger.event("replay_failed", failure);
    updateSessionState(runDir, { status: "failed" });
    return finish("failure", { failure }, runId, artifact, startedAt, stepsExecuted, humanEscalations);
  } finally {
    logger.close();
    await closeSession(session);
  }
}

function finish(
  status: "success" | "business_outcome" | "failure",
  payload: Record<string, unknown>,
  runId: string,
  artifact: Artifact,
  startedAt: string,
  stepsExecuted: number,
  humanEscalations: number
): ReplayResult {
  const base = {
    runId,
    artifactId: artifact.artifactId,
    artifactName: artifact.name,
    artifactVersion: artifact.version,
    startedAt,
    finishedAt: new Date().toISOString(),
    stepsExecuted,
    humanEscalations,
  };
  return { ...base, status, ...payload } as ReplayResult;
}

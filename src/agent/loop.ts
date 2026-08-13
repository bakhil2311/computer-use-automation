import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import { launchSession, closeSession } from "./browserSession.js";
import { observe, act } from "./driver.js";
import { newTrace, saveTrace, type Trace, type TraceEntry, type TraceOutcome } from "./trace.js";
import { recordArtifact } from "./recorder.js";
import { RunLogger, newRunId } from "../logging/logger.js";
import { Allowlist, loadAllowlist, AllowlistViolation } from "../guardrails/allowlist.js";
import { evaluateRisk } from "../guardrails/risk.js";
import { escalate } from "../escalation/controlTransfer.js";
import { registerDialogHandler } from "./dialogPolicy.js";
import { initSessionState } from "../escalation/sessionState.js";
import type { Artifact, LocatorSpec, RiskLevel, ActionType } from "../types/artifact.js";

/**
 * Production discovery loop: an LLM (Anthropic Messages API, tool use)
 * drives the same observe/act primitives used everywhere else in this
 * codebase (agent/driver.ts, replay/locator.ts), deciding each step live
 * against the real page. This is the automated counterpart to the
 * `driver` CLI commands — same primitives, same trace format, same
 * recorder — the only thing that differs is *who* is making the
 * observe->decide->act decisions.
 *
 * Not exercised for this submission's evidence run (no external Anthropic
 * API key was available in the build sandbox — see README "LLM access"
 * for how the actual discovery evidence was produced instead), but it is
 * complete, type-checked, and ready to run against a live key.
 */

export interface DiscoveryLoopOptions {
  goal: string;
  target: { vendorProduct: string; appId: string; baseUrl: string; surface: "web" | "legacy-web" | "desktop" };
  model?: string;
  maxSteps?: number;
  allowlistPath?: string;
  approveIrreversible?: boolean; // if false, irreversible actions trigger escalation instead of executing
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "act",
    description:
      "Perform one UI action against the live page: navigate, click, type, select, keypress, waitFor, or extract text. " +
      "Always provide a prioritized fallback chain of locator strategies (role/label/text preferred over css/xpath; " +
      "coordinates only as a last resort) and a one-line rationale for why each strategy should be robust on replay.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["navigate", "click", "type", "select", "waitFor", "extract", "keypress"] },
        description: { type: "string", description: "What this step accomplishes, for a human reviewer." },
        rationale: { type: "string", description: "Why you chose this action/target now." },
        url: { type: "string", description: "Required for action=navigate." },
        target: {
          type: "object",
          description: "Required for all actions except navigate.",
          properties: {
            description: { type: "string" },
            frame: { type: "array", items: { type: "string" } },
            strategies: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["testId", "role", "label", "text", "css", "xpath", "coordinates"] },
                  priority: { type: "number" },
                  role: { type: "string" },
                  name: { type: "string" },
                  value: { type: "string" },
                  exact: { type: "boolean" },
                  x: { type: "number" },
                  y: { type: "number" },
                  rationale: { type: "string" },
                },
                required: ["kind", "priority", "rationale"],
              },
            },
          },
        },
        literalValue: {
          type: "string",
          description: "The concrete text to actually type/select/navigate-to right now (e.g. a real example member id).",
        },
        paramName: {
          type: "string",
          description:
            "If this value should vary per invocation (declared via declare_param), the param name to record instead of the literal — " +
            "e.g. paramName='memberId' while literalValue='10234' types 10234 now but records a placeholder replay substitutes later.",
        },
        extractAs: { type: "string", description: "Output name to store extracted text under, for action=extract." },
        risk: { type: "string", enum: ["safe", "sensitive", "irreversible"] },
        requiresConfirmation: { type: "boolean" },
        dialogPolicy: { type: "string", enum: ["accept", "dismiss", "none"] },
      },
      required: ["action", "description", "rationale", "risk"],
    },
  },
  {
    name: "record_outcome",
    description: "Attach a declared outcome branch (what this state on screen means) to the most recent act step.",
    input_schema: {
      type: "object",
      properties: {
        classification: { type: "string", enum: ["success", "business_outcome", "recoverable", "hard_failure"] },
        code: { type: "string" },
        description: { type: "string" },
        urlPattern: { type: "string" },
        textPattern: { type: "string" },
        recoveryAction: { type: "string", enum: ["dismiss", "retry", "wait", "reauth"] },
      },
      required: ["classification", "code", "description"],
    },
  },
  {
    name: "declare_param",
    description: "Declare a typed input parameter the capability will accept.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        type: { type: "string", enum: ["string", "number", "boolean", "enum"] },
        description: { type: "string" },
        sensitive: { type: "boolean" },
      },
      required: ["name", "type", "description"],
    },
  },
  {
    name: "declare_output",
    description: "Declare a typed output the capability returns to its caller.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        type: { type: "string", enum: ["string", "number", "boolean", "enum"] },
        description: { type: "string" },
        sensitive: { type: "boolean" },
      },
      required: ["name", "type", "description"],
    },
  },
  {
    name: "finish",
    description: "Declare the goal achieved and set the final checkpoint (success condition) that proves it.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string" },
        urlPattern: { type: "string" },
        textPattern: { type: "string" },
      },
      required: ["description"],
    },
  },
  {
    name: "give_up",
    description: "Declare that the goal cannot be safely completed (dead end / blocked / needs a human).",
    input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
  },
];

export async function runDiscoveryLoop(opts: DiscoveryLoopOptions): Promise<{ artifact: Artifact; runId: string }> {
  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
  const maxSteps = opts.maxSteps ?? 25;

  const runId = newRunId("discover-auto");
  const runDir = `evidence/${runId}`;
  const logger = new RunLogger(runId, runDir);
  const allowlist = new Allowlist(loadAllowlist(opts.allowlistPath));

  const session = await launchSession();
  registerDialogHandler(session.page, runDir, logger);
  initSessionState(runDir, runId, session.cdpUrl);
  allowlist.assertDomainAllowed(opts.target.baseUrl);
  await session.page.goto(opts.target.baseUrl, { waitUntil: "domcontentloaded" });

  const trace: Trace = newTrace(runId, opts.goal, opts.target, model);
  const messages: Anthropic.MessageParam[] = [];
  let finished = false;

  const systemPrompt = `You are a computer-use agent operating a legacy banking back-office web app on behalf of an AI platform.
Goal: ${opts.goal}
Target: ${opts.target.baseUrl} (${opts.target.vendorProduct})

Rules:
- Observe the screenshot and accessibility summary before every decision.
- Use the \`act\` tool for exactly one action at a time; prefer role/label/text locator strategies with a fallback chain, since this app has no test ids and uses legacy generated element ids.
- After an action whose result matters (search, submit, confirm), call \`record_outcome\` to classify what happened: success, business_outcome (e.g. "not found" is a legitimate answer, not an error), recoverable (dismiss/retry/wait/reauth), or hard_failure.
- Actions that mutate account/member state (e.g. opening a sub-account) are irreversible: set risk="irreversible", requiresConfirmation=true, and expect to be paused for human approval — do not assume you can push it through unattended.
- Declare typed \`declare_param\` inputs for any value that should vary per invocation (e.g. a member id) instead of hard-coding it — use literalValue like "{{memberId}}" in the act call once declared.
- Declare \`declare_output\` for any data the caller should get back.
- Call \`finish\` once you can point to a concrete on-screen checkpoint proving the goal was reached. Call \`give_up\` if you're stuck.`;

  messages.push({ role: "user", content: "Begin. Take your first observation and decide the first action." });

  for (let step = 0; step < maxSteps && !finished; step++) {
    const observation = await observe(session.page, logger, `step-${step}`);
    const imageBuffer = await session.page.screenshot({ type: "png" });
    messages.push({
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: imageBuffer.toString("base64") } },
        {
          type: "text",
          text: `url: ${observation.url}\ntitle: ${observation.title}\naccessibility tree (interesting nodes):\n${observation.axSummary}\n\nvisible text (truncated):\n${observation.textSnippet}`,
        },
      ],
    });

    const response = await anthropic.messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      messages.push({ role: "user", content: "Please call one of the provided tools." });
      continue;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const call of toolUses) {
      const result = await handleToolCall(call, { session, trace, logger, allowlist, opts, runDir });
      if (result.finished) finished = true;
      toolResults.push({ type: "tool_result", tool_use_id: call.id, content: result.message });
    }
    messages.push({ role: "user", content: toolResults });
  }

  logger.event("discovery_loop_ended", { finished, stepsUsed: messages.length });
  const artifact = recordArtifact(trace, {
    name: opts.goal.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 60),
    description: opts.goal,
  });
  logger.writeJson("artifact.json", artifact);
  logger.close();
  await closeSession(session);
  return { artifact, runId };
}

async function handleToolCall(
  call: Anthropic.ToolUseBlock,
  ctx: {
    session: Awaited<ReturnType<typeof launchSession>>;
    trace: Trace;
    logger: RunLogger;
    allowlist: Allowlist;
    opts: DiscoveryLoopOptions;
    runDir: string;
  }
): Promise<{ finished: boolean; message: string }> {
  const { session, trace, logger, allowlist, opts, runDir } = ctx;
  const input = call.input as any;

  try {
    switch (call.name) {
      case "act": {
        allowlist.assertActionAllowed(input.action as ActionType);
        const risk: RiskLevel = input.risk ?? "safe";
        const requiresConfirmation = !!input.requiresConfirmation || risk === "irreversible";

        if (requiresConfirmation) {
          const decision = evaluateRisk({ risk, requiresConfirmation, approved: opts.approveIrreversible });
          if (!decision.allowed) {
            await escalate(runDir, session.page, logger, `Model wants to perform an irreversible action: ${input.description}`, "IRREVERSIBLE_ACTION_DURING_DISCOVERY", {
              capability: opts.goal,
            });
          }
        }

        if (input.action === "navigate" && input.url) {
          allowlist.assertRouteAllowed(new URL(input.url, opts.target.baseUrl).pathname);
        }

        const target: LocatorSpec | undefined = input.target;
        const result = await act(
          session.page,
          {
            action: input.action,
            target,
            literalValue: input.literalValue,
            dialogPolicy: input.dialogPolicy ?? "none",
            runDir,
          },
          logger
        );

        const entry: TraceEntry = {
          id: `step-${trace.entries.length + 1}-${crypto.randomBytes(3).toString("hex")}`,
          action: input.action,
          description: input.description,
          rationale: input.rationale,
          target,
          value: input.paramName ? { paramRef: input.paramName } : input.literalValue !== undefined ? { literal: input.literalValue } : undefined,
          extractAs: input.extractAs,
          risk,
          requiresConfirmation,
          dialogPolicy: input.dialogPolicy ?? "none",
          observationBefore: { url: session.page.url() },
          outcomes: [],
        };
        trace.entries.push(entry);
        logger.event("act", { stepId: entry.id, action: input.action, ok: result.ok, error: result.error });

        return { finished: false, message: JSON.stringify({ ok: result.ok, error: result.error, extractedText: result.extractedText, url: session.page.url() }) };
      }
      case "record_outcome": {
        const last = trace.entries[trace.entries.length - 1];
        if (!last) return { finished: false, message: "no step to attach an outcome to" };
        const outcome: TraceOutcome = {
          classification: input.classification,
          code: input.code,
          description: input.description,
          match: { urlPattern: input.urlPattern, textPattern: input.textPattern },
          recoveryAction: input.recoveryAction,
        };
        last.outcomes.push(outcome);
        return { finished: false, message: "outcome recorded" };
      }
      case "declare_param":
        trace.params.push({ name: input.name, type: input.type, required: true, description: input.description, sensitive: !!input.sensitive });
        return { finished: false, message: "param declared" };
      case "declare_output":
        trace.outputs.push({ name: input.name, type: input.type, required: true, description: input.description, sensitive: !!input.sensitive });
        return { finished: false, message: "output declared" };
      case "finish":
        trace.checkpoint = { description: input.description, urlPattern: input.urlPattern, textPattern: input.textPattern };
        logger.event("finish_declared", { description: input.description });
        return { finished: true, message: "checkpoint recorded, ending discovery" };
      case "give_up":
        logger.event("give_up", { reason: input.reason });
        return { finished: true, message: "acknowledged" };
      default:
        return { finished: false, message: `unknown tool ${call.name}` };
    }
  } catch (err) {
    const msg = err instanceof AllowlistViolation ? `BLOCKED BY GUARDRAILS: ${err.message}` : err instanceof Error ? err.message : String(err);
    logger.event("tool_call_error", { tool: call.name, error: msg });
    return { finished: false, message: msg };
  }
}

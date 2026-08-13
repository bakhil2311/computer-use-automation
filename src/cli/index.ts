#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { launchSession, closeSession } from "../agent/browserSession.js";
import { observe, act } from "../agent/driver.js";
import { registerDialogHandler, writeDialogPolicy } from "../agent/dialogPolicy.js";
import { newTrace, loadTrace, saveTrace, type TraceEntry, type TraceOutcome } from "../agent/trace.js";
import { recordArtifact } from "../agent/recorder.js";
import { RunLogger, newRunId } from "../logging/logger.js";
import { writePointer, readPointer } from "./discoveryPointer.js";
import { replayArtifact } from "../replay/engine.js";
import { parseArtifact, type LocatorSpec, type ActionType, type RiskLevel } from "../types/artifact.js";
import { readSessionState, updateSessionState } from "../escalation/sessionState.js";
import { runDiscoveryLoop } from "../agent/loop.js";

const program = new Command();
program.name("cua").description("Computer-use automation: discover, record, replay, operate.");

// ---------------------------------------------------------------------------
// run: the fully-automated production discovery path (Anthropic API, no
// human in the decision loop). Requires ANTHROPIC_API_KEY. See README for
// why this submission's live evidence used `driver` instead.
// ---------------------------------------------------------------------------
program
  .command("run")
  .requiredOption("--goal <goal>")
  .requiredOption("--url <url>")
  .requiredOption("--vendor <vendorProduct>")
  .requiredOption("--app <appId>")
  .option("--surface <surface>", "web|legacy-web|desktop", "legacy-web")
  .option("--model <model>", "Anthropic model id", process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5")
  .option("--max-steps <n>", "25")
  .option("--name <name>", "capability name to save as (defaults to a slug of the goal)")
  .option("--description <description>", "capability description (defaults to the goal)")
  .action(async (opts) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("ANTHROPIC_API_KEY is not set. Set it, or use the `driver` subcommands for a manual discovery run (see README).");
      process.exit(1);
    }
    const { artifact, runId } = await runDiscoveryLoop({
      goal: opts.goal,
      target: { vendorProduct: opts.vendor, appId: opts.app, baseUrl: opts.url, surface: opts.surface },
      model: opts.model,
      maxSteps: Number(opts.maxSteps),
    });
    const name = opts.name ?? artifact.name;
    fs.mkdirSync("artifacts", { recursive: true });
    fs.writeFileSync(path.join("artifacts", `${name}.json`), JSON.stringify({ ...artifact, name }, null, 2));
    console.log(JSON.stringify({ runId, artifactPath: `artifacts/${name}.json`, artifactId: artifact.artifactId }, null, 2));
  });

function runDirFor(runId: string) {
  return path.join("evidence", runId);
}

function loggerFor(runId: string) {
  return new RunLogger(runId, runDirFor(runId));
}

// ---------------------------------------------------------------------------
// driver: manual/interactive discovery primitives, one CLI invocation per
// observe/decide/act cycle. Used for this submission's live discovery run
// (see REPORT.md section 1 for why: no external LLM API key in the build
// sandbox, so the reasoning step for that one real run was performed by
// the assistant directly, issuing exactly these commands). The exact same
// primitives (agent/driver.ts, replay/locator.ts) back the fully-automated
// Anthropic-loop path in agent/loop.ts.
// ---------------------------------------------------------------------------
const driver = program.command("driver").description("Manual discovery driver (observe/act/record), one command per step.");

driver
  .command("start")
  .requiredOption("--goal <goal>")
  .requiredOption("--url <url>")
  .requiredOption("--vendor <vendorProduct>")
  .requiredOption("--app <appId>")
  .option("--surface <surface>", "web|legacy-web|desktop", "legacy-web")
  .option("--model <model>", "identity of the reasoning agent for provenance", "claude-sonnet-5 (interactive, this session)")
  .action(async (opts) => {
    const runId = newRunId("discover");
    const runDir = runDirFor(runId);
    const logger = loggerFor(runId);
    const session = await launchSession();
    // This process owns the page for the run's whole lifetime, so it's the
    // one and only place a 'dialog' listener is registered — see
    // agent/dialogPolicy.ts.
    registerDialogHandler(session.page, runDir, logger);
    await session.page.goto(opts.url, { waitUntil: "domcontentloaded" });

    const trace = newTrace(runId, opts.goal, { vendorProduct: opts.vendor, appId: opts.app, baseUrl: opts.url, surface: opts.surface }, opts.model);
    const traceFile = path.join(runDir, "trace.json");
    saveTrace(traceFile, trace);
    writePointer({ runId, runDir, cdpUrl: session.cdpUrl, traceFile, pid: process.pid });

    logger.event("discovery_started", { goal: opts.goal, url: opts.url, vendor: opts.vendor, app: opts.app });

    console.log(JSON.stringify({ runId, cdpUrl: session.cdpUrl, runDir, pid: process.pid }, null, 2));
    // Stay alive: this process owns the actual Chromium child process (see
    // agent/browserSession.ts). Future CLI invocations (`driver act`,
    // `operator`, ...) are short-lived clients that attach over CDP; they
    // must not be the ones to close the browser. The caller backgrounds
    // this process and terminates it (SIGTERM) once done, which the
    // handler below turns into a clean browser shutdown.
    const shutdown = async () => {
      await closeSession(session).catch(() => {});
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    await new Promise(() => {});
  });

driver
  .command("observe")
  .requiredOption("--run <runId>")
  .option("--label <label>", "observe")
  .action(async (opts) => {
    const pointer = readPointer(opts.run);
    const logger = loggerFor(opts.run);
    const browser = await chromium.connectOverCDP(pointer.cdpUrl);
    const page = browser.contexts()[0].pages().slice(-1)[0];
    const o = await observe(page, logger, opts.label);
    logger.event("observation", { url: o.url, title: o.title, screenshot: o.screenshotPath, axSummary: o.axSummary.slice(0, 2000) });
    logger.close();
    await browser.close();
    console.log(JSON.stringify(o, null, 2));
  });

driver
  .command("act")
  .requiredOption("--run <runId>")
  .requiredOption("--action <action>")
  .requiredOption("--description <description>")
  .requiredOption("--rationale <rationale>")
  .option("--target-json <json>", "LocatorSpec JSON: {description, frame?, strategies:[{kind,priority,role?,name?,value?,exact?,rationale}]}")
  .option("--literal <value>")
  .option("--param-ref <name>")
  .option("--extract-as <name>")
  .option("--risk <risk>", "safe|sensitive|irreversible", "safe")
  .option("--requires-confirmation", "false")
  .option("--dialog-policy <policy>", "accept|dismiss|none", "none")
  .option("--timeout <ms>", "10000")
  .option("--no-record", "perform the action but do not append it as a replayable artifact step (e.g. one-time session setup)")
  .action(async (opts) => {
    const pointer = readPointer(opts.run);
    const logger = loggerFor(opts.run);
    const browser = await chromium.connectOverCDP(pointer.cdpUrl);
    const page = browser.contexts()[0].pages().slice(-1)[0];

    const before = await observe(page, logger, "before");
    const target: LocatorSpec | undefined = opts.targetJson ? JSON.parse(opts.targetJson) : undefined;
    // --param-ref takes precedence for what gets *recorded* (so replay substitutes a
    // caller-supplied value); --literal is still what's actually typed right now during
    // discovery — e.g. `--param-ref memberId --literal 10234` records {paramRef:"memberId"}
    // but types "10234" into the live page for this run.
    const value = opts.paramRef ? { paramRef: opts.paramRef } : opts.literal !== undefined ? { literal: opts.literal } : undefined;

    const result = await act(
      page,
      {
        action: opts.action as ActionType,
        target,
        value,
        literalValue: opts.literal,
        timeoutMs: Number(opts.timeout),
        dialogPolicy: opts.dialogPolicy,
        runDir: pointer.runDir,
      },
      logger
    );

    const after = await observe(page, logger, "after");

    if (!opts.record) {
      logger.event("act_unrecorded", { action: opts.action, description: opts.description, rationale: opts.rationale, ok: result.ok, error: result.error });
      logger.close();
      await browser.close();
      console.log(JSON.stringify({ recorded: false, ok: result.ok, error: result.error, extractedText: result.extractedText, urlAfter: after.url }, null, 2));
      return;
    }

    const trace = loadTrace(pointer.traceFile);
    const entry: TraceEntry = {
      id: `step-${trace.entries.length + 1}-${crypto.randomBytes(3).toString("hex")}`,
      action: opts.action as ActionType,
      description: opts.description,
      rationale: opts.rationale,
      target,
      value,
      extractAs: opts.extractAs,
      risk: opts.risk as RiskLevel,
      requiresConfirmation: !!opts.requiresConfirmation && opts.requiresConfirmation !== "false",
      dialogPolicy: opts.dialogPolicy,
      observationBefore: { url: before.url, screenshot: before.screenshotPath },
      observationAfter: { url: after.url, screenshot: after.screenshotPath },
      outcomes: [],
    };
    trace.entries.push(entry);
    saveTrace(pointer.traceFile, trace);

    logger.event("act", { stepId: entry.id, action: opts.action, description: opts.description, rationale: opts.rationale, ok: result.ok, error: result.error, strategyUsed: result.resolved?.strategy });
    logger.close();
    await browser.close();

    console.log(JSON.stringify({ stepId: entry.id, ok: result.ok, error: result.error, extractedText: result.extractedText, urlAfter: after.url, strategyUsed: result.resolved?.strategy }, null, 2));
  });

driver
  .command("outcome")
  .requiredOption("--run <runId>")
  .requiredOption("--classification <classification>")
  .requiredOption("--code <code>")
  .requiredOption("--description <description>")
  .option("--url-pattern <regex>")
  .option("--text-pattern <regex>")
  .option("--target-json <json>")
  .option("--recovery-action <action>")
  .option("--populates <names>", "comma-separated output names")
  .option("--frame <selectors>", "comma-separated iframe selector chain, outermost first")
  .action(async (opts) => {
    const pointer = readPointer(opts.run);
    const trace = loadTrace(pointer.traceFile);
    const last = trace.entries[trace.entries.length - 1];
    if (!last) throw new Error("No trace entries yet — run `driver act` first.");
    const outcome: TraceOutcome = {
      classification: opts.classification,
      code: opts.code,
      description: opts.description,
      match: {
        urlPattern: opts.urlPattern,
        textPattern: opts.textPattern,
        locator: opts.targetJson ? JSON.parse(opts.targetJson) : undefined,
        frame: opts.frame ? String(opts.frame).split(",") : undefined,
      },
      recoveryAction: opts.recoveryAction,
      populatesOutputs: opts.populates ? String(opts.populates).split(",") : undefined,
    };
    last.outcomes.push(outcome);
    saveTrace(pointer.traceFile, trace);
    console.log(JSON.stringify({ attachedTo: last.id, outcome }, null, 2));
  });

driver
  .command("param")
  .requiredOption("--run <runId>")
  .requiredOption("--name <name>")
  .requiredOption("--type <type>")
  .requiredOption("--description <description>")
  .option("--enum-values <values>")
  .option("--example <example>")
  .option("--sensitive", "false")
  .option("--optional", "false")
  .action(async (opts) => {
    const pointer = readPointer(opts.run);
    const trace = loadTrace(pointer.traceFile);
    trace.params.push({
      name: opts.name,
      type: opts.type,
      required: !(opts.optional && opts.optional !== "false"),
      description: opts.description,
      enumValues: opts.enumValues ? String(opts.enumValues).split(",") : undefined,
      example: opts.example,
      sensitive: !!opts.sensitive && opts.sensitive !== "false",
    });
    saveTrace(pointer.traceFile, trace);
    console.log(JSON.stringify(trace.params, null, 2));
  });

driver
  .command("output")
  .requiredOption("--run <runId>")
  .requiredOption("--name <name>")
  .requiredOption("--type <type>")
  .requiredOption("--description <description>")
  .option("--sensitive", "false")
  .action(async (opts) => {
    const pointer = readPointer(opts.run);
    const trace = loadTrace(pointer.traceFile);
    trace.outputs.push({
      name: opts.name,
      type: opts.type,
      required: true,
      description: opts.description,
      sensitive: !!opts.sensitive && opts.sensitive !== "false",
    });
    saveTrace(pointer.traceFile, trace);
    console.log(JSON.stringify(trace.outputs, null, 2));
  });

driver
  .command("checkpoint")
  .requiredOption("--run <runId>")
  .requiredOption("--description <description>")
  .option("--url-pattern <regex>")
  .option("--text-pattern <regex>")
  .option("--target-json <json>")
  .option("--frame <selectors>", "comma-separated iframe selector chain, outermost first")
  .action(async (opts) => {
    const pointer = readPointer(opts.run);
    const trace = loadTrace(pointer.traceFile);
    trace.checkpoint = {
      description: opts.description,
      urlPattern: opts.urlPattern,
      textPattern: opts.textPattern,
      locator: opts.targetJson ? JSON.parse(opts.targetJson) : undefined,
      frame: opts.frame ? String(opts.frame).split(",") : undefined,
    };
    saveTrace(pointer.traceFile, trace);
    console.log(JSON.stringify(trace.checkpoint, null, 2));
  });

driver
  .command("finish")
  .requiredOption("--run <runId>")
  .requiredOption("--name <name>")
  .requiredOption("--description <description>")
  .action(async (opts) => {
    const pointer = readPointer(opts.run);
    const trace = loadTrace(pointer.traceFile);
    const artifact = recordArtifact(trace, { name: opts.name, description: opts.description });
    fs.mkdirSync("artifacts", { recursive: true });
    fs.writeFileSync(path.join("artifacts", `${opts.name}.json`), JSON.stringify(artifact, null, 2));
    fs.writeFileSync(path.join(pointer.runDir, "artifact.json"), JSON.stringify(artifact, null, 2));
    fs.writeFileSync(path.join(pointer.runDir, "trace.json"), JSON.stringify(trace, null, 2));
    console.log(JSON.stringify({ artifactPath: `artifacts/${opts.name}.json`, artifactId: artifact.artifactId }, null, 2));
  });

driver
  .command("stop")
  .requiredOption("--run <runId>")
  .action(async (opts) => {
    const pointer = readPointer(opts.run);
    try {
      // Terminate the `driver start` process that owns the Chromium child
      // process; its SIGTERM handler closes the browser cleanly (see
      // `driver start` above — connecting over CDP and calling
      // browser.close() would only disconnect this client, not stop the
      // externally-launched browser process).
      process.kill(pointer.pid, "SIGTERM");
    } catch {
      /* already stopped */
    }
    console.log(JSON.stringify({ stopped: opts.run }));
  });

// ---------------------------------------------------------------------------
// replay: deterministic production execution path
// ---------------------------------------------------------------------------
program
  .command("replay")
  .requiredOption("--artifact <path>")
  .option("--params-json <json>", "{}")
  .option("--approve <stepIds>", "comma-separated step ids pre-approved for irreversible/confirmation actions")
  .action(async (opts) => {
    const raw = JSON.parse(fs.readFileSync(opts.artifact, "utf-8"));
    const artifact = parseArtifact(raw);
    const params = JSON.parse(opts.paramsJson ?? "{}");
    const approvedStepIds = opts.approve ? String(opts.approve).split(",") : [];
    const result = await replayArtifact(artifact, params, { approvedStepIds });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === "failure" ? 1 : 0);
  });

// ---------------------------------------------------------------------------
// operator: mock human-in-the-loop console. Connects to the SAME live
// session (via the shared cdpUrl recorded in session-state.json) that
// automation paused, performs the requested manual actions, logs them,
// and — with --resume — hands control back. See REPORT.md section 5.
// ---------------------------------------------------------------------------
program
  .command("operator")
  .requiredOption("--run <runId>")
  .option("--actions-json <json>", "array of {action,target?,literal?} to perform manually", "[]")
  .option("--note <note>", "operator's note on what they did")
  .option("--resume", "false")
  .action(async (opts) => {
    const runDir = runDirFor(opts.run);
    const state = readSessionState(runDir);
    const logger = loggerFor(opts.run);
    const browser = await chromium.connectOverCDP(state.cdpUrl);
    const page = browser.contexts()[0].pages().slice(-1)[0];

    console.log(`[operator] attached to live session ${opts.run}`);
    console.log(`[operator] escalation: ${JSON.stringify(state.escalation, null, 2)}`);

    const actions: { action: ActionType; target?: LocatorSpec; literal?: string; dialogPolicy?: "accept" | "dismiss" | "none" }[] = JSON.parse(opts.actionsJson);
    const humanActions = [...state.humanActions];

    for (const a of actions) {
      const result = await act(page, { action: a.action, target: a.target, literalValue: a.literal, dialogPolicy: a.dialogPolicy, runDir }, logger);
      const detail = { action: a.action, target: a.target?.description, literal: a.literal, ok: result.ok, error: result.error, urlAfter: page.url() };
      humanActions.push({ ts: new Date().toISOString(), action: a.action, detail });
      logger.event("human_action", detail);
      console.log(`[operator] ${a.action} -> ok=${result.ok} url=${page.url()}`);
    }

    updateSessionState(runDir, { owner: "human", status: "human_active", humanActions });

    if (opts.resume) {
      updateSessionState(runDir, {
        owner: "automation",
        status: "resumed",
        resumedAt: new Date().toISOString(),
        resumeNote: opts.note ?? "operator completed manual steps",
        humanActions,
      });
      logger.event("operator_resumed", { note: opts.note, humanActionCount: humanActions.length });
      console.log(`[operator] control handed back to automation.`);
    }

    logger.close();
    await browser.close();
  });

program.parseAsync(process.argv);

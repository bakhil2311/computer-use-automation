import crypto from "node:crypto";
import type { Artifact, Step, RiskLevel } from "../types/artifact.js";
import { SCHEMA_VERSION } from "../types/artifact.js";
import type { Trace } from "./trace.js";
import { loadAllowlist } from "../guardrails/allowlist.js";

/**
 * Compiles a raw discovery Trace into a versioned, replay-only Artifact.
 * This is the "record" half of record-once/replay-many: everything the
 * model reasoned about (rationale, false starts, raw transcript) is
 * dropped; everything replay actually needs (locator fallback chains,
 * typed params/outputs, declared outcome branches, the checkpoint) is
 * kept and normalized into the stable schema.
 */
export function recordArtifact(
  trace: Trace,
  opts: { name: string; description: string; allowlistPath?: string }
): Artifact {
  if (!trace.checkpoint) {
    throw new Error("Cannot finalize an artifact without a checkpoint (success condition) recorded.");
  }

  const steps: Step[] = trace.entries.map((e, i) => ({
    id: e.id,
    index: i,
    description: e.description,
    action: e.action,
    target: e.target,
    value: e.value,
    extractAs: e.extractAs,
    risk: e.risk,
    requiresConfirmation: e.requiresConfirmation,
    dialogPolicy: e.dialogPolicy,
    timeoutMs: 10_000,
    retry: { max: 2, backoffMs: 500 },
    outcomes: e.outcomes.map((o, j) => ({
      id: `${e.id}-outcome-${j}`,
      match: o.match,
      classification: o.classification,
      code: o.code,
      description: o.description,
      recoveryAction: o.recoveryAction,
      populatesOutputs: o.populatesOutputs,
    })),
  }));

  const overallRisk: RiskLevel = steps.some((s) => s.risk === "irreversible")
    ? "irreversible"
    : steps.some((s) => s.risk === "sensitive")
    ? "sensitive"
    : "safe";

  const allowlist = loadAllowlist(opts.allowlistPath);
  const now = new Date().toISOString();

  const artifact: Artifact = {
    artifactId: crypto.randomUUID(),
    schemaVersion: SCHEMA_VERSION,
    name: opts.name,
    version: 1,
    description: opts.description,
    createdAt: now,
    updatedAt: now,
    target: {
      vendorProduct: trace.target.vendorProduct,
      appId: trace.target.appId,
      baseUrl: trace.target.baseUrl,
      surface: trace.target.surface,
      environment: "sandbox",
    },
    allowlist: { domains: allowlist.domains, routes: allowlist.routes, actionTypes: allowlist.actionTypes },
    riskLevel: overallRisk,
    approvalState: "draft",
    params: trace.params,
    outputs: trace.outputs,
    checkpoint: trace.checkpoint,
    steps,
    provenance: {
      discoveryRunId: trace.discoveryRunId,
      recordedBy: "llm-discovery",
      model: trace.model,
    },
  };

  return artifact;
}

/** Bumps an existing artifact to a new version from a fresh trace, preserving identity. */
export function reRecordArtifact(previous: Artifact, trace: Trace): Artifact {
  const next = recordArtifact(trace, { name: previous.name, description: previous.description });
  next.artifactId = previous.artifactId;
  next.version = previous.version + 1;
  next.createdAt = previous.createdAt;
  next.approvalState = "draft"; // re-recording always resets to draft; must be re-approved
  return next;
}

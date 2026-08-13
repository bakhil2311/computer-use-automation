import fs from "node:fs";
import type { ActionType, FieldSpec, LocatorSpec, OutcomeClassification, RiskLevel, ValueSpec } from "../types/artifact.js";

/**
 * The raw discovery transcript — every observe/decide/act cycle, with the
 * model's (or, for this submission's live run, my own) rationale attached.
 * This is intentionally richer and messier than an Artifact: it's a
 * record of *how* the flow was discovered. recorder.ts compiles it down
 * into the clean, replay-only Artifact — see REPORT.md section 2 for why
 * we keep these as two separate representations instead of one.
 */
export interface TraceOutcome {
  classification: OutcomeClassification;
  code: string;
  description: string;
  match: { urlPattern?: string; textPattern?: string; locator?: LocatorSpec; frame?: string[] };
  recoveryAction?: "dismiss" | "retry" | "wait" | "reauth";
  populatesOutputs?: string[];
}

export interface TraceEntry {
  id: string;
  action: ActionType;
  description: string;
  rationale: string;
  target?: LocatorSpec;
  value?: ValueSpec;
  extractAs?: string;
  risk: RiskLevel;
  requiresConfirmation: boolean;
  dialogPolicy: "accept" | "dismiss" | "none";
  observationBefore: { url: string; screenshot?: string; note?: string };
  observationAfter?: { url: string; screenshot?: string; note?: string };
  outcomes: TraceOutcome[];
}

export interface Trace {
  discoveryRunId: string;
  goal: string;
  target: { vendorProduct: string; appId: string; baseUrl: string; surface: "web" | "legacy-web" | "desktop" };
  model: string;
  entries: TraceEntry[];
  params: FieldSpec[];
  outputs: FieldSpec[];
  checkpoint?: { description: string; urlPattern?: string; textPattern?: string; locator?: LocatorSpec; frame?: string[] };
}

export function newTrace(discoveryRunId: string, goal: string, target: Trace["target"], model: string): Trace {
  return { discoveryRunId, goal, target, model, entries: [], params: [], outputs: [] };
}

export function loadTrace(path: string): Trace {
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

export function saveTrace(path: string, trace: Trace): void {
  fs.writeFileSync(path, JSON.stringify(trace, null, 2));
}

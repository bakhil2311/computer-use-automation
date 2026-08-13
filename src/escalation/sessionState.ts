import fs from "node:fs";
import path from "node:path";

/**
 * The seam that makes human handoff real rather than notional: a small
 * JSON file, colocated with the run's evidence, that both the automation
 * process and a completely separate "operator" CLI process read/write.
 * It carries (a) how to attach to the *same* live browser (the Playwright
 * launchServer websocket endpoint) and (b) who currently owns the
 * session, so both sides always know whether they're allowed to act.
 */
export type SessionOwner = "automation" | "human";
export type SessionStatus = "running" | "awaiting_human" | "human_active" | "resumed" | "completed" | "failed";

export interface EscalationContext {
  reason: string;
  code: string;
  stepId?: string;
  stepIndex?: number;
  capability?: string;
  screenshot?: string;
  observedUrl?: string;
  requestedAt: string;
}

export interface HumanAction {
  ts: string;
  action: string;
  detail: Record<string, unknown>;
}

export interface SessionState {
  runId: string;
  cdpUrl: string;
  owner: SessionOwner;
  status: SessionStatus;
  escalation?: EscalationContext;
  humanActions: HumanAction[];
  resumedAt?: string;
  resumeNote?: string;
  updatedAt: string;
}

function statePath(runDir: string): string {
  return path.join(runDir, "session-state.json");
}

export function initSessionState(runDir: string, runId: string, cdpUrl: string): SessionState {
  const state: SessionState = {
    runId,
    cdpUrl,
    owner: "automation",
    status: "running",
    humanActions: [],
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(statePath(runDir), JSON.stringify(state, null, 2));
  return state;
}

export function readSessionState(runDir: string): SessionState {
  return JSON.parse(fs.readFileSync(statePath(runDir), "utf-8"));
}

export function writeSessionState(runDir: string, state: SessionState): void {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(statePath(runDir), JSON.stringify(state, null, 2));
}

export function updateSessionState(runDir: string, patch: Partial<SessionState>): SessionState {
  const cur = readSessionState(runDir);
  const next = { ...cur, ...patch };
  writeSessionState(runDir, next);
  return next;
}

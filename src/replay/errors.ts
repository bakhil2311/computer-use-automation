/**
 * The result contract replay returns to its caller (an AI agent, in
 * production). Three disjoint shapes on purpose — see REPORT.md section 3 —
 * so a caller can `switch` on `status` instead of parsing an exception
 * message to figure out whether "no such member" is a bug or an answer.
 */

export type FailureKind =
  | "guardrail_block" // allowlist / risk policy refused the action
  | "element_not_found" // locator fallback chain exhausted
  | "timeout" // waited for a state that never arrived
  | "unexpected_state" // page didn't match any declared outcome branch
  | "session_expired" // auth/session invalid and recovery didn't fix it
  | "escalation_timed_out" // paused for a human and nobody responded
  | "checkpoint_failed" // final success condition never became true
  | "invalid_params"; // caller-supplied input didn't match the artifact's declared param schema

export interface ReplayFailure {
  kind: FailureKind;
  stepId?: string;
  stepIndex?: number;
  expected: string;
  observed: string;
  evidence?: { screenshot?: string; url?: string; frameText?: string };
}

export interface ReplayBusinessOutcome {
  code: string;
  description: string;
  stepId?: string;
}

export interface ReplayResultBase {
  runId: string;
  artifactId: string;
  artifactName: string;
  artifactVersion: number;
  startedAt: string;
  finishedAt: string;
  stepsExecuted: number;
  humanEscalations: number;
}

export type ReplayResult =
  | (ReplayResultBase & { status: "success"; outputs: Record<string, unknown> })
  | (ReplayResultBase & { status: "business_outcome"; outcome: ReplayBusinessOutcome; outputs: Record<string, unknown> })
  | (ReplayResultBase & { status: "failure"; failure: ReplayFailure });
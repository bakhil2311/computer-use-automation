import type { RiskLevel } from "../types/artifact.js";

/**
 * Policy for how we handle each risk tier. `safe` actions (navigate, read,
 * click into a non-mutating page) proceed freely. `sensitive` actions
 * (reading/typing regulated data) proceed but are always logged with
 * redaction applied. `irreversible` actions (anything that mutates
 * institution/member state and can't be trivially undone — opening an
 * account, posting a transaction, closing a record) are handled
 * conservatively: they require an explicit, out-of-band approval before
 * they're allowed to execute, both during discovery and during replay.
 *
 * We chose "require explicit approval" over "always block" or "always
 * allow with a flag" because: blocking entirely would make the capability
 * useless (opening a sub-account *is* the goal in our demo flow), while
 * silently allowing irreversible actions in an unattended replay is the one
 * mistake this system cannot afford at a bank. Requiring approval pushes
 * the decision to whoever is invoking the capability (a human reviewer
 * approving the artifact for unattended use, or an operator confirming a
 * specific invocation) rather than letting automation decide for itself.
 */
export interface RiskDecision {
  allowed: boolean;
  reason: string;
}

export interface RiskContext {
  risk: RiskLevel;
  requiresConfirmation: boolean;
  /** Caller-supplied approval for this specific run/step (explicit opt-in). */
  approved?: boolean;
}

export function evaluateRisk(ctx: RiskContext): RiskDecision {
  if (ctx.risk !== "irreversible" && !ctx.requiresConfirmation) {
    return { allowed: true, reason: `risk=${ctx.risk}, no confirmation required` };
  }
  if (ctx.approved) {
    return { allowed: true, reason: "irreversible/confirmation-required step explicitly approved for this run" };
  }
  return {
    allowed: false,
    reason:
      "irreversible or confirmation-required step was not pre-approved; refusing to execute automatically. " +
      "Escalate to a human operator or re-invoke with explicit approval.",
  };
}

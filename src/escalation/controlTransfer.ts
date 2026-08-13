import type { Page } from "playwright";
import { readSessionState, updateSessionState, type EscalationContext, type SessionState } from "./sessionState.js";
import type { RunLogger } from "../logging/logger.js";

export class EscalationTimeoutError extends Error {
  constructor(runId: string, timeoutMs: number) {
    super(`No human operator resumed run ${runId} within ${timeoutMs}ms.`);
    this.name = "EscalationTimeoutError";
  }
}

/**
 * Pauses automation and raises an intervention request. Carries everything
 * an operator needs to act: which capability/step, why it stopped, a
 * screenshot, and the current URL. Blocks (polling the shared state file)
 * until an operator calls resume — this is deliberately synchronous from
 * the automation process's point of view: it does nothing else while
 * waiting, mirroring "cede control" rather than racing the human.
 */
export async function escalate(
  runDir: string,
  page: Page,
  logger: RunLogger,
  reason: string,
  code: string,
  extra: Partial<EscalationContext> = {},
  waitOpts: { pollMs?: number; timeoutMs?: number } = {}
): Promise<SessionState> {
  const screenshotPath = logger.screenshotPath("escalation");
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

  const ctx: EscalationContext = {
    reason,
    code,
    observedUrl: page.url(),
    screenshot: screenshotPath,
    requestedAt: new Date().toISOString(),
    ...extra,
  };

  logger.event("escalation_raised", { reason, code, url: page.url(), screenshot: screenshotPath, ...extra });
  updateSessionState(runDir, { status: "awaiting_human", escalation: ctx });

  return waitForResume(runDir, logger, waitOpts);
}

export async function waitForResume(
  runDir: string,
  logger: RunLogger,
  opts: { pollMs?: number; timeoutMs?: number } = {}
): Promise<SessionState> {
  const pollMs = opts.pollMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const state = readSessionState(runDir);
    if (state.status === "resumed") {
      logger.event("escalation_resumed", {
        resumedAt: state.resumedAt,
        resumeNote: state.resumeNote,
        humanActionCount: state.humanActions.length,
      });
      updateSessionState(runDir, { status: "running", owner: "automation" });
      return state;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  logger.event("escalation_timed_out", { timeoutMs });
  throw new EscalationTimeoutError(readSessionState(runDir).runId, timeoutMs);
}

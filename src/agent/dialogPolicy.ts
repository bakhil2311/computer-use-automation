import fs from "node:fs";
import path from "node:path";
import type { Page, Dialog } from "playwright";
import type { RunLogger } from "../logging/logger.js";

/**
 * Native browser dialogs (confirm/alert) are surfaced over CDP to *every*
 * attached client; a client with no listener auto-dismisses to avoid
 * hanging the page. In our multi-process model (the long-lived session
 * owns the page; short-lived CLI/operator commands attach as guests) two
 * competing `page.once('dialog', ...)` listeners on two different
 * connections race, and the loser gets "No dialog is showing". So exactly
 * one listener is ever registered — on the connection that owns the page
 * for the run's lifetime — and short-lived guest commands communicate
 * their desired policy through this small state file instead of trying to
 * handle the dialog themselves.
 */
type Policy = "accept" | "dismiss";

function policyPath(runDir: string): string {
  return path.join(runDir, "dialog-policy.json");
}

export function writeDialogPolicy(runDir: string, policy: Policy): void {
  fs.writeFileSync(policyPath(runDir), JSON.stringify({ policy }));
}

function readDialogPolicy(runDir: string): Policy {
  try {
    const raw = JSON.parse(fs.readFileSync(policyPath(runDir), "utf-8"));
    return raw.policy === "accept" ? "accept" : "dismiss";
  } catch {
    return "dismiss"; // safe default: never silently accept an unarmed dialog
  }
}

/** Call once per page, from whichever process actually owns/launched it. */
export function registerDialogHandler(page: Page, runDir: string, logger: RunLogger): void {
  page.on("dialog", async (dialog: Dialog) => {
    const policy = readDialogPolicy(runDir);
    logger.event("native_dialog", { message: dialog.message(), policy });
    if (policy === "accept") await dialog.accept().catch(() => {});
    else await dialog.dismiss().catch(() => {});
    writeDialogPolicy(runDir, "dismiss"); // consume: next dialog defaults safe unless re-armed
  });
}

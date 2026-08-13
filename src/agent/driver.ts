import type { Page } from "playwright";
import type { LocatorSpec, ValueSpec } from "../types/artifact.js";
import { resolveTarget, type ResolvedTarget } from "../replay/locator.js";
import type { RunLogger } from "../logging/logger.js";
import { writeDialogPolicy } from "./dialogPolicy.js";

/**
 * Thin "hands" primitives shared by the manual/CLI-driven discovery path
 * used for this submission's live run and by the fully-automated
 * Anthropic-loop path in agent/loop.ts (see REPORT.md section 1 for why
 * both exist). Neither the CLI nor loop.ts talks to Playwright directly —
 * everything funnels through here and through replay/locator.ts, so the
 * exact same targeting code that discovery uses to *find* an element is
 * what replay later uses to find it again.
 */

export interface Observation {
  url: string;
  title: string;
  screenshotPath: string;
  axSummary: string;
  textSnippet: string;
}

/** Accessibility tree (YAML-ish aria snapshot), depth-capped to keep it small. */
async function summarizeAxTree(page: Page, maxChars = 4000): Promise<string> {
  const snapshot = await page
    .locator("body")
    .ariaSnapshot({ depth: 6 })
    .catch(() => "");
  return snapshot.length > maxChars ? snapshot.slice(0, maxChars) + "\n...(truncated)" : snapshot;
}

export async function observe(page: Page, logger: RunLogger, label = "observe"): Promise<Observation> {
  const screenshotPath = logger.screenshotPath(label);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const [axSummary, textSnippet, title] = await Promise.all([
    summarizeAxTree(page),
    page
      .textContent("body")
      .then((t) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, 1500))
      .catch(() => ""),
    page.title().catch(() => ""),
  ]);
  return { url: page.url(), title, screenshotPath, axSummary, textSnippet };
}

export interface AdHocActionRequest {
  action: "navigate" | "click" | "type" | "select" | "waitFor" | "extract" | "keypress" | "assertCheckpoint";
  target?: LocatorSpec;
  value?: ValueSpec;
  literalValue?: string; // convenience for CLI: resolved value at discovery time
  timeoutMs?: number;
  dialogPolicy?: "accept" | "dismiss" | "none";
  /** Required to arm dialogPolicy — see agent/dialogPolicy.ts for why this is file-based
   *  rather than a per-call page.once('dialog', ...) listener. */
  runDir?: string;
}

export interface AdHocActionResult {
  ok: boolean;
  resolved?: ResolvedTarget;
  extractedText?: string;
  error?: string;
}

export async function act(page: Page, req: AdHocActionRequest, logger: RunLogger): Promise<AdHocActionResult> {
  const timeoutMs = req.timeoutMs ?? 10_000;
  try {
    if (req.dialogPolicy && req.dialogPolicy !== "none" && req.runDir) {
      writeDialogPolicy(req.runDir, req.dialogPolicy);
      // A Playwright client connection with *no* 'dialog' listener
      // auto-dismisses any dialog to avoid hanging the page. Since this
      // short-lived guest connection is the one whose click will trigger
      // the dialog, it would win that race against the persistent
      // listener (see agent/dialogPolicy.ts) unless it also has a
      // listener — even a no-op one — to suppress its own auto-dismiss.
      // The persistent listener still does the real accept()/dismiss().
      page.once("dialog", () => {});
    }

    if (req.action === "navigate") {
      const url = req.literalValue!;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      return { ok: true };
    }

    if (!req.target) return { ok: false, error: "no target provided" };
    const resolved = await resolveTarget(page, req.target, { probeTimeoutMs: timeoutMs });

    switch (req.action) {
      case "click":
        if (resolved.kind === "locator") await resolved.locator.click({ timeout: timeoutMs });
        else await page.mouse.click(resolved.x, resolved.y);
        break;
      case "type":
        if (resolved.kind === "locator") await resolved.locator.fill(req.literalValue ?? "", { timeout: timeoutMs });
        else {
          await page.mouse.click(resolved.x, resolved.y);
          await page.keyboard.type(req.literalValue ?? "");
        }
        break;
      case "select":
        if (resolved.kind === "locator") await resolved.locator.selectOption(req.literalValue ?? "", { timeout: timeoutMs });
        break;
      case "keypress":
        if (resolved.kind === "locator") await resolved.locator.press(req.literalValue ?? "Enter", { timeout: timeoutMs });
        else await page.keyboard.press(req.literalValue ?? "Enter");
        break;
      case "waitFor":
      case "assertCheckpoint":
        break; // resolveTarget having succeeded is the wait/assertion
      case "extract": {
        const text = resolved.kind === "locator" ? (await resolved.locator.textContent())?.trim() ?? "" : "";
        return { ok: true, resolved, extractedText: text };
      }
    }
    return { ok: true, resolved };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

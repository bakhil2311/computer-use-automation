import type { Page } from "playwright";
import type { LocatorSpec } from "../types/artifact.js";
import { resolveTarget, resolveFrame } from "./locator.js";

export interface MatchSpec {
  locator?: LocatorSpec;
  urlPattern?: string;
  textPattern?: string;
  /** Frame chain to scope urlPattern/textPattern to (most content here lives inside one iframe). */
  frame?: string[];
}

/** Checks whether a declared outcome/checkpoint matcher currently holds true. */
export async function matchOutcome(page: Page, matcher: MatchSpec, probeTimeoutMs = 1500): Promise<boolean> {
  const ctx = resolveFrame(page, matcher.frame);

  if (matcher.urlPattern) {
    try {
      const url =
        "url" in ctx
          ? ctx.url()
          : await ctx
              .locator("html")
              .evaluate(() => document.location.href)
              .catch(() => "");
      const re = new RegExp(matcher.urlPattern);
      if (re.test(url)) return true;
    } catch {
      /* fall through to other checks */
    }
  }
  if (matcher.textPattern) {
    const re = new RegExp(matcher.textPattern, "i");
    const deadline = Date.now() + probeTimeoutMs;
    while (Date.now() < deadline) {
      const body = await ctx
        .locator("body")
        .textContent({ timeout: Math.max(250, deadline - Date.now()) })
        .catch(() => null);
      if (body && re.test(body)) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (matcher.locator) {
    try {
      const locatorSpec = matcher.locator.frame ? matcher.locator : { ...matcher.locator, frame: matcher.frame };
      await resolveTarget(page, locatorSpec, { probeTimeoutMs });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

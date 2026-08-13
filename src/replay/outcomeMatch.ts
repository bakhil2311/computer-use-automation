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
      // Page has .url() directly; a FrameLocator doesn't, so read it off the
      // frame's own <html> element instead (works the same for either).
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
    try {
      const body = await ctx
        .locator("body")
        .textContent({ timeout: probeTimeoutMs })
        .catch(() => null);
      if (body) {
        const re = new RegExp(matcher.textPattern, "i");
        if (re.test(body)) return true;
      }
    } catch {
      /* ignore */
    }
  }
  if (matcher.locator) {
    try {
      // The outer `frame` is the source of truth for where this matcher
      // applies; fall back to a frame already set on the locator itself
      // (e.g. one authored standalone, outside an outcome/checkpoint).
      const locatorSpec = matcher.locator.frame ? matcher.locator : { ...matcher.locator, frame: matcher.frame };
      await resolveTarget(page, locatorSpec, { probeTimeoutMs });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

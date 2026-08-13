import type { FrameLocator, Locator, Page } from "playwright";
import type { LocatorSpec, LocatorStrategy } from "../types/artifact.js";

// Page and FrameLocator both expose locator()/getByRole()/getByText()/getByLabel()
// with matching signatures, so we can treat them interchangeably here.
export type LocatorContext = Page | FrameLocator;

export class LocatorResolutionError extends Error {
  constructor(
    public readonly spec: LocatorSpec,
    public readonly attempts: { strategy: LocatorStrategy; error: string }[]
  ) {
    super(
      `Could not resolve target "${spec.description}" — tried ${attempts.length} strategy(ies): ` +
        attempts.map((a) => `${a.strategy.kind}(${a.error})`).join("; ")
    );
    this.name = "LocatorResolutionError";
  }
}

export type ResolvedTarget =
  | { kind: "locator"; locator: Locator; strategy: LocatorStrategy }
  | { kind: "coordinates"; x: number; y: number; strategy: LocatorStrategy };

/** Descends a chain of iframe locators, outermost first. Exported so outcomeMatch.ts
 *  can scope text/url checks (e.g. "No records found") to the same frame the
 *  action targeted — most of this app's content lives inside one iframe, and
 *  Page.textContent()/Page.url() only ever see the top-level document. */
export function resolveFrame(root: Page, chain: string[] | undefined): LocatorContext {
  if (!chain || chain.length === 0) return root;
  let ctx: LocatorContext = root;
  for (const sel of chain) {
    ctx = ctx.frameLocator(sel);
  }
  return ctx;
}

function buildLocator(ctx: LocatorContext, s: LocatorStrategy): Locator {
  switch (s.kind) {
    case "testId":
      return ctx.locator(`[data-testid="${s.value}"], #${s.value}`);
    case "role":
      return ctx.getByRole(s.role as any, s.name ? { name: s.name, exact: s.exact ?? false } : undefined);
    case "label":
      return ctx.getByLabel(s.name ?? s.value ?? "", { exact: s.exact ?? false });
    case "text":
      return ctx.getByText(s.name ?? s.value ?? "", { exact: s.exact ?? false });
    case "css":
      return ctx.locator(s.value ?? "");
    case "xpath":
      return ctx.locator(`xpath=${s.value}`);
    case "coordinates":
      throw new Error("coordinates strategy has no locator");
  }
}

/**
 * Resolves a LocatorSpec's fallback chain against a live page, trying
 * strategies in priority order and returning the first that actually
 * resolves to a visible, attached element. This is the single seam both
 * the discovery recorder (to sanity-check what it just found) and the
 * replay engine (production path) go through — see REPORT.md section 3.
 */
export async function resolveTarget(
  page: Page,
  spec: LocatorSpec,
  opts: { probeTimeoutMs?: number } = {}
): Promise<ResolvedTarget> {
  const probeTimeoutMs = opts.probeTimeoutMs ?? 3000;
  const ctx = resolveFrame(page, spec.frame);
  const strategies = [...spec.strategies].sort((a, b) => a.priority - b.priority);
  const attempts: { strategy: LocatorStrategy; error: string }[] = [];

  for (const s of strategies) {
    if (s.kind === "coordinates") {
      if (typeof s.x === "number" && typeof s.y === "number") {
        return { kind: "coordinates", x: s.x, y: s.y, strategy: s };
      }
      attempts.push({ strategy: s, error: "missing x/y" });
      continue;
    }
    try {
      const locator = buildLocator(ctx, s);
      await locator.first().waitFor({ state: "visible", timeout: probeTimeoutMs });
      return { kind: "locator", locator: locator.first(), strategy: s };
    } catch (err) {
      attempts.push({ strategy: s, error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
    }
  }

  throw new LocatorResolutionError(spec, attempts);
}

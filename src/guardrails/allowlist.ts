import fs from "node:fs";
import path from "node:path";
import type { ActionType, RiskLevel } from "../types/artifact.js";

export interface AllowlistConfig {
  domains: string[];
  routes: string[]; // path patterns, `:param` segments are wildcards
  actionTypes: ActionType[];
  riskyRoutes: { method: string; routePattern: string; risk: RiskLevel }[];
  notes?: string;
}

export function loadAllowlist(configPath?: string): AllowlistConfig {
  const p = configPath ?? path.resolve(process.cwd(), "config/allowlist.json");
  const raw = fs.readFileSync(p, "utf-8");
  return JSON.parse(raw) as AllowlistConfig;
}

function routePatternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${escaped}/?$`);
}

export class AllowlistViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistViolation";
  }
}

/**
 * Enforced identically by the discovery agent loop and the replay engine —
 * a capability that was legal to record but is later pointed at a
 * disallowed domain/route/action must be blocked before it executes, not
 * just before it's saved.
 */
export class Allowlist {
  private domains: Set<string>;
  private routeRegexes: RegExp[];
  private actionTypes: Set<string>;
  private riskyRoutes: { method: string; regex: RegExp; risk: RiskLevel }[];

  constructor(private config: AllowlistConfig) {
    this.domains = new Set(config.domains);
    this.routeRegexes = config.routes.map(routePatternToRegex);
    this.actionTypes = new Set(config.actionTypes);
    this.riskyRoutes = config.riskyRoutes.map((r) => ({
      method: r.method,
      regex: routePatternToRegex(r.routePattern),
      risk: r.risk,
    }));
  }

  assertDomainAllowed(url: string): void {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new AllowlistViolation(`Cannot parse URL for allowlist check: ${url}`);
    }
    if (!this.domains.has(host)) {
      throw new AllowlistViolation(`Domain not in allowlist: ${host}`);
    }
  }

  assertRouteAllowed(pathname: string): void {
    const ok = this.routeRegexes.some((re) => re.test(pathname));
    if (!ok) {
      throw new AllowlistViolation(`Route not in allowlist: ${pathname}`);
    }
  }

  assertActionAllowed(action: ActionType): void {
    if (!this.actionTypes.has(action)) {
      throw new AllowlistViolation(`Action type not in allowlist: ${action}`);
    }
  }

  /** Best-effort risk classification used when a step doesn't already declare one. */
  classifyRoute(method: string, pathname: string): RiskLevel | undefined {
    const hit = this.riskyRoutes.find((r) => r.method === method && r.regex.test(pathname));
    return hit?.risk;
  }
}

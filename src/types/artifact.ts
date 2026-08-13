/**
 * Artifact schema — the reusable, agent-invocable "capability" produced by a
 * successful discovery run and consumed by the deterministic replay engine.
 *
 * Design goals (see /REPORT.md section 2 for the full rationale):
 *  - Decoupled from the raw LLM transcript: an artifact contains only what
 *    replay needs, not the model's reasoning/chat history.
 *  - Typed contract: params in, outputs out, so an AI agent can call this
 *    like a function without knowing anything about the underlying UI.
 *  - Locator robustness is explicit: every target is a *prioritized fallback
 *    chain* of strategies with a human-readable rationale, not a single
 *    selector string.
 *  - Every step declares its expected outcome branches up front, so replay
 *    can distinguish success / business outcome / recoverable / hard failure
 *    by construction instead of guessing after the fact.
 *  - Reusable across tenants: target/app identity is separated from the step
 *    list, and values are parameterized rather than baked in, so the same
 *    artifact body can be pointed at different tenants/environments.
 */
import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0" as const;

// ---------------------------------------------------------------------------
// Locators: a target is a prioritized fallback chain of strategies. Replay
// tries them in priority order and records which one actually worked, which
// is itself useful drift-detection signal (see REPORT.md section 4).
// ---------------------------------------------------------------------------

export const LocatorStrategyKind = z.enum([
  "testId", // data-testid / id attribute — best case, rarely present on legacy apps
  "role", // accessibility role + accessible name — most robust on legacy/non-semantic markup
  "label", // associated <label>/form label text
  "text", // visible text content
  "css", // CSS selector (incl. table row/col heuristics) — legacy fallback
  "xpath", // structural fallback for frameset/table-heavy markup
  "coordinates", // last-resort screenshot + x/y — for canvas/native/no-DOM surfaces
]);
export type LocatorStrategyKind = z.infer<typeof LocatorStrategyKind>;

export const LocatorStrategy = z.object({
  kind: LocatorStrategyKind,
  priority: z.number().int().min(0), // lower = tried first
  // exactly one of these is populated depending on `kind`
  role: z.string().optional(),
  name: z.string().optional(), // accessible name, or exact/contains text for `text`
  exact: z.boolean().optional(),
  value: z.string().optional(), // css/xpath/testId/label string
  x: z.number().optional(),
  y: z.number().optional(),
  screenshotRef: z.string().optional(), // evidence path the coordinates were derived from
  rationale: z
    .string()
    .describe("Why this strategy was chosen and how robust it's expected to be."),
});
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

export const LocatorSpec = z.object({
  description: z.string().describe("Human-readable name of the target control."),
  frame: z
    .array(z.string())
    .optional()
    .describe("Chain of iframe locators to descend into, outermost first."),
  strategies: z.array(LocatorStrategy).min(1),
});
export type LocatorSpec = z.infer<typeof LocatorSpec>;

// ---------------------------------------------------------------------------
// Typed params / outputs — the function signature an AI agent calls.
// ---------------------------------------------------------------------------

export const FieldType = z.enum(["string", "number", "boolean", "enum"]);

export const FieldSpec = z.object({
  name: z.string(),
  type: FieldType,
  required: z.boolean().default(true),
  description: z.string(),
  enumValues: z.array(z.string()).optional(),
  example: z.union([z.string(), z.number(), z.boolean()]).optional(),
  sensitive: z
    .boolean()
    .default(false)
    .describe("PII/regulated data — never persisted verbatim into logs/artifacts."),
});
export type FieldSpec = z.infer<typeof FieldSpec>;

// ---------------------------------------------------------------------------
// Outcome classification — declared per step, enforced during replay.
// This is the mechanism that separates expected business outcomes from
// recoverable conditions from hard failures (brief section 3.3).
// ---------------------------------------------------------------------------

export const OutcomeClassification = z.enum([
  "success", // this branch means "the step succeeded, continue"
  "business_outcome", // legitimate answer, not an error (e.g. "member not found")
  "recoverable", // known interstitial/transient state; engine acts and retries
  "hard_failure", // stop and surface a debuggable error
]);
export type OutcomeClassification = z.infer<typeof OutcomeClassification>;

export const OutcomeMatcher = z.object({
  // How to detect this branch is the one that occurred.
  locator: LocatorSpec.optional(),
  urlPattern: z.string().optional(),
  textPattern: z.string().optional(),
  frame: z.array(z.string()).optional().describe("Iframe chain to scope urlPattern/textPattern to."),
});

export const StepOutcome = z.object({
  id: z.string(),
  match: OutcomeMatcher,
  classification: OutcomeClassification,
  code: z.string().describe("Stable machine-readable code, e.g. MEMBER_NOT_FOUND."),
  description: z.string(),
  // For `recoverable`: what the engine should do before re-checking outcomes.
  // `retry`/`reauth` re-run the step's action afterward (the action itself may not
  // have registered, or the session needed re-establishing); `wait`/`dismiss`/`reload`
  // just settle the page and re-probe — re-clicking could hit a control that no
  // longer exists on the recovered page (e.g. a full-page transient-error screen).
  recoveryAction: z.enum(["dismiss", "retry", "wait", "reauth", "reload"]).optional(),
  // For `business_outcome`: which declared outputs (if any) this branch populates.
  populatesOutputs: z.array(z.string()).optional(),
});
export type StepOutcome = z.infer<typeof StepOutcome>;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const ActionType = z.enum([
  "navigate",
  "click",
  "type",
  "select",
  "waitFor",
  "extract",
  "keypress",
  "assertCheckpoint",
]);
export type ActionType = z.infer<typeof ActionType>;

export const RiskLevel = z.enum(["safe", "sensitive", "irreversible"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const ValueSpec = z.union([
  z.object({ literal: z.union([z.string(), z.number(), z.boolean()]) }),
  z.object({ paramRef: z.string() }), // resolved from the call's input params at replay time
]);
export type ValueSpec = z.infer<typeof ValueSpec>;

export const Step = z.object({
  id: z.string(),
  index: z.number().int().min(0),
  description: z.string().describe("Why this step exists, in plain language."),
  action: ActionType,
  target: LocatorSpec.optional(), // absent for e.g. pure `waitFor(timeout)`
  value: ValueSpec.optional(), // for `type`/`select`/`navigate`(url)
  extractAs: z.string().optional(), // output name this step's `extract` populates
  risk: RiskLevel.default("safe"),
  requiresConfirmation: z
    .boolean()
    .default(false)
    .describe("Irreversible steps default to true; replay will block unless pre-approved."),
  dialogPolicy: z
    .enum(["accept", "dismiss", "none"])
    .default("none")
    .describe("Native browser dialog (confirm/alert) handling to arm immediately before this action."),
  timeoutMs: z.number().int().default(10_000),
  retry: z
    .object({ max: z.number().int().default(2), backoffMs: z.number().int().default(500) })
    .default({ max: 2, backoffMs: 500 }),
  outcomes: z.array(StepOutcome).default([]),
});
export type Step = z.infer<typeof Step>;

// ---------------------------------------------------------------------------
// Checkpoint — the final success condition for the whole capability.
// ---------------------------------------------------------------------------

export const Checkpoint = z.object({
  description: z.string(),
  locator: LocatorSpec.optional(),
  urlPattern: z.string().optional(),
  textPattern: z.string().optional(),
  frame: z.array(z.string()).optional(),
});
export type Checkpoint = z.infer<typeof Checkpoint>;

// ---------------------------------------------------------------------------
// Target / provenance / allowlist snapshot
// ---------------------------------------------------------------------------

export const TargetApp = z.object({
  vendorProduct: z
    .string()
    .describe("Stable identity of the underlying app/product, independent of tenant."),
  appId: z.string(),
  tenantId: z.string().optional().describe("Absent on a base/tenant-agnostic artifact."),
  baseUrl: z.string(),
  surface: z.enum(["web", "legacy-web", "desktop"]).default("web"),
  environment: z.enum(["sandbox", "staging", "prod"]).default("sandbox"),
});
export type TargetApp = z.infer<typeof TargetApp>;

export const AllowlistSnapshot = z.object({
  domains: z.array(z.string()),
  routes: z.array(z.string()),
  actionTypes: z.array(ActionType),
});

export const Provenance = z.object({
  discoveryRunId: z.string(),
  recordedBy: z.enum(["llm-discovery", "human-edited"]),
  model: z.string().optional(),
  notes: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Top-level Artifact
// ---------------------------------------------------------------------------

export const Artifact = z.object({
  artifactId: z.string(),
  schemaVersion: z.literal(SCHEMA_VERSION),
  name: z
    .string()
    .describe("Stable machine name an agent invokes by, e.g. lookup_member_savings_balance."),
  version: z.number().int().min(1),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  target: TargetApp,
  allowlist: AllowlistSnapshot,
  riskLevel: RiskLevel,
  approvalState: z.enum(["draft", "approved"]).default("draft"),
  params: z.array(FieldSpec),
  outputs: z.array(FieldSpec),
  checkpoint: Checkpoint,
  steps: z.array(Step).min(1),
  provenance: Provenance,
});
export type Artifact = z.infer<typeof Artifact>;

export function parseArtifact(json: unknown): Artifact {
  return Artifact.parse(json);
}

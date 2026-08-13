# Design Report — Computer-Use Automation

## 1. Architecture

The system has four layers, each independently testable, connected by two data contracts (the
**Artifact** and the **ReplayResult**) rather than shared runtime state:

- **Discovery** (`agent/`): an observe → decide → act loop against a live Playwright session. The
  "decide" step is pluggable — `agent/loop.ts` calls the Anthropic Messages API with tool use
  (screenshot + accessibility snapshot in, one `act`/`record_outcome`/`declare_param`/... tool call
  out); the `driver` CLI subcommands expose the exact same primitives one call at a time so a human
  (or, for this submission, me) can drive discovery interactively. Both write to the same **Trace**
  format (`agent/trace.ts`).
- **Recording** (`agent/recorder.ts`): a pure function, `Trace → Artifact`. It throws away the raw
  transcript (model reasoning, false starts, screenshots) and keeps only what replay needs: steps,
  locator fallback chains, declared outcome branches, typed params/outputs, one checkpoint.
- **Replay** (`replay/`): loads an Artifact, validates caller params against its own declared schema,
  and executes steps with no model involved — `replay/engine.ts` is the production path.
- **Guardrails and escalation** (`guardrails/`, `escalation/`) are cross-cutting: the same
  `Allowlist`/`evaluateRisk` calls gate both the discovery loop and replay, and the same
  `escalate()`/session-state machinery is reachable from either.

**Key decisions and trade-offs:**

- **TypeScript + Playwright + Chromium**, single process per run, files (not a database) for
  artifacts/evidence. A bank integration layer will eventually need a real datastore and job queue for
  hundreds of tenants — but building that now would be exactly the "prematurely built scaling
  infrastructure" the brief warns against. The Artifact/ReplayResult contracts are the seam; swapping
  file storage for a database or a queue later doesn't touch discovery or replay logic.
- **DOM/accessibility-first, not pure vision.** Playwright's role/label/text locators and its aria
  snapshot are the primary perception and action surface, with CSS/XPath and raw coordinates as
  explicit fallback tiers. A screenshot is still taken at every observation (evidence, and what I
  looked at during discovery) and coordinate-click is a real, implemented fallback tier — but it's the
  last resort, not the default, because coordinates are the least durable locator against any layout
  change. This is a deliberate bet that most "legacy" enterprise apps still render real (if ugly) HTML
  a11y tree, which is the case described in the brief; a canvas-only or native-desktop surface would
  need to shift the default toward vision/OS-automation (see section 4).
- **CDP over `connectOverCDP`, not Playwright's own `launchServer`/`connect` pairing**, for anything
  that needs a second process to attach to a live session (the discovery CLI's multi-step commands,
  the operator handoff). This was a real finding, not a guess: I initially built this on
  `launchServer()`, and two independently-`connect()`ed Playwright clients turned out **not** to share
  browser contexts — each client only sees contexts *it* created. Raw CDP (`--remote-debugging-port` +
  `connectOverCDP`) does share the live target, which is also what a real remote-debugging/co-browsing
  console would use in production. `agent/browserSession.ts` has the details and a comment explaining
  why.

## 2. Artifact schema

`src/types/artifact.ts` (zod). An artifact is a versioned, named **capability** — the thing an AI
agent invokes, not a recording of what the model did. Shape, briefly:

- `target` (vendor product / app id / tenant id / base URL / surface) is **separate** from `steps`, so
  the same step list can be pointed at a different tenant or environment (see section 4).
- `params` / `outputs`: typed field specs (`string|number|boolean|enum`, `required`, `sensitive`)
  compiled at replay time into a live zod validator (`types/paramSchema.ts`) — caller input is
  validated against the artifact's own declared contract, not trusted blindly.
- `steps[]`: each has an `action`, a `target` (see below), a `value` (a literal *or* a `paramRef` —
  this is how "type the member id" becomes parameterized instead of hard-coded), a `risk` tier, and
  zero or more declared `outcomes`.
- `target: LocatorSpec` is a **prioritized fallback chain of strategies** (`role` → `label` → `text` →
  `css`/`xpath` → `coordinates`), each with a `rationale` string explaining why it should be durable.
  This is the schema's central bet: a single selector string is a coin flip on legacy markup; a ranked
  chain with recorded reasoning is both more robust *and* self-documenting for a human reviewer. Replay
  records which strategy actually resolved each run — free drift-detection signal (section 4).
- `outcomes[]` on a step is how the schema encodes "what does this branch on screen actually mean" —
  each has a `classification` (`success | business_outcome | recoverable | hard_failure`), a stable
  `code`, and a `match` (url/text pattern and/or locator, scoped to an iframe chain if needed). This is
  the single most load-bearing design choice in the schema: it turns "is this an error?" from a
  runtime judgment call into something declared once, at record time, by whoever (model or human)
  actually saw what each state meant.
- `checkpoint`: the capability's overall success condition, checked once at the end.
- `riskLevel` / `approvalState` / `provenance`: review metadata — is this safe to invoke unattended,
  has anyone approved it, what run and model produced it.

I chose one flat `steps[]` array with per-step branching (rather than, say, a full state graph) because
our flows are fundamentally linear with occasional early exits (a business outcome ends the run) —
that covers the brief's examples and this app's real branches without the complexity of a general
graph executor. The cut this implies is in section 7.

## 3. Determinism & error handling

Determinism comes from removing every judgment call from the hot path: locator resolution is a fixed,
ordered fallback chain (`replay/locator.ts`); branch meaning is looked up from `step.outcomes`, never
inferred; waits are explicit (`waitFor` steps, per-step `timeoutMs`, bounded `retry.max`).

The result contract (`replay/errors.ts`) is a discriminated union on purpose:

- `success` — outputs returned.
- `business_outcome` — a declared, legitimate answer (`MEMBER_NOT_FOUND`, `ACCESS_DENIED`,
  `INVALID_MEMBER_ID` in the demo artifact). The run stops immediately and cleanly; this is not an
  exception path.
- `failure` — a typed `FailureKind` (`element_not_found`, `checkpoint_failed`, `guardrail_block`,
  `session_expired`, `escalation_timed_out`, `invalid_params`, `unexpected_state`) plus `expected` vs
  `observed` and a screenshot — enough to debug without re-running.

`recoverable` outcomes are handled *before* they become failures: the engine performs a declared
`recoveryAction` (`retry` the same action, `wait`, `dismiss`, `reauth`, or `reload` the frame) and
re-probes the same outcome list, bounded by the step's `retry.max`. One real bug this surfaced during
testing: a naive "just re-click the same button" recovery breaks when the failure state is a
full-page error screen with no such button on it — `reload` re-issues the frame's last request instead
of re-acting blindly. That distinction (re-act vs. just re-settle-and-re-probe) is now explicit per
recovery action, not assumed.

`session_expired` is handled the same way: replay's own login step is separate from the artifact
(credentials are env vars, never embedded — section 6), so a `reauth` recovery action re-runs it and
retries the step that hit the stale session, without re-recording anything.

Secondary (drift) detection: because each step declares a *chain* of locator strategies, a replay run
that falls back from `role` to `css` is a running signal that the primary strategy is degrading — the
log records which strategy resolved on every step. This build logs it; a next step (section 7) would
be aggregating it across runs into a confidence score.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The seam is exactly `replay/locator.ts::resolveTarget` and
`agent/driver.ts`'s observe/act primitives: everything above that seam (Trace, Artifact, recorder,
replay engine, guardrails, escalation) only ever talks to `LocatorSpec`s and abstract
`navigate/click/type/select/waitFor/extract` actions — never to Playwright directly except inside
those two files. A legacy web app with framesets/nested tables is already exercised here (the demo
target: an iframe, no test ids, generated ASP.NET-style ids, native `confirm()` dialogs). Extending to
a **desktop app** means swapping the implementation behind that same seam: `LocatorStrategy.kind`
already includes `coordinates` for exactly this case, and a real port would add strategies backed by
OS accessibility APIs (Win32 UIA / macOS AX) plus an action layer using an OS-automation tool instead
of Playwright — the `Artifact`/`Step`/`Outcome` schema doesn't change at all, because it never assumed
a DOM.

**Multi-tenant reuse.** `target` is deliberately factored out of `steps`: `vendorProduct` identifies
the underlying app family independent of `tenantId`. The intended (not-yet-built, see section 7) model
is: record once against a **base** tenant, producing a tenant-agnostic artifact keyed by
`vendorProduct`; a second tenant running the same vendor product with cosmetic differences (branding,
a renamed field, a moved button) gets a thin **override** artifact — same `artifactId`, higher
`version`, a small patch to specific `LocatorSpec`s or `Step`s rather than a full re-recording. The
locator fallback chain already does a lot of this work implicitly (differently-branded but
structurally similar instances often still match on `role`+`name`); overrides are for when they don't.
**Drift detection** across tenants/versions is the same signal as section 3's — which strategy
resolved, and how often outcomes hit `unexpected_state` — aggregated per `(vendorProduct, version)`
rather than per single run. None of this required building multi-tenant infrastructure now; it required
not letting `target` leak into `steps`, which it doesn't.

## 5. Escalation & handoff

**Detecting "stuck."** Two triggers are implemented: (1) a step's risk policy blocks it
(`guardrails/risk.ts` — irreversible or `requiresConfirmation: true` and not pre-approved for this
call), and (2) — architecturally present via the same `escalate()` call, exercised in `loop.ts` — the
discovery model itself deciding it can't proceed. Both call the same function with the same context
shape: reason, code, which step/capability, current URL, a screenshot.

**Taking control of the live session, not a fresh one.** This is the one piece I want to call out as
genuinely validated, not just designed: automation launches Chromium with its CDP port open
(`agent/browserSession.ts`) and keeps running it in the same OS process for the whole run, including
while blocked in `escalate()`. The operator is a **separate process** (`cua operator`) that attaches
over `connectOverCDP` to that same port and acts on the same live page — proven by running the actual
demo (README step 4): the escalation screenshot shows two sub-accounts already created by earlier
manual and automated runs, and the operator's click after attaching produced a third, on the same
page, in the same browser tab. `evidence/session-state.json` is the shared state file both sides
read/write: `owner` (`automation`|`human`) and `status`
(`running`|`awaiting_human`|`human_active`|`resumed`|`completed`|`failed`) is the "who's in control"
answer, and `humanActions[]` logs exactly what the operator did, appended to the same run's evidence.

**Native dialogs across processes** turned out to be a real sub-problem worth naming: a Playwright
client connection with no `dialog` listener auto-dismisses to avoid hanging, so a short-lived guest
connection performing a click could silently dismiss a confirm() dialog the *other* connection meant to
accept. The fix (`agent/dialogPolicy.ts`) is one persistent listener on the connection that owns the
page for the run's lifetime, driven by a small policy file guest connections write before acting, with
a no-op listener on the guest side purely to suppress its own auto-dismiss. This is the kind of detail
that's invisible until you actually run two processes against one browser, which is why building the
real thing (not stubbing it) mattered here.

**Resuming.** After a human acts, replay does *not* blindly re-run the automated action — an
irreversible step may have just been performed manually. It re-checks the step's own declared
`success` outcome (or the capability's checkpoint) and only proceeds if that's now true, else fails
with `checkpoint_failed`, keeping "did this actually happen" empirical rather than assumed.

**What's mocked, deliberately:** the operator UI is a CLI (`cua operator --actions-json ...`), not a
visual co-browsing console, per the brief's explicit scope note. The control-transfer *mechanism* — CDP
attach, session-state file, dialog handoff — is real; only the human's input surface is a stand-in for
a GUI.

## 6. Safety

**Allowlist** (`config/allowlist.json`, `guardrails/allowlist.ts`): domains, route patterns (with
`:param` wildcards), and permitted action types, enforced identically by the discovery loop and the
replay engine — a capability legal to record can still be blocked from executing if pointed somewhere
disallowed later. Route classification (`riskyRoutes`) is the same file's job: which method+route pairs
are irreversible by policy, independent of what any individual artifact author declared.

**Risk tiers** (`guardrails/risk.ts`): `safe` runs freely; `sensitive` runs but is always logged
through redaction; `irreversible` (or any step explicitly flagged `requiresConfirmation`) is blocked
unless the specific step id was pre-approved for *this* invocation, or a human approves it live via
escalation. I chose "require explicit per-call approval" over "always block" (useless — opening the
sub-account is the point) or "silently allow with a config flag" (the one mistake a bank integration
can't afford). The `Artifact.approvalState` (`draft`/`approved`) field exists for the natural next step
— gating *unattended* replay on artifact-level review — but per-call `approvedStepIds` is what's
actually enforced in this build; see section 7.

**Never persisting secrets/PII into artifacts or logs.** Two layers: `FieldSpec.sensitive` marks
known-regulated params/outputs (e.g. `memberId`), and every write through `logging/logger.ts` runs the
data through `guardrails/redact.ts`, which both blanks explicitly-sensitive keys and pattern-scrubs
SSNs/card numbers/bearer tokens/emails/password-shaped strings anywhere in free text, as a backstop for
what wasn't anticipated. Credentials for replay's login step are environment variables, never written
into the artifact. This is defense in depth, not a guarantee — a determined enough leak (e.g. a
screenshot literally showing an account balance) is still evidence by design, since that's the point
of the screenshot; the redaction targets structured logs and the artifact body, which is where an
agent platform would actually persist and reuse things.

**Limits, honestly:** the allowlist is one flat file for one environment here; a real deployment needs
this per-tenant and centrally managed (noted in the config file itself). Screenshot evidence is not
scrubbed for on-screen PII — only structured log fields are. Risk classification is currently
per-step, author-declared; it isn't independently verified against, say, the HTTP method of what a
click actually triggers.

## 7. Cuts

**Cut, with a documented seam:**
- Multi-tenant storage/override mechanics and desktop/OS-automation backends are designed for
  (sections 1, 4) but not implemented — no second tenant, no second surface type.
- The operator console is a CLI, not a visual UI (brief's explicit scope note; section 5).
- Confidence scoring / approval-gated unattended replay: `approvalState` exists in the schema but
  isn't read by the replay engine yet — approval today is per-call (`--approve <stepId>`), not
  per-artifact.
- Multi-run stability scoring (replay N times, report flakiness) — not built; the per-run "which
  locator strategy resolved" signal is logged but not aggregated.
- Output-shape validation on replay success is best-effort (logged, not a hard gate) — a successful
  business outcome with an unexpected output shape doesn't currently downgrade to a failure.

**What I'd build next, in order:** (1) aggregate the per-run locator-strategy and outcome-match signal
across replays into the drift/confidence score section 4 and the stretch goals both point at — it's
the natural next consumer of data this build already logs; (2) artifact-level `approvalState` actually
gating unattended replay, not just per-call step approval; (3) a second recorded artifact against an
intentionally-varied version of the same target app, to prove out the tenant-override mechanics
described in section 4 rather than just designing for them; (4) a real (even minimal web) operator
surface in place of the CLI.

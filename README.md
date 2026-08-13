# Computer-Use Automation

A small but real computer-use system for the "legacy banking back-office app with no API" problem:
an LLM discovers a UI flow once, the run is compiled into a typed, versioned **artifact** (a reusable
capability), and that artifact is **replayed deterministically** — no model in the loop — with explicit
error handling, safety guardrails, and a real human-handoff mechanism for when automation can't safely
proceed alone.

See **[REPORT.md](./REPORT.md)** for the design write-up (architecture, artifact schema, determinism &
error handling, heterogeneity/multi-tenant story, escalation, safety, and cuts).

## What's in here

```
src/
  types/artifact.ts        the artifact schema (zod) — the capability contract
  agent/                   discovery: driver primitives, trace format, recorder, the Anthropic-loop
  replay/                  deterministic replay engine, locator resolution, error taxonomy
  guardrails/               allowlist, risk policy, redaction
  escalation/               human handoff: session state, control transfer
  logging/                  structured JSONL run logger (redacted)
  cli/                      the `cua` CLI (driver, run, replay, operator)
target-app/                 a local, intentionally "legacy" mock bank servicing app (the proxy target)
artifacts/                  saved capability artifacts (e.g. the one used for the demo below)
evidence/                   real discovery + replay run logs/screenshots (see below)
tests/                      unit tests + integration tests against the real target app
```

## Setup

Requires Node 20+. From the repo root:

```bash
npm install
```

Playwright's bundled Chromium is used to drive the target app. If your environment doesn't already have
a Chromium build Playwright can find, run `npx playwright install chromium` once (not needed if
`PLAYWRIGHT_BROWSERS_PATH`/the default cache already has one).

No database, no external services, and (for the replay/demo path below) **no API key** are required.

### Optional: live LLM-driven discovery

The fully-automated discovery loop (`npm run agent:run`, `src/agent/loop.ts`) calls the Anthropic
Messages API and needs:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**This submission's actual discovery evidence was not produced this way** — see "How the discovery
evidence was actually produced" below for why, and what was done instead. The automated loop is fully
implemented and type-checked; it just wasn't the path used to generate `/evidence/discover-*`.

## Demo path

**1. Start the target app** (a local mock legacy credit-union servicing console — table layouts, no
`data-testid`s, an iframe, native confirm dialogs, injected transient/validation/permission failures):

```bash
npm run target-app
# -> http://localhost:4178  (fake local-only login: operator1 / Passw0rd!)
```

**2. Replay the already-recorded capability** (`artifacts/lookup_member_and_open_subaccount.json`) —
this is the deterministic, no-model production path an AI agent would invoke:

```bash
npm run agent:replay -- \
  --artifact artifacts/lookup_member_and_open_subaccount.json \
  --params-json '{"memberId":"10234"}' \
  --approve step-5-988573
```

`--approve <stepId>` pre-approves the one irreversible step (opening a sub-account) for this
unattended invocation — see REPORT.md section 6 for why irreversible actions require this. Omit it and
the same command will instead **pause and wait for a human** (see the escalation demo below).

This prints a structured `ReplayResult` (`status: "success"`, with `outputs.savingsBalance` and
`outputs.subAccountNumber`) and writes a full run log + screenshots to `evidence/replay-<id>/`.

**3. Try a different member ID** — same artifact, no re-recording, no model involved:

```bash
npm run agent:replay -- \
  --artifact artifacts/lookup_member_and_open_subaccount.json \
  --params-json '{"memberId":"00000"}'
```

Member `00000` doesn't exist. The result is `status: "business_outcome"` (`MEMBER_NOT_FOUND`) — a
legitimate answer, not a crash — and the run stops *before* ever reaching the irreversible step, so no
approval is needed. Try `99999` (permission-denied) or `55555` (a transient error that the artifact
knows how to recover from — reload and retry) for the other declared branches.

**4. Escalation / human-in-the-loop demo** — run without `--approve` in the background, then act as the
operator from a second shell:

```bash
npm run agent:replay -- \
  --artifact artifacts/lookup_member_and_open_subaccount.json \
  --params-json '{"memberId":"10234"}' &

# it will pause at the irreversible step and print an escalation event with a runId; then:
RUN=<the printed runId>
npm run operator -- --run "$RUN" \
  --actions-json '[{"action":"click","target":{"description":"Open Sub-Account button","frame":["#ctl00_mainFrame"],"strategies":[{"kind":"role","priority":0,"role":"button","name":"Open Sub-Account","rationale":"operator approves after review"}]},"dialogPolicy":"accept"}]' \
  --note "Reviewed and approved." \
  --resume
```

The operator attaches to the **same live browser session** (over CDP, not a fresh one — see REPORT.md
section 5), performs the manual click, accepts the native confirm dialog, and hands control back; the
paused replay then verifies the outcome and finishes. `evidence/replay-<id>/session-state.json` shows
the control-transfer state machine; `log.jsonl` shows both the automation's and the operator's actions.

**5. Run the tests** (unit + integration against the real target app; requires step 1's server running):

```bash
npm test
```

## How the discovery evidence was actually produced

The brief requires at least one genuine LLM-driven discovery run with evidence, and says "a single
successful run is not an expensive thing to produce" given your own API access. This build sandbox
didn't have an `ANTHROPIC_API_KEY` available, and provisioning one was out of scope for the
environment I was working in. Rather than fake it, I used the fact that **I am an LLM** and drove
discovery directly: a `driver` CLI (`src/cli/index.ts`) exposes exactly the observe/decide/act
primitives the automated loop would use as tool calls (`driver observe`, `driver act`,
`driver outcome`, `driver param`, `driver output`, `driver checkpoint`, `driver finish`) — I issued
these one at a time against the live target app, looking at each screenshot/accessibility snapshot
before deciding the next action, exactly as `src/agent/loop.ts`'s tool-use loop would.

Everything downstream is identical either way: `agent/trace.ts` (the transcript format),
`agent/recorder.ts` (transcript → artifact), `replay/*` (deterministic execution), and the
guardrail/escalation/logging code are all shared, unexercised-by-conditionals code — swapping the
decision source for a live key is a one-line change (`src/agent/loop.ts` is complete and
type-checked; it's just not what generated `/evidence/discover-*`). This is disclosed here and in
REPORT.md rather than glossed over.

The full session transcript for the actual discovery run — every command issued, every screenshot
viewed, every design decision made in response to what was on screen — is real and preserved in
`evidence/discover-2026-08-13T17-44-38-995Z-ou723h/` (`trace.json`, `log.jsonl`, `screenshots/`).

If you do have an `ANTHROPIC_API_KEY`, the automated path is:

```bash
npm run agent:run -- \
  --goal "Look up a member by ID, read their savings balance, then open a new sub-account for them and reach the confirmation screen." \
  --url http://localhost:4178/login \
  --vendor cu-servicing-console \
  --app member-servicing
```

## Evidence layout

- `evidence/discover-2026-08-13T17-44-38-995Z-ou723h/` — the live discovery run: `trace.json` (raw
  transcript), `log.jsonl` (structured, redacted event log), `screenshots/`, and the resulting
  `artifact.json`.
- `evidence/replay-*-17-50-44-*-gpkf60/` — replay success (member `10235`, pre-approved irreversible step).
- `evidence/replay-*-17-50-52-*-1bnctm/` — replay business outcome (member `00000`, `MEMBER_NOT_FOUND`).
- `evidence/replay-*-17-52-46-*-eebtrr/` — replay recoverable path (member `55555`: transient error →
  reload → retry → success).
- `evidence/replay-*-17-52-57-*-gprlgz/` — replay escalation: paused for human approval, operator
  attached to the live session and resumed it, run completed.

## Config

- `config/allowlist.json` — the domains/routes/action types automation is permitted to touch, and
  which routes are classified irreversible. Loaded by both the discovery loop and the replay engine.
- Target app credentials for replay's login step: `TARGET_APP_USERNAME` / `TARGET_APP_PASSWORD` env
  vars, defaulting to the target app's fake local credentials (`operator1` / `Passw0rd!`). Never stored
  in the artifact itself.

## Known limitations of this build

See REPORT.md section 7 ("Cuts") for the full list and what's next; briefly: the operator "console" is
a CLI, not a UI (deliberately mocked per the brief's scope note); output-shape validation on replay is
best-effort rather than a hard gate; multi-tenant/desktop support is designed for but not built.

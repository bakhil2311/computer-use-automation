import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replayArtifact } from "../src/replay/engine.js";
import { parseArtifact } from "../src/types/artifact.js";

// These tests drive the real replay engine against the real mock target app
// (see README "Running tests") — no mocks, same code path as the CLI. They
// assume `npm run target-app` is already running on :4178. Evidence goes to
// a scratch dir, not /evidence/, so running the suite doesn't clutter the
// curated submission evidence with every test run.

const artifact = parseArtifact(
  JSON.parse(fs.readFileSync("artifacts/lookup_member_and_open_subaccount.json", "utf-8"))
);
const irreversibleStepId = artifact.steps.find((s) => s.risk === "irreversible")!.id;
const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cua-test-evidence-"));

beforeAll(async () => {
  const res = await fetch("http://localhost:4178/health").catch(() => null);
  if (!res || !res.ok) {
    throw new Error(
      "target-app is not running on http://localhost:4178 — start it first with `npm run target-app` (see README)."
    );
  }
  await fetch("http://localhost:4178/__test__/reset", { method: "POST" }).catch(() => {});
}, 10_000);

describe("replay engine (integration, real target app)", () => {
  it(
    "replays deterministically end-to-end and returns typed outputs for a found member",
    async () => {
      const result = await replayArtifact(artifact, { memberId: "10234" }, { approvedStepIds: [irreversibleStepId], evidenceRoot });
      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.outputs.savingsBalance).toMatch(/^\$[\d,.]+$/);
        expect(result.outputs.subAccountNumber).toMatch(/^SUB-10234-/);
      }
    },
    30_000
  );

  it(
    "reports 'member not found' as a business outcome, not a crash",
    async () => {
      const result = await replayArtifact(artifact, { memberId: "00000" }, { evidenceRoot });
      expect(result.status).toBe("business_outcome");
      if (result.status === "business_outcome") {
        expect(result.outcome.code).toBe("MEMBER_NOT_FOUND");
      }
    },
    30_000
  );

  it(
    "reports access-denied as a business outcome",
    async () => {
      const result = await replayArtifact(artifact, { memberId: "99999" }, { evidenceRoot });
      expect(result.status).toBe("business_outcome");
      if (result.status === "business_outcome") {
        expect(result.outcome.code).toBe("ACCESS_DENIED");
      }
    },
    30_000
  );

  it(
    "rejects params that don't match the artifact's declared contract",
    async () => {
      const result = await replayArtifact(artifact, {} as any, { evidenceRoot });
      expect(result.status).toBe("failure");
      if (result.status === "failure") {
        expect(result.failure.kind).toBe("invalid_params");
      }
    },
    15_000
  );

  it(
    "escalates instead of executing an unapproved irreversible step, and fails cleanly if nobody responds",
    async () => {
      const result = await replayArtifact(
        artifact,
        { memberId: "10235" },
        { escalationTimeoutMs: 2000, evidenceRoot } // no operator will respond in this test — expect a clean timeout failure
      );
      expect(result.status).toBe("failure");
      expect(result.humanEscalations).toBe(1);
      if (result.status === "failure") {
        expect(result.failure.kind).toBe("escalation_timed_out");
      }
    },
    20_000
  );
});

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseArtifact } from "../src/types/artifact.js";

describe("artifact schema", () => {
  it("validates the real recorded capability from the live discovery run", () => {
    const p = path.resolve("artifacts/lookup_member_and_open_subaccount.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    const artifact = parseArtifact(raw);
    expect(artifact.name).toBe("lookup_member_and_open_subaccount");
    expect(artifact.steps.length).toBeGreaterThan(0);
    expect(artifact.params.some((p) => p.name === "memberId")).toBe(true);
    expect(artifact.outputs.some((o) => o.name === "savingsBalance")).toBe(true);
    // the irreversible step must require confirmation — a schema-level guarantee,
    // not something replay has to remember to check on its own.
    const risky = artifact.steps.find((s) => s.risk === "irreversible");
    expect(risky?.requiresConfirmation).toBe(true);
  });

  it("rejects an artifact missing required fields", () => {
    expect(() => parseArtifact({ name: "incomplete" })).toThrow();
  });

  it("rejects a step with an invalid action type", () => {
    const base = JSON.parse(fs.readFileSync(path.resolve("artifacts/lookup_member_and_open_subaccount.json"), "utf-8"));
    base.steps[0].action = "teleport";
    expect(() => parseArtifact(base)).toThrow();
  });

  it("rejects a schemaVersion that doesn't match the current literal", () => {
    const base = JSON.parse(fs.readFileSync(path.resolve("artifacts/lookup_member_and_open_subaccount.json"), "utf-8"));
    base.schemaVersion = "99.0.0";
    expect(() => parseArtifact(base)).toThrow();
  });
});

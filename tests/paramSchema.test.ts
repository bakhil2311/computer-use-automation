import { describe, it, expect } from "vitest";
import { validateParams } from "../src/types/paramSchema.js";
import type { FieldSpec } from "../src/types/artifact.js";

const fields: FieldSpec[] = [
  { name: "memberId", type: "string", required: true, description: "id", sensitive: true },
  { name: "priority", type: "enum", required: false, description: "p", enumValues: ["low", "high"], sensitive: false },
];

describe("compiled field schema (artifact params/outputs contract)", () => {
  it("accepts valid input matching the declared contract", () => {
    expect(validateParams(fields, { memberId: "10234", priority: "high" })).toEqual({
      memberId: "10234",
      priority: "high",
    });
  });

  it("allows an optional field to be omitted", () => {
    expect(validateParams(fields, { memberId: "10234" })).toEqual({ memberId: "10234" });
  });

  it("rejects missing required fields", () => {
    expect(() => validateParams(fields, {})).toThrow();
  });

  it("rejects a value outside a declared enum", () => {
    expect(() => validateParams(fields, { memberId: "10234", priority: "urgent" })).toThrow();
  });

  it("rejects the wrong type entirely", () => {
    expect(() => validateParams(fields, { memberId: 10234 })).toThrow();
  });
});

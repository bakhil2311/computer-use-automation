import { describe, it, expect } from "vitest";
import { Allowlist, AllowlistViolation, loadAllowlist } from "../src/guardrails/allowlist.js";
import { evaluateRisk } from "../src/guardrails/risk.js";
import { redactText, redactObject, isSensitiveKey } from "../src/guardrails/redact.js";

describe("Allowlist", () => {
  const allowlist = new Allowlist({
    domains: ["localhost"],
    routes: ["/login", "/member/:id/detail"],
    actionTypes: ["navigate", "click"],
    riskyRoutes: [{ method: "POST", routePattern: "/member/:id/subaccount", risk: "irreversible" }],
  });

  it("allows a configured domain", () => {
    expect(() => allowlist.assertDomainAllowed("http://localhost:4178/login")).not.toThrow();
  });

  it("blocks a domain not in the allowlist", () => {
    expect(() => allowlist.assertDomainAllowed("http://evil.example.com/phish")).toThrow(AllowlistViolation);
  });

  it("allows a parameterized route", () => {
    expect(() => allowlist.assertRouteAllowed("/member/10234/detail")).not.toThrow();
  });

  it("blocks a route not in the allowlist", () => {
    expect(() => allowlist.assertRouteAllowed("/admin/delete-everything")).toThrow(AllowlistViolation);
  });

  it("blocks an action type not in the allowlist", () => {
    expect(() => allowlist.assertActionAllowed("type" as any)).toThrow(AllowlistViolation);
  });

  it("classifies a risky route by method+pattern", () => {
    expect(allowlist.classifyRoute("POST", "/member/10234/subaccount")).toBe("irreversible");
    expect(allowlist.classifyRoute("GET", "/member/10234/subaccount")).toBeUndefined();
  });

  it("loads the shipped config without throwing", () => {
    const cfg = loadAllowlist();
    expect(cfg.domains).toContain("localhost");
  });
});

describe("evaluateRisk", () => {
  it("allows a safe, non-confirmation step outright", () => {
    const d = evaluateRisk({ risk: "safe", requiresConfirmation: false });
    expect(d.allowed).toBe(true);
  });

  it("blocks an irreversible step with no approval", () => {
    const d = evaluateRisk({ risk: "irreversible", requiresConfirmation: true });
    expect(d.allowed).toBe(false);
  });

  it("allows an irreversible step that was explicitly approved", () => {
    const d = evaluateRisk({ risk: "irreversible", requiresConfirmation: true, approved: true });
    expect(d.allowed).toBe(true);
  });

  it("blocks a sensitive-but-not-irreversible step that still requires confirmation", () => {
    const d = evaluateRisk({ risk: "sensitive", requiresConfirmation: true, approved: false });
    expect(d.allowed).toBe(false);
  });
});

describe("redaction", () => {
  it("redacts an SSN-shaped string", () => {
    expect(redactText("SSN is 123-45-6789 on file")).toContain("[REDACTED:ssn]");
  });

  it("redacts a bearer token", () => {
    expect(redactText("Authorization: Bearer abc.def123")).toContain("[REDACTED:bearer_token]");
  });

  it("leaves ordinary text alone", () => {
    expect(redactText("Sub-account SUB-10234-1001 was opened successfully")).toBe(
      "Sub-account SUB-10234-1001 was opened successfully"
    );
  });

  it("flags obviously sensitive key names", () => {
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("authToken")).toBe(true);
    expect(isSensitiveKey("savingsBalance")).toBe(false);
  });

  it("deep-redacts sensitive keys and explicit field names in an object", () => {
    const out = redactObject({ password: "hunter2", memberId: "10234", note: "ok" }, ["memberId"]);
    expect(out.password).toBe("[REDACTED]");
    expect(out.memberId).toBe("[REDACTED]");
    expect(out.note).toBe("ok");
  });
});

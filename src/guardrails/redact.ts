/**
 * Redaction for anything that touches a log or artifact. This is a defense
 * in depth measure: field-level `sensitive` flags (see FieldSpec) are the
 * primary control, catching values we *know* are regulated; the pattern
 * scrubber below is a backstop for secrets/PII that show up in raw page
 * text, error messages, or free-typed values we didn't anticipate.
 */

const PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "card", regex: /\b(?:\d[ -]?){13,16}\b/g },
  { name: "bearer_token", regex: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi },
  { name: "email", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: "password_kv", regex: /\b(password|pwd|pass)\s*[:=]\s*\S+/gi },
];

export function redactText(input: string): string {
  let out = input;
  for (const { name, regex } of PATTERNS) {
    out = out.replace(regex, `[REDACTED:${name}]`);
  }
  return out;
}

const SENSITIVE_KEY_HINTS = ["password", "pwd", "secret", "token", "ssn", "creditcard", "cardnumber", "authorization"];

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_HINTS.some((hint) => k.includes(hint));
}

/**
 * Deep-redacts an object for logging: values under sensitive-looking keys
 * are fully masked; every remaining string value is passed through the
 * pattern scrubber. `explicitSensitiveKeys` lets callers pass field names
 * declared `sensitive: true` in an artifact's params/outputs schema.
 */
export function redactObject<T>(obj: T, explicitSensitiveKeys: string[] = []): T {
  const explicit = new Set(explicitSensitiveKeys.map((k) => k.toLowerCase()));

  function walk(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (isSensitiveKey(k) || explicit.has(k.toLowerCase())) {
          out[k] = "[REDACTED]";
        } else {
          out[k] = walk(v);
        }
      }
      return out;
    }
    return value;
  }

  return walk(obj) as T;
}

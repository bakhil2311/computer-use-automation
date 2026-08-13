import { z, ZodTypeAny } from "zod";
import type { FieldSpec } from "./artifact.js";

/**
 * Compiles an artifact's declared `params` (or `outputs`) field specs into a
 * live zod validator, so replay input args (and extracted outputs, as a
 * sanity check) are validated against the artifact's own declared contract
 * rather than trusted blindly.
 */
export function compileFieldSchema(fields: FieldSpec[]): ZodTypeAny {
  const shape: Record<string, ZodTypeAny> = {};
  for (const f of fields) {
    let s: ZodTypeAny;
    switch (f.type) {
      case "string":
        s = z.string();
        break;
      case "number":
        s = z.number();
        break;
      case "boolean":
        s = z.boolean();
        break;
      case "enum":
        s = f.enumValues && f.enumValues.length > 0 ? z.enum(f.enumValues as [string, ...string[]]) : z.string();
        break;
    }
    shape[f.name] = f.required ? s : s.optional();
  }
  return z.object(shape);
}

export function validateParams(fields: FieldSpec[], input: unknown) {
  return compileFieldSchema(fields).parse(input);
}

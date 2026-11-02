import { z } from "zod";
import { ActivityEvidenceSchema, ManualActivityIRSchema } from "./manualActivityIRSchema";

export const ACTIVITY_WIRE_VERSION = "manual_activity_extraction_v1";
// Lossless wire reduction, not an adapter from a different semantic contract.
// Only provenance, ordinal indices and kind-implied completion are computed.
const memo = new Map<z.ZodTypeAny, z.ZodTypeAny>();
function reduce(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema === ActivityEvidenceSchema) return z.string().min(1);
  const cached = memo.get(schema);
  if (cached) return cached;
  let result: z.ZodTypeAny = schema;
  if (schema instanceof z.ZodObject) {
    const shape: z.ZodRawShape = {};
    for (const [key, field] of Object.entries(schema.shape) as Array<[string, z.ZodTypeAny]>) {
      if (key === "sourceManifest" || key === "completion" || key === "order") continue;
      shape[key] = reduce(field);
    }
    result = z.object(shape).strict();
  } else if (schema instanceof z.ZodDiscriminatedUnion) {
    result = z.union(schema.options.map((s: z.ZodTypeAny) => reduce(s)) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  } else if (schema instanceof z.ZodNullable) result = reduce(schema.unwrap()).nullable().default(null);
  else if (schema instanceof z.ZodArray) {
    let array = z.array(reduce(schema.element));
    if (schema._def.minLength) array = array.min(schema._def.minLength.value);
    result = schema._def.minLength ? array : array.default([]);
  }
  memo.set(schema, result);
  return result;
}
const root = reduce(ManualActivityIRSchema) as z.AnyZodObject;
const policy = root.shape.policies as z.AnyZodObject;
export const ManualActivityExtractionSchema = root.extend({
  policies: policy.default({}),
  unresolvedIssues: z.array(z.object({
    kind: z.enum(["layout", "missing_asset", "scope", "ambiguous", "unsupported_condition"]),
    description: z.string().min(1), sourceEvidence: z.array(z.string().min(1)).min(1)
  }).strict()).default([])
}).strict();

// Compact typed grammar with shared definitions; the API uses json_object,
// while the exact same generated Zod contract validates the returned object.
export function activityExtractionGrammar() {
  const definitions: string[] = [], names = new Map<z.ZodTypeAny, string>();
  function type(s: z.ZodTypeAny): string {
    if (s instanceof z.ZodDefault) return `${type(s.removeDefault())} (omittable; default=${JSON.stringify(s._def.defaultValue())})`;
    if (s instanceof z.ZodNullable) return `${type(s.unwrap())}|null`;
    if (s instanceof z.ZodArray) return `Array<${type(s.element)}>${s._def.minLength ? `(min ${s._def.minLength.value})` : ""}`;
    if (s instanceof z.ZodLiteral) return JSON.stringify(s.value);
    if (s instanceof z.ZodEnum) return s.options.map((v: string) => JSON.stringify(v)).join("|");
    if (s instanceof z.ZodUnion) return s.options.map((v: z.ZodTypeAny) => type(v)).join(" | ");
    if (s instanceof z.ZodObject) {
      if (names.has(s)) return names.get(s)!;
      const name = `T${names.size}`; names.set(s, name);
      const fields = Object.entries(s.shape).map(([k, v]) => `${k}: ${type(v as z.ZodTypeAny)}`);
      definitions.push(`${name} = {${fields.join(", ")}}`); return name;
    }
    if (s instanceof z.ZodNumber) return "integer>=0 (where applicable positive)";
    if (s instanceof z.ZodBoolean) return "boolean";
    return "string";
  }
  const rootType = type(ManualActivityExtractionSchema);
  return { rootType, definitions, text: `Root=${rootType}\n${definitions.join("\n")}`,
    fieldOccurrences: definitions.reduce((n, d) => n + (d.match(/\w+: /g)?.length ?? 0), 0), typeDefinitions: definitions.length };
}

export function countContractFields(schema: z.ZodTypeAny) {
  const visited = new Set<z.ZodTypeAny>();
  let objects = 0, fields = 0;
  function visit(s: z.ZodTypeAny) {
    if (visited.has(s)) return;
    visited.add(s);
    if (s instanceof z.ZodObject) { objects++; fields += Object.keys(s.shape).length; Object.values(s.shape).forEach(v => visit(v as z.ZodTypeAny)); }
    else if (s instanceof z.ZodArray) visit(s.element);
    else if (s instanceof z.ZodUnion || s instanceof z.ZodDiscriminatedUnion) s.options.forEach((v: z.ZodTypeAny) => visit(v));
    else if (s instanceof z.ZodNullable || s instanceof z.ZodOptional) visit(s.unwrap());
    else if (s instanceof z.ZodDefault) visit(s.removeDefault());
    else if (s instanceof z.ZodEffects) visit(s.innerType());
  }
  visit(schema);
  return { uniqueObjectDefinitions: objects, fieldOccurrences: fields, countingMethod: "sum object properties; shared Zod objects counted once; union variants counted separately" };
}

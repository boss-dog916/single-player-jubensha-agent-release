import { z } from "zod";
import type { ManualActivityIR } from "@/src/lib/schemas/manualActivityIRSchema";

export function sourceContractComplexity(schema: z.ZodTypeAny, grammar: string) {
  const seen = new Set<z.ZodTypeAny>();
  let objects = 0, fields = 0, requiredFields = 0, nullable = 0, arrays = 0, arrayFields = 0, nullableFields = 0;
  function visit(s: z.ZodTypeAny) {
    if (seen.has(s)) return;
    seen.add(s);
    if (s instanceof z.ZodObject) {
      objects++;
      for (const v of Object.values(s.shape) as z.ZodTypeAny[]) {
        fields++; if (!v.isOptional()) requiredFields++;
        let inner = v;
        while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault || inner instanceof z.ZodNullable) {
          if (inner instanceof z.ZodNullable) nullableFields++;
          inner = inner instanceof z.ZodDefault ? inner.removeDefault() : inner.unwrap();
        }
        if (inner instanceof z.ZodArray) arrayFields++;
        visit(v);
      }
    } else if (s instanceof z.ZodArray) { arrays++; visit(s.element); }
    else if (s instanceof z.ZodNullable) { nullable++; visit(s.unwrap()); }
    else if (s instanceof z.ZodOptional) visit(s.unwrap());
    else if (s instanceof z.ZodDefault) visit(s.removeDefault());
    else if (s instanceof z.ZodEffects) visit(s.innerType());
    else if (s instanceof z.ZodUnion || s instanceof z.ZodDiscriminatedUnion) s.options.forEach((v: z.ZodTypeAny) => visit(v));
  }
  visit(schema);
  return { objectDefinitions: objects, fieldOccurrences: fields, grammarChars: grammar.length, requiredFields, nullable, arrays,
    nullableFieldOccurrences: nullableFields, arrayFieldOccurrences: arrayFields,
    countingMethod: "Unique reachable Zod nodes; sum object properties including each union variant; optional/default fields not required. Common item fields counted in all 15 variants, not factored away. arrays/nullable count distinct schema nodes; fieldOccurrences also count reused wrappers at each property." };
}

export function activityShapeCounts(ir: ManualActivityIR) {
  const kinds: Record<string, number> = {};
  for (const a of ir.phases.flatMap(p => p.activities)) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
  return { phases: ir.phases.length, activities: ir.phases.flatMap(p => p.activities).length, kinds,
    configDimensions: ir.configurations.length, options: ir.configurations.reduce((n, c) => n + c.options.length, 0),
    content: ir.content.length, points: ir.policies.requiredPoints.length, conditional: ir.policies.conditional.length,
    guidance: ir.policies.guidance.length, resources: ir.resources.length, assets: ir.externalAssets.length,
    identities: ir.identities.length, authorizations: ir.policies.authorizations.length };
}

// These are independently reviewed deficits, not waived by a structurally valid partial IR.
export const SOURCE_ROUND_TRIP_GAPS = {
  A: ["候场/演员人数/舞台配置的独立维度与兼容关系未完整组装", "三小说的单/双人投影、衔接插入和播放顺序未完整组装",
    "DM入场checkpoint、缺信息point_observed绑定、once/强度及2007重提例外未完整组装", "禁止提前揭露已内部保存，但不凭not-before自动增加第五幕公开授权"],
  B: ["PDF图形/栏位/颜色的cast与性别绑定仍未验证", "choice配额/已开集合/拒绝/授权/读档/点评/SOLO分派未完整组装",
    "第0幕全演绎及同页多个活动/媒体时点未完整定序", "identity truth/belief保留内部声明，未建立verified alias或完整release图"]
} as const;

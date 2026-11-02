import { z } from "zod";

export const SOURCE_SEMANTICS_VERSION = "manual_source_semantics_v1" as const;
const label = z.string().min(1).max(240);
const summary = z.string().min(1).max(600);
const hints = z.array(label).min(1);
const blocks = z.array(z.string().min(1)).min(1);
export const SourcePhaseHintSchema = z.object({
  sourceLabel: label, phaseTypeHint: z.enum(["prologue", "act", "ending", "unknown"]),
  actNumberHint: z.number().int().positive().nullable().describe("positive integer or null; prologue including 第0幕 uses null")
}).strict();
export const SourceSemanticPayloads = {
  phase_marker: SourcePhaseHintSchema.extend({ markerKind: z.enum(["enter", "reference", "chapter", "next_reading"]) }),
  reading_instruction: z.object({ modeHint: z.enum(["private_booklet", "public_archive"]), objectHint: label, subjectHints: hints.optional() }).strict(),
  discussion_instruction: z.object({ modeHint: z.enum(["free", "facilitated", "ordered"]), summary }).strict(),
  spoken_content: z.object({ speakerHint: label, personaHint: label.optional(), fidelityHint: z.enum(["fixed", "reference", "unresolved"]),
    intentHint: z.enum(["performance", "host_question", "host_explain"]).optional(), excerpt: z.string().min(1).max(120).optional(),
    boundaries: z.object({ start: z.string().min(1).max(80), end: z.string().min(1).max(80) }).strict().optional() }).strict(),
  stage_action: z.object({ performerHint: label, actionSummary: summary, targetHints: hints.optional(), capabilityHint: label.optional() }).strict(),
  media_cue: z.object({ label, operation: z.enum(["play", "stop", "change", "volume"]) }).strict(),
  configuration_option: z.object({ dimensionHint: label, optionLabel: label, selectionWhen: z.literal("setup"), appliesToSourceBlocks: blocks }).strict(),
  runtime_choice: z.object({ choiceWhen: z.literal("during_play"), chooserHints: hints, optionLabels: hints,
    quotaHint: z.number().int().positive().optional() }).strict(),
  resource_rule: z.object({ resourceLabel: label, ruleKindHint: z.enum(["catalogue", "eligibility", "no_repeat", "dispatch"]), summary,
    subjectHints: hints.optional(), notBeforeActHint: z.number().int().positive().optional() }).strict(),
  required_information: z.object({ subjectHints: hints, meaning: summary, importanceHint: z.enum(["hard", "soft", "optional"]),
    timingHint: z.object({ firstPhaseLabel: label, duePhaseLabel: label.optional() }).strict(), missingBehaviorHint: z.enum(["cue", "defer", "unknown"]) }).strict(),
  conditional_guidance: z.object({ conditionText: summary, effectKind: z.enum(["question", "acknowledge", "summarize", "private_support", "deny_resource"]),
    targetHints: hints.optional(), contentSummary: summary, strengthHint: z.enum(["hard", "soft", "optional"]), waitForAnswerHint: z.boolean().optional() }).strict(),
  guidance: z.object({ summary, guidanceKindHint: z.enum(["optional_guidance", "best_practice", "fallback_strategy", "style_hint"]) }).strict(),
  disclosure_rule: z.object({ protectedContentDescription: summary, notBeforeHint: label, audienceHint: z.enum(["dm_only", "selected_roles"]), targetHints: hints.optional() }).strict(),
  external_asset_reference: z.object({ label, assetTypeHint: z.enum(["audio", "video", "script", "archive", "other"]), requiredHint: z.boolean() }).strict(),
  identity_statement: z.object({ subjectText: label, relation: z.enum(["story_role", "performer", "persona", "canonical_truth", "belief", "identity_claim"]), objectText: summary,
    scopeHint: label.optional() }).strict()
} as const;
function item<K extends keyof typeof SourceSemanticPayloads>(kind: K) {
  return z.object({ localId: label, sourceBlockIds: blocks, semanticKind: z.literal(kind), payload: SourceSemanticPayloads[kind],
    phaseHint: SourcePhaseHintSchema.optional(), contextHint: label.optional() }).strict();
}
export const SourceSemanticItemSchema = z.discriminatedUnion("semanticKind", [
  item("phase_marker"), item("reading_instruction"), item("discussion_instruction"), item("spoken_content"), item("stage_action"),
  item("media_cue"), item("configuration_option"), item("runtime_choice"), item("resource_rule"), item("required_information"),
  item("conditional_guidance"), item("guidance"), item("disclosure_rule"), item("external_asset_reference"), item("identity_statement")
]);
export const ManualSourceSemanticsSchema = z.object({ items: z.array(SourceSemanticItemSchema),
  unresolved: z.array(z.object({ sourceBlockIds: blocks, description: summary }).strict()) }).strict();
export type SourceSemanticItem = z.infer<typeof SourceSemanticItemSchema>;
export type ManualSourceSemantics = z.infer<typeof ManualSourceSemanticsSchema>;
export type SourcePhaseHint = z.infer<typeof SourcePhaseHintSchema>;

// Inline semantic names; no opaque numbered type table and no IR/graph fields.
export function sourceSemanticGrammar() {
  function render(s: z.ZodTypeAny): string {
    if (s instanceof z.ZodOptional) return `${render(s.unwrap())}? (omit if unknown)`;
    if (s instanceof z.ZodNullable) return `${render(s.unwrap())}|null`;
    if (s instanceof z.ZodObject) return `{${Object.entries(s.shape).map(([k, v]) => `${k}:${render(v as z.ZodTypeAny)}`).join(",")}}`;
    if (s instanceof z.ZodArray) return `${render(s.element)}[]${s._def.minLength ? "+" : ""}`;
    if (s instanceof z.ZodEnum) return s.options.map((x: string) => JSON.stringify(x)).join("|");
    if (s instanceof z.ZodLiteral) return JSON.stringify(s.value);
    if (s instanceof z.ZodNumber) return s._def.checks.some(c => c.kind === "min" && c.value === 0 && !c.inclusive) ? "positive integer" : "number";
    if (s instanceof z.ZodBoolean) return "boolean";
    const max = s instanceof z.ZodString ? s._def.checks.find(c => c.kind === "max") : undefined;
    return `string${max && "value" in max ? `(1..${max.value} chars)` : ""}`;
  }
  return `Root={items:SemanticItem[],unresolved:{sourceBlockIds:string[]+,description:string(1..600 chars)}[]}\n` +
    `SemanticItem={localId:short string,sourceBlockIds:string[]+,semanticKind:one name below,payload:matching named payload,phaseHint?:${render(SourcePhaseHintSchema)},contextHint?:source section label (not an ID)}\n` +
    Object.entries(SourceSemanticPayloads).map(([name, payload]) => `${name}: ${render(payload)}`).join("\n");
}

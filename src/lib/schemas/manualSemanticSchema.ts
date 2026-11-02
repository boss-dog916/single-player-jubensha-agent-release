import { z } from "zod";

export const SourceEvidenceSchema = z.object({
  sourceDocumentId: z.string().min(1),
  sourceRevision: z.number().int().positive(),
  sourceSectionId: z.string().min(1),
  sectionSetRevision: z.number().int().positive(),
  sourceSpan: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
    .refine(span => span.end > span.start, "Invalid source span"),
  sourceQuote: z.string().trim().min(1),
  parserVersion: z.string().min(1),
  promptVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
  paragraphStart: z.number().int().nonnegative().optional(),
  paragraphEnd: z.number().int().nonnegative().optional(),
  paragraphIndexBasis: z.string().optional(),
  ooxmlParagraphStart: z.number().int().nonnegative().nullable().optional(),
  ooxmlParagraphEnd: z.number().int().nonnegative().nullable().optional()
}).strict();

export const ConversationPolicySchema = z.object({
  mode: z.enum(["ordered_share_then_discuss", "free_discussion_after_reading"]),
  source: z.enum(["manual", "product_policy"]),
  evidence: z.array(SourceEvidenceSchema).min(1)
}).strict();

export const ManualSemanticItemSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["reading", "ordered_sharing", "discussion", "transition", "spoken", "action", "unknown"]),
  order: z.number().int().nonnegative(),
  instruction: z.string(),
  evidence: SourceEvidenceSchema,
  nextActIndex: z.number().int().positive().nullable().optional(),
  windowId: z.string().min(1).optional(),
  variantGroup: z.string().min(1).optional(),
  branchId: z.string().min(1).optional(),
  capability: z.enum(["clue_release", "performance_action"]).optional()
}).strict();

export const ManualSemanticActSchema = z.object({
  contractVersion: z.literal(1),
  actIndex: z.number().int().positive(),
  logicalActId: z.string().min(1),
  fragment: z.enum(["complete", "continuation"]),
  conversationPolicy: ConversationPolicySchema,
  items: z.array(ManualSemanticItemSchema).min(1)
}).strict();

export type SourceEvidence = z.infer<typeof SourceEvidenceSchema>;
export type ConversationPolicy = z.infer<typeof ConversationPolicySchema>;
export type ManualSemanticAct = z.infer<typeof ManualSemanticActSchema>;

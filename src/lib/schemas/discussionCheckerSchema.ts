import { z } from "zod";

export const DiscussionCheckerSchema = z
  .object({
    passed: z.boolean(),
    decision: z.enum(["pass", "rewrite_required", "block"]),
    leakage: z
      .object({
        has_leakage: z.boolean(),
        items: z.array(z.string())
      })
      .strict(),
    boundary: z
      .object({
        violated: z.boolean(),
        items: z.array(z.string())
      })
      .strict(),
    intent_alignment: z
      .object({
        follows_brief_intent: z.boolean(),
        issues: z.array(z.string())
      })
      .strict(),
    role_consistency: z
      .object({
        is_consistent: z.boolean(),
        issues: z.array(z.string())
      })
      .strict(),
    quality: z
      .object({
        is_usable: z.boolean(),
        issues: z.array(z.string())
      })
      .strict(),
    rewrite_advice: z.string().nullable()
  })
  .strict();

export type DiscussionCheckerOutput = z.infer<typeof DiscussionCheckerSchema>;

export const CompactDiscussionCheckerSchema = z
  .object({
    checker_mode: z.literal("llm_checker"),
    passed: z.boolean(),
    decision: z.enum(["pass", "rewrite_required", "block"]),
    violations: z.array(z.string()).max(4),
    retry_hint: z.string().nullable(),
    findings: z.array(z.object({
      kind: z.enum(["secret", "contradiction", "unsupported_major_claim", "process"]),
      candidate_quote: z.string().min(1),
      source_id: z.string().min(1),
      source_quote: z.string(),
      explanation: z.string().min(1)
    }).strict()).max(4).optional().default([])
  })
  .strict();

export type CompactDiscussionCheckerOutput = z.infer<
  typeof CompactDiscussionCheckerSchema
>;

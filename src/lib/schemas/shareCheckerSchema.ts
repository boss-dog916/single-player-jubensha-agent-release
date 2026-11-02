import { z } from "zod";

export const ShareCheckerSchema = z
  .object({
    passed: z.boolean(),
    safe_to_publish: z.boolean(),
    reasons: z.array(z.string()),
    violations: z.array(z.string()),
    covered_must_share: z.boolean(),
    decision: z.enum(["pass", "rewrite_required", "block"]),
    rewrite_advice: z.string().nullable(),
    missing_must_share: z.array(z.string()),
    quality_issues: z.array(z.string()),
    leakage_issues: z.array(z.string())
  })
  .strict();

export type ShareCheckerOutput = z.infer<typeof ShareCheckerSchema>;

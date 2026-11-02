import { z } from "zod";

export const DmOutputCheckerSchema = z
  .object({
    passed: z.boolean(),
    decision: z.enum(["pass", "block"]),
    issues: z.array(z.string()),
    blocked_reason: z.string().nullable(),
    checked_items: z.array(z.string())
  })
  .strict();

export type DmOutputCheckerOutput = z.infer<typeof DmOutputCheckerSchema>;

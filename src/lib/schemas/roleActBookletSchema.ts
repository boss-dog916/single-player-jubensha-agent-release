import { z } from "zod";

export const RoleActBookletOutputSchema = z
  .object({
    roleName: z.string().trim().min(1),
    actIndex: z.number().int().positive(),
    privateText: z.string().trim().min(1),
    mustShare: z.array(z.string().trim()).default([]),
    mayShare: z.array(z.string().trim()).default([]),
    mustNotShare: z.array(z.string().trim()).default([]),
    emotionalPoints: z.array(z.string().trim()).default([]),
    relationshipPoints: z.array(z.string().trim()).default([]),
    timelineFragments: z.array(z.string().trim()).default([]),
    warnings: z.array(z.string().trim()).default([])
  })
  .strict();

export type RoleActBookletOutput = z.infer<typeof RoleActBookletOutputSchema>;

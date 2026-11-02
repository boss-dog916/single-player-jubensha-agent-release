import { z } from "zod";

const NonEmptyStringSchema = z.string().trim().min(1);
const ShareListSchema = z.array(NonEmptyStringSchema);
const DmFlowModeSchema = z.enum(["fixed", "guided", "fallback"]);
const DmFlowNodeSchema = z
  .object({
    id: NonEmptyStringSchema.optional(),
    mode: DmFlowModeSchema.optional(),
    content: z.string().trim().optional(),
    content_template: z.string().trim().optional(),
    guidance: z.string().trim().optional(),
    question_goal: z.string().trim().optional(),
    target: z.string().trim().optional(),
    target_role_id: z.string().trim().optional(),
    condition: z.string().trim().optional(),
    trigger: z.string().trim().optional(),
    bgm: z.string().trim().optional(),
    required_public_points: z.array(z.string().trim()).optional(),
    focus_points: z.array(z.string().trim()).optional(),
    emotion_prompts: z.array(z.string().trim()).optional(),
    forbidden_topics: z.array(z.string().trim()).optional(),
    if_missing_points: z.array(z.string().trim()).optional(),
    forbidden_reveals: z.array(z.string().trim()).optional(),
    summary_guidance: z.array(z.string().trim()).optional(),
    storyBoardEligible: z.boolean().optional()
  })
  .passthrough();
const DmFlowObjectSchema = z
  .object({
    opening: DmFlowNodeSchema.optional(),
    reading_instruction: DmFlowNodeSchema.optional(),
    share_intro: DmFlowNodeSchema.optional(),
    share_prompt: DmFlowNodeSchema.optional(),
    discussion_guidance: DmFlowNodeSchema.optional(),
    dm_questions: z.array(DmFlowNodeSchema).optional(),
    act_summary: DmFlowNodeSchema.optional(),
    performance_nodes: z.array(DmFlowNodeSchema).optional(),
    forbidden_reveals: z.array(z.string().trim()).optional()
  })
  .passthrough();
const DmFlowSchema = z.union([ShareListSchema, DmFlowObjectSchema]);

export const RoleSchema = z
  .object({
    role_id: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    personality: NonEmptyStringSchema
  })
  .strict();

export const BookletSchema = z
  .object({
    role_id: NonEmptyStringSchema,
    private_text: z.string().trim().min(300).max(800),
    must_share: ShareListSchema,
    may_share: ShareListSchema,
    must_not_share: z.array(z.string().trim())
  })
  .strict();

export const ActSchema = z
  .object({
    act_id: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    bgm: NonEmptyStringSchema,
    share_order: z.array(NonEmptyStringSchema).min(1),
    dm_flow: DmFlowSchema.optional().default([]),
    booklets: z.array(BookletSchema).min(1)
  })
  .strict();

export const ScriptSchema = z
  .object({
    script_id: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    summary: NonEmptyStringSchema,
    roles: z.array(RoleSchema).min(1),
    acts: z.array(ActSchema).min(1)
  })
  .strict()
  .superRefine((script, ctx) => {
    const roleIds = new Set<string>();

    script.roles.forEach((role, index) => {
      if (roleIds.has(role.role_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roles", index, "role_id"],
          message: `Duplicate role_id "${role.role_id}".`
        });
      }

      roleIds.add(role.role_id);
    });

    script.acts.forEach((act, actIndex) => {
      const bookletRoleIds = new Set<string>();

      act.share_order.forEach((roleId, orderIndex) => {
        if (!roleIds.has(roleId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["acts", actIndex, "share_order", orderIndex],
            message: `Unknown role_id "${roleId}" in share_order.`
          });
        }
      });

      act.booklets.forEach((booklet, bookletIndex) => {
        if (!roleIds.has(booklet.role_id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["acts", actIndex, "booklets", bookletIndex, "role_id"],
            message: `Unknown role_id "${booklet.role_id}" in booklet.`
          });
        }

        if (bookletRoleIds.has(booklet.role_id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["acts", actIndex, "booklets", bookletIndex, "role_id"],
            message: `Duplicate booklet for role_id "${booklet.role_id}".`
          });
        }

        bookletRoleIds.add(booklet.role_id);
      });

      script.roles.forEach((role) => {
        if (!bookletRoleIds.has(role.role_id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["acts", actIndex, "booklets"],
            message: `Missing booklet for role_id "${role.role_id}" in act "${act.act_id}".`
          });
        }
      });
    });
  });

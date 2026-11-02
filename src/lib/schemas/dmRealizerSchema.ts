import { z } from "zod";

export const DMNodeOutputModeSchema = z.enum([
  "fixed_line",
  "guided_speech",
  "instruction_only",
  "fallback_flow"
]);

export const DMDiscussionAnalysisSchema = z
  .object({
    publicSummary: z.array(z.string().trim().max(80)).max(5),
    mentionedPoints: z.array(
      z
        .object({
          point: z.string().trim().max(80),
          mentioned: z.boolean(),
          evidenceMessageIds: z.array(z.string().trim().max(80)).max(4),
          mentionedByRoleNames: z.array(z.string().trim().max(40)).max(4)
        })
        .strict()
    ).max(8),
    missingPoints: z.array(
      z
        .object({
          point: z.string().trim().max(80),
          expectedRoleNames: z.array(z.string().trim().max(40)).max(4),
          cueSafely: z.boolean(),
          cueHint: z.string().trim().max(120),
          risk: z.enum(["low", "medium", "high"])
        })
        .strict()
    ).max(5),
    speakerCoverage: z.array(
      z
        .object({
          roleName: z.string().trim().max(40),
          hasShared: z.boolean(),
          lastSpokeAt: z.string().trim().max(40).nullable(),
          likelyRelevantToCurrentNode: z.boolean()
        })
        .strict()
    ).max(8),
    openQuestions: z.array(z.string().trim().max(80)).max(5),
    contradictions: z.array(z.string().trim().max(80)).max(5),
    suggestedDmAction: z.enum([
      "summarize",
      "cue_missing_point",
      "ask_followup",
      "close_discussion",
      "advance_flow",
      "wait_for_user"
    ]),
    suggestedCueTargets: z.array(
      z
        .object({
          roleName: z.string().trim().max(40),
          reason: z.string().trim().max(100),
          safeCueText: z.string().trim().max(140)
        })
        .strict()
    ).max(3),
    safetyWarnings: z.array(z.string().trim().max(100)).max(5)
  })
  .strict();

export const DMRealizedSpeechSchema = z
  .object({
    text: z.string().trim().min(1).max(420),
    sourceMode: z.enum(["script_fixed", "script_guided", "system_fallback"]),
    shouldAdvanceAfterSpeaking: z.boolean(),
    shouldWaitForUser: z.boolean(),
    safetyWarnings: z.array(z.string().trim().max(100)).max(5)
  })
  .strict();

export type DMNodeOutputMode = z.infer<typeof DMNodeOutputModeSchema>;
export type DMDiscussionAnalysis = z.infer<typeof DMDiscussionAnalysisSchema>;
export type DMRealizedSpeech = z.infer<typeof DMRealizedSpeechSchema>;

import { z } from "zod";
import { SourceEvidenceSchema } from "./manualSemanticSchema";

// Author-reviewed RuntimeDefinition extensions; deliberately not Parser output.
const id = z.string().trim().min(1).max(128);
export const IndividualChoiceSchema = z.object({
  type: z.literal("individual").optional(),
  choiceId: id,
  prompt: z.string().trim().min(1).max(500),
  participants: z.enum(["all_players", "human", "targets"]),
  requiresReason: z.literal(true).optional(),
  endsGame: z.literal(true).optional(),
  options: z.array(z.object({ optionId: id, label: z.string().trim().min(1).max(100) }).strict()).min(2).max(20)
}).strict();
export const GroupMatchingChoiceSchema = z.object({
  type: z.literal("group_matching"), choiceId: id, prompt: z.string().trim().min(1).max(500),
  participants: z.literal("targets"),
  options: z.array(z.object({ optionId: id, label: z.string().trim().min(1).max(100) }).strict()).min(2).max(20),
  round: z.number().int().min(1).max(10), maxRounds: z.number().int().min(1).max(10),
  resultMode: z.enum(["immediate", "deferred"]).optional(),
  inviteRoleNames: z.array(id).max(2)
}).strict();
export const RuntimeChoiceSchema = z.union([IndividualChoiceSchema, GroupMatchingChoiceSchema]);
export const MatchingAssignmentSchema = z.object({ roleId: id, optionId: id }).strict();
export const SubmitGroupMatchingSchema = z.object({ choiceId: id, nodeId: id, actId: id, requestId: id,
  round: z.number().int().positive(), assignments: z.array(MatchingAssignmentSchema).min(2).max(20) }).strict();
export type GroupMatchingSubmission = z.infer<typeof SubmitGroupMatchingSchema>;
export type GroupMatchingReceipt = GroupMatchingSubmission & { definitionId: string; definitionVersion: number;
  submittedByRoleId: string; correctCount: number; submittedAt: string;
  resultStatus?: "pending" | "published"; publishedAt?: string; publicationNodeId?: string };
// Legacy receipts were immediately public. Pending scores never leave server state.
export type PublicGroupMatchingReceipt = Omit<GroupMatchingReceipt, "correctCount"> & { correctCount: number | undefined };
export function publicMatchingReceipt(r: GroupMatchingReceipt): PublicGroupMatchingReceipt {
  const { correctCount, ...rest } = r;
  return r.resultStatus === "pending" ? { ...rest, correctCount: undefined } : { ...rest, correctCount };
}
export const GroupMatchingRevealSchema = z.object({ choiceId: id, round: z.number().int().positive(), afterQuestionNodeId: id }).strict();
export type GroupMatchingView = { choiceId: string; nodeId: string; actId: string; round: number; maxRounds: number;
  prompt: string; roleIds: string[]; options: z.infer<typeof GroupMatchingChoiceSchema>["options"];
  history: PublicGroupMatchingReceipt[]; hint: string | null; canSubmit: boolean };
export const ChoiceRecapSchema = z.object({ choiceId: id, title: z.string().trim().min(1).max(200), round: z.number().int().positive().optional() }).strict();
export const ChoiceEqualsSchema = z.union([
  z.object({ choiceId: id, participant: z.literal("human"), optionId: id }).strict(),
  z.object({ choiceId: id, roleName: id, optionId: id, round: z.number().int().positive().optional() }).strict(),
  z.object({ choiceId: id, round: z.number().int().positive(), correctCount: z.number().int().min(0).max(20) }).strict()
]);
// A bounded, author-reviewed consumer of a completed all-player choice.
// Incomplete or failed submissions never select the otherwise text.
const endingText = z.object({ text: z.string().trim().min(1).max(20000), evidence: SourceEvidenceSchema }).strict();
export const ChoiceEndingSchema = z.object({ choiceId: id, unanimousOptionId: id,
  unanimous: endingText, otherwise: endingText }).strict();
export const SubmitRuntimeChoiceSchema = z.object({
  choiceId: id, nodeId: id, actId: id, optionId: id, requestId: id, reason: z.string().trim().min(1).max(2000).optional()
}).strict();
export type RuntimeChoiceSubmission = z.infer<typeof SubmitRuntimeChoiceSchema>;
export type RuntimeChoiceReceipt = RuntimeChoiceSubmission & {
  definitionId: string; definitionVersion: number; roleId: string; submittedAt: string;
};
export type RuntimeChoiceAttempt = {
  choiceId: string; roleId: string; attempts: number; token: string;
  status: "running" | "failed" | "completed"; lastError?: string;
};
export type RuntimeChoiceView = {
  choiceId: string; nodeId: string; actId: string; prompt: string;
  options: z.infer<typeof RuntimeChoiceSchema>["options"];
  ownOptionId: string | null; canSubmit: boolean; requiresReason?: boolean; endsGame?: boolean;
  participants: { roleId: string; completed: boolean; attempts: number; error?: string }[];
};

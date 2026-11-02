import type { DMFlowNode } from "@/src/lib/schemas/dmFlowSchema";
import type { DMFlowCursor, Message } from "@/src/lib/types/game";

// Exact source slices, including punctuation and whitespace. No model rewriting.
export function nextTextUnit(text: string, offset: number, maxChars = 280): string {
  if (text.length - offset <= maxChars) return text.slice(offset);
  const window = text.slice(offset, offset + maxChars);
  const boundaries = [...window.matchAll(/\n\s*\n|[。！？!?](?:[”」』"])?/g)];
  const boundary = boundaries.filter(m => m.index! + m[0].length >= 80).at(-1);
  let end = boundary ? offset + boundary.index! + boundary[0].length : offset + maxChars;
  if (/[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
  return text.slice(offset, end);
}

export function skippedResponsesSettleWait(expected: string[], pending: DMFlowCursor["pendingDMQuestion"], answers: Message[]) {
  return Boolean(expected.length && pending?.skippedRoleNames?.length && expected.every(role =>
    pending.skippedRoleNames!.includes(role) || answers.some(m => m.speaker_role_id === role)));
}

export function textConfirmationReady(cursor: DMFlowCursor, node: DMFlowNode | null, messages: Message[], actId: string): boolean {
  const gate = cursor.textPresentation, pending = cursor.pendingDMQuestion;
  if (!gate || gate.kind !== "continue" || !node?.textExecution?.wait || pending?.nodeId !== node.nodeId) return true;
  const expected = node.expectedSpeakerRoleNames.length ? node.expectedSpeakerRoleNames : pending.targetRoleNames;
  const answers = messages.filter(m => m.metadata.act_id === actId && ["user", "ai_player"].includes(m.speaker_type) &&
    ["free_discussion", "dm_question", "share_round"].includes(m.phase) && (m.created_at?.getTime() ?? 0) > Date.parse(pending.askedAt) &&
    (!expected.length || expected.includes(m.speaker_role_id ?? "")));
  return answers.length >= node.textExecution.wait.maxResponses || skippedResponsesSettleWait(expected, pending, answers) || Date.now() >= Date.parse(pending.askedAt) + node.textExecution.wait.maxWaitMs;
}

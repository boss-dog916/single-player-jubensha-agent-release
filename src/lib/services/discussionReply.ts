import type { Message } from "../types/game";
import type { AddressingResolution, PublicRole } from "../orchestration/addressingResolution";

export class ReplySelectionError extends Error { readonly status = 400; }
export type ReplySelection = { mode: "public" | "reply"; replyToMessageId?: string | null };
export type QueuedAddress = { targets: string[]; mode?: "public" | "reply"; replyToMessageId?: string | null };
// Extend the existing serialized pending-address envelope; legacy arrays remain
// readable. No Live schema migration or rewrite of queued/historical rows.
export function encodeQueuedAddress(value: QueuedAddress) {
  return JSON.stringify(value.mode ? { version: 1, ...value } : value.targets);
}
export function decodeQueuedAddress(json: string): QueuedAddress {
  const value = JSON.parse(json);
  if (Array.isArray(value)) return { targets: value };
  if (value?.version !== 1 || !Array.isArray(value.targets) || !["public", "reply"].includes(value.mode))
    throw new Error("Invalid pending reply address");
  return value;
}
export function explicitUserAddressing(message: Pick<Message, "speaker_type" | "metadata" | "target_role_ids" | "content">,
  roles: PublicRole[], base: AddressingResolution): AddressingResolution | null {
  // Public/reply is a thread/presentation choice. Public speech keeps the
  // established semantic addressee/group/relevance resolver unchanged.
  if (message.speaker_type !== "user" || message.metadata.discussionAddressingMode !== "reply") return null;
  const targets = message.target_role_ids ?? [];
  if (!targets.length) return null;
  return { ...base, addressingMode: targets.length ? "direct" : /[?？]|吗|呢|谁|什么|为啥|为什么/.test(message.content) ? "open" : "none",
    directTargets: targets, referencedRoles: base.referencedRoles.filter(id => roles.some(r => r.role_id === id)),
    excludedTargets: targets.includes("dm") ? roles.map(r => r.role_id) : [], needsPlanner: false, controlMessage: false,
    reason: targets.length ? "玩家明确回复所选消息的发言者" : "玩家公开发言，无指定回应对象" };
}
export function responseInQuestionThread(answer: Message, questionId: string, byId: Map<string, Message>) {
  let parent = answer.reply_to_message_id;
  const visited = new Set<string>();
  for (let depth = 0; parent && depth < 32 && !visited.has(parent); depth++) {
    if (parent === questionId) return true;
    visited.add(parent);
    const message = byId.get(parent);
    if (!message || message.metadata.act_id !== answer.metadata.act_id ||
      message.created_at && answer.created_at && message.created_at > answer.created_at) return false;
    parent = message.reply_to_message_id;
  }
  return false;
}

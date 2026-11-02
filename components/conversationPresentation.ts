import type { PlayerGameSnapshot as GameRuntimeSnapshot } from "@/src/lib/access/playerView";
import type { Message } from "@/src/lib/types/game";

export type PendingReply = { id: string; roleName: string; content: string };

export function conversationPresentation(
  conversation: { state: Pick<NonNullable<GameRuntimeSnapshot["conversation"]["state"]>, "status" | "stage" | "roleId" | "seedMessageId"> | null; pending: unknown[] } | null,
  roles: Array<{ role_id: string; name: string }>,
  messages: Message[],
  sendingCount: number,
  postShareActive: boolean,
  hasDiscussionResult: boolean
): { status: string; pendingReply: PendingReply | null } {
  const state = conversation?.state;
  const active = state && ["pending", "running"].includes(state.status);
  const roleName = roles.find((role) => role.role_id === state?.roleId)?.name ?? state?.roleId;
  const pendingReply = active && roleName && ["generating", "checking"].includes(state.stage) &&
    !messages.some((message) => message.speaker_type === "ai_player" &&
      message.speaker_role_id === state.roleId && message.reply_to_message_id === state.seedMessageId)
    ? { id: `reply:${state.seedMessageId}:${state.roleId}`, roleName,
      content: state.stage === "checking" ? `${roleName}的发言正在检查，完成后将显示。` : `${roleName}正在组织语言……` }
    : null;
  let status = "";
  if (sendingCount) status = "正在发送你的消息……";
  else if (conversation?.pending.length) status = "消息已收到，将在当前角色说完后插入。";
  else if (active) {
    if (state.stage === "checking") status = `正在检查${roleName ?? "AI"}的发言……`;
    else if (state.stage === "generating") status = `${roleName ?? "AI"}正在组织语言……`;
    else if (state.stage === "dm") status = "DM 正在处理后续引导……";
    else status = "消息已收到，正在判断哪些角色需要回应……";
  } else if (state?.status === "failed") status = "这次 AI 回应未完成，你可以继续发言。";
  else if (postShareActive) status = "正在处理分享后的讨论……";
  else if (hasDiscussionResult || messages.some(message => message.message_id === state?.seedMessageId &&
    message.speaker_type === "ai_player")) status = "本轮自动讨论已结束，你可以继续发言。";
  return { status, pendingReply };
}

export function chatMessageKey(message: Message) {
  return message.speaker_type === "ai_player" && message.reply_to_message_id
    ? `reply:${message.reply_to_message_id}:${message.speaker_role_id}` : message.message_id;
}

export function conversationPollInterval(active: boolean) { return active ? 1000 : 4000; }

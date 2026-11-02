import "server-only";
import { prisma } from "@/src/lib/db/prisma";
import { getScriptRuntimeDefinition } from "./scriptRuntimeDefinitionService";
import type { DMFlowCursor } from "@/src/lib/types/game";

// Only explicitly authored short windows suspend chat/baseline speech. The
// existing phase, structured choice and conversation fence remain authoritative.
export class RuntimeInputPolicyError extends Error { readonly status = 409; }
export async function runtimeInputPolicy(gameId: string) {
  const row = await prisma.gameSession.findUniqueOrThrow({ where: { id: gameId } });
  if (!row.runtimeDefinitionId) return null;
  const cursor = JSON.parse(row.dmFlowCursorJson ?? "null") as DMFlowCursor | null;
  const view = await getScriptRuntimeDefinition(row.runtimeDefinitionId);
  const flow = view.definition.dmFlow?.actFlows.find(f => `runtime_act_${f.actIndex}` === row.currentActId);
  const index = flow?.nodes.findIndex(n => n.nodeId === cursor?.nodeId) ?? -1;
  if (!flow || index < 0) return null;
  const node = flow.nodes[index];
  if (view.definition.acts.some(a => `runtime_act_${a.actIndex}` === row.currentActId && a.modelPolicy === "disabled"))
    return { policy: "choice_only" as const, targets: [] as string[], nodeId: node.nodeId };
  // Protect the gap between finishing reading and presenting the first choice.
  const upcoming = node.type === "reading_start" ? flow.nodes[index + 1] : node;
  if (upcoming?.inputPolicy) return { policy: upcoming.inputPolicy, targets: upcoming.expectedSpeakerRoleNames, nodeId: upcoming.nodeId };
  // Introductory fixed lines belong to the same pre-sharing window. Protect
  // gaps around them as well, without suspending later normal DM guidance.
  const beforeDiscussion = flow.nodes.slice(index + 1, flow.nodes.findIndex((n,i) => i > index && n.type === "free_discussion") < 0 ? undefined :
    flow.nodes.findIndex((n,i) => i > index && n.type === "free_discussion"));
  if (node.type !== "free_discussion" && beforeDiscussion.some(n => n.inputPolicy))
    return { policy: node.textExecution?.wait ? "directed_sharing" as const : "answer_only" as const,
      targets: node.textExecution?.wait ? node.expectedSpeakerRoleNames : [] as string[], nodeId: node.nodeId };
  return null;
}
export async function isRuntimeChoiceOnly(gameId: string) { return (await runtimeInputPolicy(gameId))?.policy === "choice_only"; }
export async function assertRuntimeChatAllowed(gameId: string, reply?: import("./discussionReply").ReplySelection) {
  const policy = await runtimeInputPolicy(gameId);
  if (policy?.policy === "choice_only") throw new RuntimeInputPolicyError("当前请先独立提交本节点选项，完成后再开始分享与讨论。");
  if (policy?.policy === "answer_only" || policy?.policy === "directed_sharing") {
    const row = await prisma.gameSession.findUniqueOrThrow({ where: { id: gameId } });
    const cursor = JSON.parse(row.dmFlowCursorJson ?? "null") as DMFlowCursor | null;
    if (reply?.mode === "reply") {
      const session = await (await import("./gameService")).getGameSession(gameId);
      const messages = await (await import("./messageService")).listMessages(gameId);
      if ((await import("./publicDiscussionContext")).currentDMInteraction(session, messages,
        { message_id: "new-user-followup", speaker_type: "user", reply_to_message_id: reply.replyToMessageId ?? null })) return;
    }
    if (!row.userRoleId || !policy.targets.includes(row.userRoleId) || cursor?.pendingDMQuestion?.nodeId !== policy.nodeId)
      throw new RuntimeInputPolicyError("当前为独立回答窗口，请等待DM询问自己；稍后开放自由分享。");
  }
}

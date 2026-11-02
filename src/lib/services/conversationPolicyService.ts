import "server-only";
import { prisma } from "@/src/lib/db/prisma";
import type { ScriptRuntimeDefinitionJson } from "@/src/lib/services/scriptRuntimeDefinitionService";
import type { ConversationPolicy } from "@/src/lib/schemas/manualSemanticSchema";

export async function getActConversationPolicy(gameId: string): Promise<ConversationPolicy | null> {
  const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: gameId }, select: { runtimeDefinitionId: true, currentActId: true } });
  if (!session.runtimeDefinitionId) return null;
  const definition = await prisma.scriptRuntimeDefinition.findUniqueOrThrow({ where: { id: session.runtimeDefinitionId }, select: { definitionJson: true } });
  const value = JSON.parse(definition.definitionJson) as ScriptRuntimeDefinitionJson;
  return value.acts.find(a => a.actIndex === Number(session.currentActId.replace("runtime_act_", "")))?.control?.conversationPolicy ?? null;
}

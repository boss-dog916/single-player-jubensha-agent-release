import "server-only";
import { prisma } from "@/src/lib/db/prisma";
import { fromJsonValue, toJsonInput } from "./jsonFields";
import { getRuntimeReadingSourcesForGameSession } from "./runtimeDefinitionSessionService";
import { assertDMTransactionFence } from "./conversationService";

export type ReadingReceipt = { definitionId: string; roleId: string; actId: string; sectionId: string; completedAt: string };
export class RuntimeReadingError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

export async function confirmHumanReading(gameId: string, input: { sectionId?: string; actId?: string } = {}) {
  const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: gameId } });
  if (!session.userRoleId) throw new RuntimeReadingError("请先选择角色。", 403);
  if (!session.runtimeDefinitionId) return false; // Existing text-only demo path.
  if (input.actId && input.actId !== session.currentActId) throw new RuntimeReadingError("读本幕次已变化，请刷新。");
  const actIndex = Number(session.currentActId.match(/^runtime_act_(\d+)$/)?.[1]);
  const sources = await getRuntimeReadingSourcesForGameSession({ gameSessionId: gameId, roleName: session.userRoleId, actIndex });
  const displays = sources?.displays ?? [];
  if (!displays.length) throw new RuntimeReadingError("当前尚无合法读本，不能确认阅读。");
  if (displays.length > 1 && (!input.sectionId || !input.actId)) throw new RuntimeReadingError("请逐份确认当前读本。", 400);
  const section = displays.find(s => s.sourceDocumentSectionId === (input.sectionId ?? displays[0].sourceDocumentSectionId));
  if (!section) throw new RuntimeReadingError("不能确认未授权或其他角色的读本。", 403);
  const receipts = fromJsonValue<ReadingReceipt[]>(session.readingReceiptsJson, []);
  const own = receipts.filter(r => r.definitionId === session.runtimeDefinitionId && r.roleId === session.userRoleId && r.actId === session.currentActId);
  if (own.some(r => r.sectionId === section.sourceDocumentSectionId)) return true;
  if (!["reading", "ai_internal_reading"].includes(session.currentPhase)) throw new RuntimeReadingError("当前不是读本阶段。");
  const index = displays.indexOf(section);
  if (displays.slice(0, index).some(s => s.required !== false && !own.some(r => r.sectionId === s.sourceDocumentSectionId)))
    throw new RuntimeReadingError("请先完成前面的必读资料。");
  const next = [...receipts, { definitionId: session.runtimeDefinitionId, roleId: session.userRoleId, actId: session.currentActId,
    sectionId: section.sourceDocumentSectionId, completedAt: new Date().toISOString() }];
  const allDone = displays.filter(s => s.required !== false).every(s => next.some(r => r.definitionId === session.runtimeDefinitionId &&
    r.roleId === session.userRoleId && r.actId === session.currentActId && r.sectionId === s.sourceDocumentSectionId));
  await prisma.$transaction(async tx => {
    await assertDMTransactionFence(tx, gameId);
    const changed = await tx.gameSession.updateMany({ where: { id: gameId, runtimeDefinitionId: session.runtimeDefinitionId,
      currentActId: session.currentActId, currentPhase: session.currentPhase, userRoleId: session.userRoleId,
      dmFlowCursorJson: session.dmFlowCursorJson, readingReceiptsJson: session.readingReceiptsJson },
      data: { readingReceiptsJson: toJsonInput(next), ...(allDone ? { userReadActIds: toJsonInput([...new Set([
        ...fromJsonValue<string[]>(session.userReadActIds, []), session.currentActId])]) } : {}) } });
    if (!changed.count) throw new RuntimeReadingError("阅读状态已变化，请刷新后重试。");
  });
  return true;
}

export function readingSourceReceiptsComplete(record: { status: string; sourceReadings?: { sourceId: string }[] } | undefined, ids: string[]) {
  return record?.status === "completed" && ids.length > 0 && ids.every(id => record.sourceReadings?.some(r => r.sourceId === id));
}

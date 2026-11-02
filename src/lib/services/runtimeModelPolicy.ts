import "server-only";
import { prisma } from "@/src/lib/db/prisma";

// An authored act policy, not a pause FSM. Read cheap persisted state both before
// queueing and immediately before every external attempt (including retries).
export async function runtimeModelsDisabled(gameId: string) {
  const s = await prisma.gameSession.findUnique({ where: { id: gameId } });
  if (!s) return false;
  if (s.currentPhase === "finished") return true;
  if (!s.runtimeDefinitionId) return false;
  const d = await prisma.scriptRuntimeDefinition.findUniqueOrThrow({ where: { id: s.runtimeDefinitionId } });
  const def = JSON.parse(d.definitionJson);
  return def.acts.some((a: { actIndex: number; modelPolicy?: string }) => `runtime_act_${a.actIndex}` === s.currentActId && a.modelPolicy === "disabled");
}
export async function assertRuntimeModelCall(input: { gameSessionId?: string | null; actId?: string | null }) {
  if (!input.gameSessionId) return;
  const row = await prisma.gameSession.findUnique({ where: { id: input.gameSessionId }, select: { currentActId: true, currentPhase: true } });
  if (row?.currentPhase === "finished") throw new Error("game already finished");
  if (await runtimeModelsDisabled(input.gameSessionId)) throw new Error("本幕禁止模型调用。");
  if (input.actId && row && row.currentActId !== input.actId) throw new Error("旧幕模型任务已失效。");
}

// Best-effort transport cancellation for already-started calls in this process.
// Persistent act checks remain authoritative after a restart or across workers.
const activeCalls = new Map<string, Set<AbortController>>();
export function registerRuntimeModelSignal(input: { gameSessionId?: string | null; signal?: AbortSignal }) {
  if (!input.gameSessionId) return { signal: input.signal, release() {} };
  const gameId = input.gameSessionId, controller = new AbortController();
  const entries = activeCalls.get(gameId) ?? new Set<AbortController>();
  entries.add(controller); activeCalls.set(gameId, entries);
  return { signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal,
    release() { entries.delete(controller); if (!entries.size) activeCalls.delete(gameId); } };
}
export function cancelRuntimeModelCalls(gameId: string) {
  for (const controller of activeCalls.get(gameId) ?? []) controller.abort(new Error("旧幕模型任务已取消。"));
}

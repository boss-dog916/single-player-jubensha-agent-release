import type { GameSession } from "@/src/lib/types/game";

export type RuntimeMode = "runtime_auto" | "runtime_manual_debug" | "legacy_demo";

export function getRuntimeMode(session: Pick<GameSession, "runtimeDefinitionId" | "runtimeScope">): RuntimeMode {
  const scope = session.runtimeScope as { runtimeMode?: RuntimeMode } | null;
  if (!session.runtimeDefinitionId) return "legacy_demo";
  return scope?.runtimeMode === "runtime_manual_debug" ? "runtime_manual_debug" : "runtime_auto";
}

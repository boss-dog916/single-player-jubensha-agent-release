import "server-only";
import { prisma } from "@/src/lib/db/prisma";
import { playerGameIdsFromCookies } from "@/src/lib/access/localCredentials";
import { getOrCreateDefaultScriptPackage } from "./scriptPackageService";
import { validateScriptPackageScript } from "./scriptPackageValidator";
import { prepareRuntimeGameSession } from "./runtimeDefinitionSessionService";

export type PlayableScript = { id: string; title: string; runtimeDefinitionId: string | null; version: number | null;
  kind: "demo" | "runtime"; roleCount: number; actCount: number };

export async function listPlayableScripts(): Promise<PlayableScript[]> {
  const result: PlayableScript[] = [];
  // Prefetch and navigation can seed the demo simultaneously on a fresh DB.
  const demo = await getOrCreateDefaultScriptPackage().catch(error => {
    if (error?.code === "P2002") return getOrCreateDefaultScriptPackage();
    throw error;
  });
  if (validateScriptPackageScript(demo.script).status !== "invalid") result.push({ id: demo.id, title: demo.title,
    runtimeDefinitionId: null, version: null, kind: "demo", roleCount: demo.script.roles.length, actCount: demo.script.acts.length });
  const packages = await prisma.scriptPackage.findMany({
    where: { runtimeDefinitions: { some: { status: { in: ["VALID", "WARNING"] } } } },
    select: { id: true, title: true, runtimeDefinitions: { where: { status: { in: ["VALID", "WARNING"] } },
      orderBy: { version: "desc" }, select: { id: true, version: true } } }, orderBy: { updatedAt: "desc" }
  });
  for (const item of packages) for (const runtime of item.runtimeDefinitions) {
    try {
      const prepared = await prepareRuntimeGameSession({ scriptPackageId: item.id, runtimeDefinitionId: runtime.id, normalGame: true });
      result.push({ id: item.id, title: item.title, runtimeDefinitionId: runtime.id, version: runtime.version,
        kind: "runtime", roleCount: prepared.script.roles.length, actCount: prepared.script.acts.length });
      break;
    } catch { /* Incomplete candidates stay in the authenticated management UI. */ }
  }
  return result;
}

export async function listBrowserGames(cookieHeader: string) {
  const ids = playerGameIdsFromCookies(cookieHeader);
  if (!ids.length) return [];
  const rows = await prisma.gameSession.findMany({ where: { id: { in: ids } }, orderBy: { updatedAt: "desc" }, take: 50,
    select: { id: true, currentPhase: true, userRoleId: true, updatedAt: true, scriptPackage: { select: { title: true } } } });
  return rows.map(row => ({ id: row.id, title: row.scriptPackage?.title ?? "我的游戏", phase: row.currentPhase,
    role: row.userRoleId, updatedAt: row.updatedAt.toISOString() }));
}
export type BrowserGame = Awaited<ReturnType<typeof listBrowserGames>>[number];

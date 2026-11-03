import { cookies } from "next/headers";
import { gameFromCookies, developerFromCookies } from "@/src/lib/access/localCredentials";
import { LocalAccessPanel, PlayerEntryBootstrap } from "@/components/LocalAccessPanel";
import { toPlayerSnapshot } from "@/src/lib/access/playerView";
import { GameLayout } from "@/components/GameLayout";
import { getGameRuntimeSnapshot } from "@/src/lib/services/gameRuntimeSnapshotService";
import { localPlaytestManifest, localPlaytestMode } from "@/src/lib/llm/localPlaytestGuard";

type GamePageProps = {
  searchParams?: Promise<{ view?: string }>;
  params: Promise<{
    gameId: string;
  }>;
};

export default async function GamePage({ params, searchParams }: GamePageProps) {
  const { gameId } = await params;

  const cookieHeader = (await cookies()).toString();
  if (!gameFromCookies(cookieHeader, gameId)) return <LocalAccessPanel gameId={gameId} />;
  const developerAccess = developerFromCookies(cookieHeader);
  const developerMode = developerAccess && (await searchParams)?.view !== "player";
  try {
    const snapshot = toPlayerSnapshot(await getGameRuntimeSnapshot(gameId));

    const mode = localPlaytestMode();
    if (mode && developerAccess) {
      const { manifest } = localPlaytestManifest();
      return <>
        <div className="border-b border-brass/30 bg-amber-50 px-6 py-3 text-sm text-ink" role="status">
          本地隔离开发试玩 · {mode === "live" ? "真实模型已开启" : mode === "mock" ? "Mock 模型，无真实调用" : "真实模型未授权，调用已阻止"}
          <br />{manifest.fixtureKind === "old-house-six-act"
            ? "《旧宅回声》原创短本与原创DM台词；完整六幕Mock验收，不含团队匹配。禁止真实模型调用。"
            : manifest.fixtureKind === "old-house-group-matching"
            ? "《旧宅回声》原创短本与原创DM台词；仅第一至二幕机制验收。模型为Mock，禁止真实调用；未提交草稿刷新后不保留。"
            : manifest.fixtureKind === "long-night-full"
            ? <>《如果长夜无明》完整七幕真实资料 · 第七幕不调用模型 · {mode === "mock" ? "仅验证流程，不验证模型质量" : "不设人为请求次数上限；可安全停止服务保留进度"}</>
            : <>角色本为合成测试资料，DM固定正文来自真实手册；非完整商业剧本。单局最多 {manifest.maxCalls} 次请求，到第二幕读本停止生成。</>}
        </div>
        <PlayerEntryBootstrap gameId={gameId} /><GameLayout initialSnapshot={snapshot} developerMode={developerMode} developerAccess={developerAccess} />
      </>;
    }
    return <><PlayerEntryBootstrap gameId={gameId} /><GameLayout initialSnapshot={snapshot} developerMode={developerMode} developerAccess={developerAccess} /></>;
  } catch (error) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center p-6">
        <section className="rounded-lg border border-ember/30 bg-white p-6 shadow-panel">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ember">
            Restore failed
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-ink">无法恢复这个 GameSession</h1>
          <p className="mt-4 text-sm leading-7 text-ink/70">
            gameId：{gameId}
          </p>
          <p className="mt-3 text-sm leading-7 text-ink/70">
            {"恢复未完成，请向开发者检查本局状态。"}
          </p>
          <p className="mt-4 rounded-md bg-ember/10 p-3 text-sm leading-6 text-ember">
            系统没有自动新开局。请返回剧本库继续已保存的游戏，或向维护者反馈本局状态。
          </p>
        </section>
      </main>
    );
  }
}

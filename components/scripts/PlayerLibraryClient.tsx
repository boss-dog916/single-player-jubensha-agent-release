"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { StoryBoardOption } from "../StoryBoardOption";
import type { BrowserGame, PlayableScript } from "@/src/lib/services/playerLibraryService";

export function PlayerLibraryClient({ scripts, games }: { scripts: PlayableScript[]; games: BrowserGame[] }) {
  const router = useRouter();
  const [board, setBoard] = useState(false), [busy, setBusy] = useState<string | null>(null), [error, setError] = useState("");
  async function start(script: PlayableScript) {
    if (busy) return;
    setBusy(script.id); setError("");
    try {
      const response = await fetch("/api/player/games", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptPackageId: script.id, runtimeDefinitionId: script.runtimeDefinitionId, publicStoryBoardEnabled: board }) });
      const body = await response.json();
      if (!response.ok || typeof body.gameId !== "string") throw new Error(body.error ?? "创建游戏失败。");
      router.push(`/games/${encodeURIComponent(body.gameId)}`);
    } catch (e) { setError(e instanceof Error ? e.message : "创建游戏失败。"); setBusy(null); }
  }
  return <div className="space-y-7">
    <section className="space-y-3" aria-label="我的游戏">
      <h2 className="text-xl font-semibold">继续我的游戏</h2>
      <p className="text-sm text-ink/65">同一浏览器保留本局凭证时可继续；其他游戏的凭证不能通用。</p>
      {!games.length ? <p className="text-sm text-ink/60">此浏览器暂无可继续的游戏。</p> : <div className="grid gap-3 sm:grid-cols-2">{games.map(g =>
        <Link key={g.id} href={`/games/${g.id}`} className="rounded-lg border border-ink/15 bg-white/90 p-4 hover:border-brass/60">
          <span className="font-semibold">{g.title}</span><p className="mt-2 text-sm text-ink/65">{g.role ?? "尚未选角"} · {g.phase === "finished" ? "已结束，可回看" : "继续游戏"}</p>
        </Link>)}</div>}
    </section>
    <section className="space-y-4" aria-label="可玩剧本">
      <h2 className="text-xl font-semibold">开始新游戏</h2>
      <StoryBoardOption enabled={board} onChange={setBoard} disabled={Boolean(busy)} />
      {!scripts.some(s => s.kind === "runtime") ? <p className="rounded-lg border border-brass/25 p-4 text-sm text-ink/70">尚未安装完整预置剧本；原创演示仅供体验。合法资源包可由本机安装，剧本管理位于开发者入口。</p> : null}
      <div className="grid gap-4 sm:grid-cols-2">{scripts.map(s => <article key={`${s.id}:${s.runtimeDefinitionId}`} className="rounded-lg border border-ink/15 bg-white/90 p-5 shadow-panel">
        <h3 className="text-xl font-semibold">{s.title}</h3>
        <p className="my-3 text-sm text-ink/65">{s.kind === "demo" ? "原创演示" : `v${s.version}`} · {s.roleCount}名角色 · {s.actCount}幕</p>
        <button disabled={Boolean(busy)} onClick={() => void start(s)} className="rounded-md bg-pine px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy === s.id ? "正在开局…" : "开始游戏"}
        </button>
      </article>)}</div>
      {error ? <p role="alert" className="text-sm text-ember">{error}</p> : null}
    </section>
  </div>;
}

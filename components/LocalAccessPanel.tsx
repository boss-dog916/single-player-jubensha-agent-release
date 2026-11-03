"use client";
import { useEffect, useState } from "react";

export function LocalAccessPanel({ gameId, nextPath = "/developer/scripts" }: { gameId?: string; nextPath?: string }) {
  const [token, setToken] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!gameId) return;
    const enter = () => {
      setBusy(Boolean(window.location.hash));
      void consumeEntry(gameId).then(entered => { if (entered) window.location.reload(); else setBusy(false); })
        .catch(() => { setError("进入链接无效或已过期，请向开发者索取新链接。"); setBusy(false); });
    };
    enter(); window.addEventListener("hashchange", enter);
    return () => window.removeEventListener("hashchange", enter);
  }, [gameId]);
  if (gameId) return <main className="mx-auto grid min-h-screen max-w-xl content-center gap-4 p-6">
    <h1 className="text-2xl font-semibold">此浏览器没有本局访问凭证</h1>
    <p>请在创建本局的浏览器中继续，或使用维护者提供的本局进入链接。其他游戏的凭证不能访问本局。</p>
    <a className="text-brass underline" href="/scripts">返回剧本库</a>
    <a className="text-sm underline" href="/developer">开发者入口</a>
    {busy ? <p>正在验证本局链接……</p> : null}{error ? <p role="alert">{error}</p> : null}
  </main>;
  return <main className="mx-auto grid min-h-screen max-w-xl content-center gap-4 p-6">
    <h1 className="text-2xl font-semibold">{gameId ? "需要本局访问凭证" : "本机开发者访问"}</h1>
    {gameId ? <p>请使用开发者提供的本局进入链接。已有浏览器凭证会自动恢复；其他游戏的凭证不能进入本局。</p> : null}
    <p className="text-sm">开发者可在项目终端运行 <code>npm run access:local</code> 查看本机管理凭证；隔离试玩须追加启动终端显示的 --dir 参数。凭证仅保存在本机，不是玩家账号。</p>
    <input type="password" aria-label="开发者凭证" autoComplete="off" className="rounded border p-3" value={token} onChange={e => setToken(e.target.value)} />
    <button disabled={busy || !token} className="rounded bg-pine p-3 text-white disabled:opacity-40" onClick={() => {
      setBusy(true); setError("");
      void fetch("/api/access/developer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })
        .then(async r => { if (!r.ok) throw new Error("开发者凭证无效。"); setToken(""); window.location.assign(gameId ? `/games/${encodeURIComponent(gameId)}` : nextPath); })
        .catch(e => { setError(e instanceof Error ? e.message : "解锁未完成。"); setBusy(false); });
    }}>解锁开发者功能</button>
    <button className="text-sm underline" onClick={() => { void fetch("/api/access/developer", { method: "DELETE" }).then(() => window.location.assign("/")); }}>清除此浏览器的开发者权限</button>
    {busy ? <p>正在验证访问凭证……</p> : null}{error ? <p role="alert">{error}</p> : null}
  </main>;
}

async function consumeEntry(gameId: string) {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("access");
  if (!token) return false;
  window.history.replaceState(null, "", window.location.pathname);
  const response = await fetch("/api/access/player", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gameId, token }) });
  if (!response.ok) throw new Error("Invalid entry link");
  return true;
}
export function PlayerEntryBootstrap({ gameId }: { gameId: string }) {
  useEffect(() => {
    const enter = () => { void consumeEntry(gameId).catch(() => {}); };
    enter(); window.addEventListener("hashchange", enter);
    return () => window.removeEventListener("hashchange", enter);
  }, [gameId]); return null;
}

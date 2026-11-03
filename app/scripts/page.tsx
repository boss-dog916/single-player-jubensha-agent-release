import { cookies } from "next/headers";
import Link from "next/link";
import { developerFromCookies } from "@/src/lib/access/localCredentials";
import { PlayerLibraryClient } from "@/components/scripts/PlayerLibraryClient";
import { listPlayableScripts, listBrowserGames, type PlayableScript, type BrowserGame } from "@/src/lib/services/playerLibraryService";

export const dynamic = "force-dynamic";
export default async function ScriptsPage() {
  const header = (await cookies()).toString();
  let scripts: PlayableScript[] = [], games: BrowserGame[] = [], error = "";
  try { [scripts, games] = await Promise.all([listPlayableScripts(), listBrowserGames(header)]); }
  catch { error = "剧本库尚未准备好，请在本机完成数据库初始化后刷新。"; }
  return <main className="mx-auto min-h-screen max-w-[1120px] space-y-7 p-6">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-ink/15 pb-5">
      <div><p className="text-xs uppercase tracking-[.18em] text-brass">Script Library</p>
        <h1 className="mt-2 text-3xl font-semibold">剧本库</h1><p className="mt-3 text-sm text-ink/65">选择剧本开始，无需开发者凭证。</p></div>
      <nav className="flex gap-4 text-sm"><Link className="underline" href="/">返回首页</Link>
        {developerFromCookies(header) ? <Link className="underline" href="/developer/scripts">管理剧本</Link> : <Link className="underline" href="/developer">开发者入口</Link>}</nav>
    </header>
    {error ? <p role="alert" className="text-ember">{error}</p> : <PlayerLibraryClient scripts={scripts} games={games} />}
  </main>;
}

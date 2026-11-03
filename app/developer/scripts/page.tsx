import { cookies } from "next/headers";
import { developerFromCookies } from "@/src/lib/access/localCredentials";
import { LocalAccessPanel } from "@/components/LocalAccessPanel";
import Link from "next/link";
import { ScriptsLibraryClient } from "@/components/scripts/ScriptsLibraryClient";
import { listScriptPackageSummaries } from "@/src/lib/services/scriptPackageService";

export default async function DeveloperScriptsPage() {
  if (!developerFromCookies((await cookies()).toString())) return <LocalAccessPanel />;
  const scriptPackages = await listScriptPackageSummaries();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1120px] flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-ink/10 pb-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">
            Script Library
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-ink">剧本管理</h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-ink/64">
            从预置剧本开始游戏。自定义上传与解析为实验性功能，需人工核对后发布。
          </p>
        </div>
        <Link
          href="/"
          className="rounded-md border border-ink/15 px-4 py-2 text-sm font-semibold text-ink transition hover:bg-paper"
        >
          返回首页
        </Link>
      </header>

      <ScriptsLibraryClient initialScriptPackages={scriptPackages} />
    </main>
  );
}

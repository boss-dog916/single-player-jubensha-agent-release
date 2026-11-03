import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[900px] flex-col justify-center gap-6 p-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">
          Single Player Jubensha
        </p>
        <h1 className="mt-3 text-3xl font-semibold text-ink">剧本杀 Multi-Agent v2</h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-ink/68">
          进入剧本库选择剧本与角色，即可开始属于你的故事。
          同一浏览器可继续已保存的游戏，无需开发者凭证。
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Link
          href="/scripts"
          className="flex h-11 items-center rounded-md bg-pine px-5 text-sm font-semibold text-white transition hover:bg-pine/90"
        >
          进入剧本库
        </Link>
        <Link href="/developer" className="flex h-11 items-center rounded-md border border-ink/20 px-5 text-sm font-semibold hover:border-brass/60">开发者入口</Link>
      </div>
    </main>
  );
}

import { NewGameButton } from "@/components/NewGameButton";
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
          点击新游戏后会创建一局持久化 GameSession，并进入该局专属 URL。
          刷新页面会从数据库恢复当前进度、消息和公共故事板。
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Link
          href="/scripts"
          className="flex h-11 items-center rounded-md bg-pine px-5 text-sm font-semibold text-white transition hover:bg-pine/90"
        >
          进入剧本库
        </Link>
        <NewGameButton />
      </div>
    </main>
  );
}

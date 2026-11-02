import { cookies } from "next/headers";
import { gameFromCookies } from "@/src/lib/access/localCredentials";
import { LocalAccessPanel } from "@/components/LocalAccessPanel";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getPlayerPdfBookletForReading,
  PlayerPdfReadingError
} from "@/src/lib/services/playerPdfReadingService";
import { PlayerBookletReader } from "@/components/PlayerBookletReader";

type PlayerBookletPageProps = {
  params: Promise<{
    gameId: string;
  }>;
  searchParams: Promise<{
    actIndex?: string;
    sectionId?: string;
  }>;
};

export default async function PlayerBookletPage({
  params,
  searchParams
}: PlayerBookletPageProps) {
  const { gameId } = await params;
  if (!gameFromCookies((await cookies()).toString(), gameId)) return <LocalAccessPanel gameId={gameId} />;
  const query = await searchParams;
  const requestedActIndex = query.actIndex ? Number(query.actIndex) : null;

  try {
    const reader = await getPlayerPdfBookletForReading(gameId);
    return <PlayerBookletReader gameId={gameId} reader={reader} initialActIndex={requestedActIndex ?? reader.currentActIndex} />;
  } catch (error) {
    if (error instanceof PlayerPdfReadingError && error.statusCode !== 404) {
      return (
        <main className="flex h-[100dvh] items-center justify-center bg-paper p-5 text-ink">
          <section className="max-w-md rounded-lg border border-ember/20 bg-white p-5 shadow-panel">
            <p className="text-sm font-semibold text-ember">无法打开玩家读本</p>
            <p className="mt-2 text-sm leading-6 text-ink/70">{error.message}</p>
            <Link
              href={`/games/${gameId}`}
              className="mt-4 inline-flex rounded-md bg-pine px-3 py-2 text-sm font-semibold text-white"
            >
              返回游戏
            </Link>
          </section>
        </main>
      );
    }

    notFound();
  }
}

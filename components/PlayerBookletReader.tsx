"use client";

import { useEffect, useRef } from "react";
import type { PlayerPdfBookletView } from "@/src/lib/services/playerPdfReadingService";

type Props = {
  gameId: string;
  reader: PlayerPdfBookletView;
  initialActIndex: number;
};

export function PlayerBookletReader({ gameId, reader, initialActIndex }: Props) {
  const initialScrollDone = useRef(false);
  const targetActIndex = reader.chapters.some(chapter => chapter.actIndex === initialActIndex)
    ? initialActIndex
    : reader.currentActIndex;
  useEffect(() => {
    if (initialScrollDone.current) return;
    initialScrollDone.current = true;
    requestAnimationFrame(() => document.getElementById(`booklet-act-${targetActIndex}`)?.scrollIntoView({ block: "start" }));
  }, [targetActIndex]);

  const contents = <BookletContents chapters={reader.chapters} currentActIndex={reader.currentActIndex} />;
  return (
    <main className="mx-auto min-h-[100dvh] w-full max-w-[1540px] p-3 text-ink sm:p-5 lg:p-6">
      <header className="sticky top-0 z-20 mb-4 flex flex-wrap items-end justify-between gap-4 rounded-lg border border-ink/10 bg-white/90 px-5 py-4 shadow-panel">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">My Booklet</p>
          <h1 className="mt-1 text-xl font-semibold text-ink">{reader.roleName}的剧本</h1>
          <p className="mt-1 text-sm text-ink/60">仅展示当前已解锁的角色资料 · 已至第 {reader.currentActIndex} 幕</p>
        </div>
        <a href={`/games/${gameId}`} className="rounded-md border border-ink/15 bg-paper px-4 py-2 text-sm font-semibold text-ink transition hover:bg-mist">
          返回游戏
        </a>
        <details className="w-full lg:hidden">
          <summary className="cursor-pointer text-sm font-semibold text-brass">目录 · 跳转幕次</summary>
          <div className="mt-3 max-h-[35dvh] overflow-y-auto">{contents}</div>
        </details>
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="sticky top-36 hidden max-h-[calc(100dvh-160px)] overflow-y-auto rounded-lg border border-ink/10 bg-white/90 p-4 shadow-panel lg:block">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">Contents</p>
          <h2 className="mt-1 text-lg font-semibold text-ink">剧本目录</h2>
          <div className="mt-4">{contents}</div>
        </aside>
        <section className="min-w-0 space-y-6">
          {!reader.chapters.length ? <p className="rounded-lg border border-ink/10 bg-white/90 p-6 text-ink/70">当前尚无可阅读的资料。</p> : null}
          {reader.chapters.map(chapter => <article key={chapter.actIndex} id={`booklet-act-${chapter.actIndex}`} className="scroll-mt-48 overflow-hidden rounded-lg border border-ink/10 bg-white/90 shadow-panel lg:scroll-mt-36">
            <header className="border-b border-ink/10 px-5 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">Act {chapter.actIndex}</p>
              <h2 className="mt-1 text-xl font-semibold text-ink">{chapter.actTitle}</h2>
            </header>
            <div className="space-y-4 p-3 sm:p-4">
              {chapter.text !== undefined ? <p className="whitespace-pre-line px-2 py-3 text-sm leading-8 text-ink/80 sm:px-4">{chapter.text}</p> : null}
              {chapter.documents.map((document, index) => <section key={document.sectionId} className="pdf-reading-surface overflow-hidden rounded-md border border-brass/20 p-2 sm:p-3">
                {chapter.documents.length > 1 ? <p className="mb-2 px-1 text-xs text-ink/64">资料 {index + 1} · {document.originalName}</p> : null}
                <iframe
                  title={`第 ${chapter.actIndex} 幕 · ${document.originalName}`}
                  src={`${document.pdfUrl}#page=${document.pageStart}`}
                  loading={chapter.actIndex === targetActIndex ? "eager" : "lazy"}
                  className="pdf-page-frame h-[76dvh] min-h-[560px] w-full rounded border sm:h-[82dvh]"
                />
              </section>)}
            </div>
          </article>)}
        </section>
      </div>
    </main>
  );
}

function BookletContents({ chapters, currentActIndex }: Pick<PlayerPdfBookletView, "chapters" | "currentActIndex">) {
  return <nav aria-label="剧本幕次目录" className="grid gap-2">
    {chapters.map(chapter => <a key={chapter.actIndex} href={`#booklet-act-${chapter.actIndex}`}
      onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); }}
      className={`rounded-md border px-3 py-2 text-sm transition ${chapter.actIndex === currentActIndex ? "border-brass/45 bg-brass/10 text-brass" : "border-ink/10 bg-paper text-ink/74 hover:bg-mist"}`}>
      <span className="mr-2 text-xs opacity-70">第 {chapter.actIndex} 幕</span>{chapter.actTitle}
    </a>)}
  </nav>;
}

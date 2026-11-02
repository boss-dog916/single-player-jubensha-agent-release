import type { PublicStoryBoard, Message } from "@/src/lib/types/game";
import { presentPublicFacts } from "@/src/lib/services/publicStoryBoardPresentation";

type StoryBoardPanelProps = {
  showBoard?: boolean;
  storyBoard: PublicStoryBoard;
  messages?: Message[];
  clues?: import("@/src/lib/schemas/runtimeClueSchema").VisibleRuntimeClue[];
  onShareClue?: (clueId: string) => void;
  clueSharePending?: boolean;
};

export function StoryBoardPanel({ storyBoard, messages = [], clues = [], onShareClue, clueSharePending, showBoard = true }: StoryBoardPanelProps) {
  if (!showBoard && !clues.length) return null;
  const presented = presentPublicFacts(storyBoard.known_facts, messages);
  return (
    <aside className="flex min-h-0 flex-1 flex-col rounded-lg border border-ink/10 bg-white/90 shadow-panel">
      <div className="shrink-0 border-b border-ink/10 p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">
          {showBoard ? "StoryBoardPanel" : "线索资料"}
        </p>
        <h2 className="mt-1 text-xl font-semibold text-ink">{showBoard ? "公共故事板" : "正式线索"}</h2>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {clues.length ? <section aria-label="已获得的线索" className="space-y-3">
          <h3 className="font-semibold">已获得的线索</h3>
          {clues.map(clue => <article key={clue.clueId} className="rounded border border-ink/10 p-3 text-sm">
            <h4 className="font-semibold">{clue.title} · {clue.publiclyShared ? "已公开" : "本人私密"}</h4>
            <p className="my-2 whitespace-pre-wrap">{clue.text}</p>
            {clue.pdfUrl ? <a href={clue.pdfUrl} target="_blank" rel="noreferrer" className="text-pine underline">阅读原始线索PDF</a> : null}
            <p className="text-xs text-ink/60">来源：{clue.source === "uploaded_asset" ? "上传资料" : clue.source === "dm_flow_clue_ref" ? "主持资料" : "作者提供的线索"} · {clue.granted ? "已发放" : "公开分享所得"} · {clue.publiclyShared ? "公开资料" : clue.shareAllowed ? "允许公开" : "尚未获准公开"}</p>
            {clue.granted && clue.shareAllowed && !clue.publiclyShared && onShareClue ? <button disabled={clueSharePending} onClick={() => onShareClue(clue.clueId)} className="mt-2 rounded border px-3 py-1 disabled:opacity-40">分享线索</button> : null}
          </article>)}
        </section> : null}
        {showBoard && (isEmptyVisibleStoryBoard(storyBoard) ? (
          <div className="rounded-md border border-dashed border-ink/15 bg-paper/70 p-4 text-sm leading-6 text-ink/60">
            暂无公开线索，请等待玩家分享。
          </div>
        ) : (
          <>
          <BoardSection title="已公开事实" items={presented.facts} marker="fact" />
          <BoardSection title="关键事件" items={storyBoard.timeline} marker="time" />
          <BoardSection title="人物关系" items={storyBoard.relationships} marker="bond" />
          <BoardSection title="矛盾" items={storyBoard.contradictions} marker="conflict" />
          <BoardSection title="情绪羁绊" items={storyBoard.emotional_bonds} marker="bond" />
          <BoardSection title="当前冲突" items={storyBoard.current_conflicts} marker="conflict" />
          {presented.otherResponses.length ? <details className="text-sm text-ink/60"><summary>演绎中的不确定回应（{presented.otherResponses.length}）</summary>
            <BoardSection title="其他公开回应" items={presented.otherResponses} marker="fact" />
          </details> : null}
          </>
        ))}
      </div>
    </aside>
  );
}

function BoardSection({
  title,
  items,
  marker
}: {
  title: string;
  items: string[];
  marker: "fact" | "time" | "question" | "bond" | "conflict";
}) {
  if (items.length === 0) {
    return null;
  }

  const markerClass = {
    fact: "bg-pine",
    time: "bg-brass",
    question: "bg-ember",
    bond: "bg-pine/70",
    conflict: "bg-ink/70"
  }[marker];

  return (
    <section className="rounded-md border border-ink/10 p-4">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <ul className="mt-3 space-y-3">
        {items.map((item) => (
          <li key={item} className="flex gap-3 text-sm leading-6 text-ink/74">
            <span className={`mt-2 h-2 w-2 shrink-0 rounded-full ${markerClass}`} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function isEmptyVisibleStoryBoard(storyBoard: PublicStoryBoard): boolean {
  return [
    storyBoard.known_facts,
    storyBoard.timeline,
    storyBoard.relationships,
    storyBoard.contradictions,
    storyBoard.emotional_bonds,
    storyBoard.current_conflicts
  ].every((items) => items.length === 0);
}

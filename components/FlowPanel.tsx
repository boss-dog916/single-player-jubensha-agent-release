import type { GamePhase } from "@/src/lib/types/game";
import type { AiInternalReadingStatusView } from "@/src/lib/services/gameRuntimeSnapshotService";

type FlowGameView = {
  title: string;
  currentAct: {
    index: number;
    total: number;
    title: string;
    bgm: string;
  };
  currentPhase: {
    id: GamePhase;
    label: string;
  };
};

type FlowPanelProps = {
  game: FlowGameView;
  currentCalledRoleName?: string | null;
  aiInternalReadingStatus?: AiInternalReadingStatusView;
};

const phases: Array<{ id: GamePhase; label: string }> = [
  { id: "role_selection", label: "选择角色" },
  { id: "reading", label: "阅读本幕" },
  { id: "ai_internal_reading", label: "AI 私下读本" },
  { id: "share_round", label: "故事分享" },
  { id: "free_discussion", label: "自由讨论" },
  { id: "dm_question", label: "DM 提问" },
  { id: "act_summary", label: "本幕总结" },
  { id: "finished", label: "结束" }
];

export function FlowPanel({
  game,
  currentCalledRoleName,
  aiInternalReadingStatus
}: FlowPanelProps) {
  return (
    <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-lg border border-ink/10 bg-white/90 p-4 shadow-panel">
      <div className="shrink-0">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">
          当前剧本
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-ink">{game.title}</h1>
      </div>

      <div className="grid shrink-0 gap-2">
        <InfoBlock label="当前幕" value={`第 ${game.currentAct.index} / ${game.currentAct.total} 幕`} />
        <InfoBlock label="幕标题" value={game.currentAct.title} />
        <InfoBlock label="当前阶段" value={game.currentPhase.label} />
      </div>

      <section className="shrink-0 rounded-md bg-mist p-3">
        <p className="text-sm font-semibold text-pine">当前 BGM</p>
        <p className="mt-2 text-sm leading-6 text-ink/76">{game.currentAct.bgm}</p>
      </section>

      <section className="shrink-0 rounded-md border border-ink/10 p-3">
        <p className="text-sm font-semibold text-ink">流程阶段</p>
        <ol className="mt-2 space-y-1 text-sm text-ink/76">
          {phases.map((phase) => (
            <li
              key={phase.id}
              className={[
                "rounded-md px-3 py-1.5",
                game.currentPhase.id === phase.id ? "bg-pine text-white" : "bg-paper/70"
              ].join(" ")}
            >
              {phase.label}
            </li>
          ))}
        </ol>
      </section>

      {game.currentPhase.id === "share_round" && currentCalledRoleName ? (
        <section className="shrink-0 rounded-md border border-brass/30 bg-brass/10 p-3">
          <p className="text-sm font-semibold text-ink">DM 当前点名</p>
          <p className="mt-2 text-sm text-ink/76">请 {currentCalledRoleName} 分享。</p>
        </section>
      ) : null}

      {(game.currentPhase.id === "reading" || game.currentPhase.id === "ai_internal_reading") &&
      aiInternalReadingStatus ? (
        <section className="shrink-0 rounded-md border border-pine/20 bg-pine/10 p-3">
          <p className="text-sm font-semibold text-ink">AI 读本</p>
          <p className="mt-2 text-sm text-ink/76">
            {aiInternalReadingStatus.completedCount} / {aiInternalReadingStatus.roles.length} 已完成
          </p>
          {aiInternalReadingStatus.failedCount > 0 ? (
            <p className="mt-1 text-xs font-medium text-ember">有角色读本失败，稍后会重试。</p>
          ) : null}
        </section>
      ) : null}
    </aside>
  );
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-ink/10 bg-paper/70 px-4 py-3">
      <p className="text-xs font-medium text-ink/55">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold text-ink">{value}</p>
    </div>
  );
}

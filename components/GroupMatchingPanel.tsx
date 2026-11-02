"use client";
import { useRef, useState } from "react";
import type { PlayerGameSnapshot } from "@/src/lib/access/playerView";
type GroupMatchingView = NonNullable<PlayerGameSnapshot["controls"]["groupMatching"]>;
import { completeMatchingDraft, updateMatchingDraft } from "./groupMatchingDraft";

export function GroupMatchingPanel({ matching, pending, onSubmit, sidebar = false }: {
  matching: GroupMatchingView; pending: boolean;
  sidebar?: boolean;
  onSubmit?: (assignments: { roleId: string; optionId: string }[], requestId: string) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(matching.roleIds.map(roleId =>
    [roleId, matching.history.at(-1)?.assignments.find(a => a.roleId === roleId)?.optionId ?? ""])));
  const request = useRef<string | null>(null);
  return <section className="mb-3 grid max-h-[45dvh] gap-2 overflow-y-auto pr-1" aria-label="团队匹配">
    <p className="text-sm font-semibold">第{matching.round}/{matching.maxRounds}轮：{matching.prompt}</p>
    {matching.hint ? <p className="text-sm">本轮提示：{matching.hint}</p> : null}
    {matching.history.map(result => <details key={result.round}><summary>第{result.round}轮：{result.correctCount === undefined ? "已提交，等待DM公布" : `答对${result.correctCount}人`}</summary>
      <p className="text-xs">以下是团队提交的分配，不代表逐人判定。</p>
      {result.assignments.map(a => <p key={a.roleId} className="text-xs">{a.roleId}：{matching.options.find(o => o.optionId === a.optionId)?.label}</p>)}
    </details>)}
    <div className={`grid gap-2 ${sidebar ? "" : "sm:grid-cols-2"}`}>{matching.roleIds.map(roleId => <label key={roleId} className="flex items-center gap-2 text-sm">
      <span>{roleId}</span><select aria-label={`${roleId}的词条`} value={draft[roleId]} disabled={pending || !matching.canSubmit}
        className="min-w-0 flex-1 rounded border border-ink/20 p-2" onChange={e => {
          setDraft(previous => updateMatchingDraft(previous, roleId, e.target.value)); request.current = null;
        }}><option value="">请选择</option>{matching.options.map(o => <option key={o.optionId} value={o.optionId}>{o.label}</option>)}</select>
    </label>)}</div>
    <p className="text-xs text-ink/65">选择已占用词条会交换两行；草稿尚未保存，刷新后恢复上一轮结果。AI意见仅供参考，可继续聊天。</p>
    <button className="h-11 rounded-md bg-pine px-4 text-sm font-semibold text-white disabled:bg-ink/25"
      disabled={pending || !matching.canSubmit || !completeMatchingDraft(draft, matching.roleIds, matching.options.map(o => o.optionId))}
      onClick={() => {
        request.current ??= crypto.randomUUID();
        onSubmit?.(matching.roleIds.map(roleId => ({ roleId, optionId: draft[roleId] })), request.current);
      }}>{matching.canSubmit ? "确认提交本轮完整分配" : "本轮已提交"}</button>
  </section>;
}

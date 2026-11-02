"use client";
export function StoryBoardOption({ enabled, onChange, disabled = false }: { enabled: boolean; onChange: (enabled: boolean) => void; disabled?: boolean }) {
  return <label className="block text-sm text-ink/75">公共信息板
    <select aria-label="公共信息板" value={enabled ? "on" : "off"} disabled={disabled} onChange={e => onChange(e.target.value === "on")}
      className="ml-2 rounded border border-ink/15 bg-white px-2 py-1">
      <option value="off">关闭（默认，推荐）</option><option value="on">开启</option>
    </select>
    <span className="mt-1 block text-xs text-ink/55">开局后固定；关闭仍保留角色记忆、公开聊天和正式线索。</span>
  </label>;
}

"use client";
import { useState } from "react";
import { GroupMatchingPanel } from "./GroupMatchingPanel";

export function MatchingSidebar(props: Parameters<typeof GroupMatchingPanel>[0]) {
  const [expanded, setExpanded] = useState(false);
  return <section aria-label="纸条匹配侧栏" className="shrink-0 rounded-lg border border-ink/10 bg-white/90 p-3 shadow-panel">
    <button type="button" className="flex w-full justify-between text-sm font-semibold text-pine lg:hidden" aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}>纸条匹配 · 第{props.matching.round}轮 <span>{expanded ? "收起" : "展开"}</span></button>
    <div className={`${expanded ? "mt-3 block" : "hidden"} lg:block`}><GroupMatchingPanel {...props} sidebar /></div>
  </section>;
}

import type { SourceEvidence } from "@/src/lib/schemas/manualSemanticSchema";
import type { LogicalActControl } from "@/src/lib/services/manualControlCompiler";

export function SourceEvidenceDetails({ source, status }: { source: Partial<SourceEvidence>; status?: string }) {
  return <details className="min-w-0 border-b border-ink/10 py-2 text-xs leading-5">
    <summary className="cursor-pointer break-all">
      {status ?? "source"} · 文档 r{source.sourceRevision ?? "未知"} · 章节集 r{source.sectionSetRevision ?? "未知"} · {source.sourceSectionId ?? "来源未记录"}
    </summary>
    <p className="break-all">document: {source.sourceDocumentId ?? "legacy unknown"}</p>
    <p>span: {source.sourceSpan ? `${source.sourceSpan.start}–${source.sourceSpan.end}` : "未记录"}</p>
    <p className="break-all">parser: {source.parserVersion ?? "legacy unknown"} · prompt: {source.promptVersion ?? "legacy unknown"}</p>
    {source.sourceQuote ? <p className="whitespace-pre-wrap break-words">{source.sourceQuote}</p> : null}
  </details>;
}

export function ManualControlDetails({ control }: { control: LogicalActControl }) {
  const gates = [control.readingGate, control.shareGate, ...control.discussionWindows, control.transitionTarget].filter(g => Boolean(g));
  return <details className="min-w-0 border-b border-ink/10 py-2 text-xs leading-5">
    <summary className="cursor-pointer">第 {control.actIndex} 幕 · {control.conversationPolicy.mode} · 来源 {control.conversationPolicy.source}</summary>
    <p className="break-words">capabilities: {control.requiredCapabilities.join(", ")}</p>
    {control.discussionWindows.map(w => <p key={w.id}>window: {w.windowId} · order: {w.order}</p>)}
    {control.transitionTarget ? <p>next act: {control.transitionTarget.nextActIndex ?? "结束"}</p> : null}
    {gates.map(g => <div key={g!.id}><p className="break-all">gate: {g!.id} → semantic: {g!.semanticItemId}</p><SourceEvidenceDetails source={g!.evidence} /></div>)}
    {control.conversationPolicy.evidence.map((source, i) => <SourceEvidenceDetails key={i} source={source} status="policy evidence" />)}
    {control.needsAttention.length ? <p className="text-ember">needs_attention: {control.needsAttention.join(", ")}</p> : null}
  </details>;
}

export function ValidationProvenance({ stored, current }: {
  stored?: { validatorVersion?: string; validatedAt?: string; status?: string };
  current: { validatorVersion?: string; validatedAt?: string; status?: string };
}) {
  return <div className="min-w-0 border-b border-ink/10 py-2 text-xs leading-5">
    <p className="break-words">保存报告：{stored?.validatorVersion ?? "legacy unknown"} · {stored?.status ?? "未知"} · {stored?.validatedAt ?? "时间未记录"}</p>
    <p className="break-words">当前验证：{current.validatorVersion ?? "未知"} · {current.status ?? "未知"} · {current.validatedAt ?? "时间未记录"}</p>
  </div>;
}

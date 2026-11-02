"use client";

import { useEffect, useState } from "react";
import type { ManualCandidateView } from "@/src/lib/services/manualSemanticParseService";
import { ManualControlDetails } from "./ManualContractDetails";
import type { HierarchicalPlanningArtifact, PlanningAttempt } from "@/src/lib/services/manualPlanningService";
import type { TaskModelProfile } from "@/src/lib/llm/llmTypes";

function ProfileLabel({ name, profile }: { name: string; profile?: Partial<TaskModelProfile> }) {
  return <p className="mt-1 text-xs">{name}: {profile?.provider?.toUpperCase() ?? "Provider 未记录"} / {profile?.model ?? "模型未记录"}</p>;
}

function PlanningProgress({ response }: { response: unknown }) {
  if (!response || typeof response !== "object" || !("mode" in response) || response.mode !== "hierarchical") return null;
  const a = response as HierarchicalPlanningArtifact;
  const timing = (r: PlanningAttempt) => {
    const completion = r.trace.find(e => e.stage === "completion");
    const usage = completion?.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    return `${r.latencyMs === undefined ? "-" : `${(r.latencyMs / 1000).toFixed(1)}s`} · input ${usage?.prompt_tokens ?? "-"} / output ${usage?.completion_tokens ?? "-"}`;
  };
  return <div className="mt-3 border-l border-ink/15 pl-3 text-xs">
    <h3 className="font-semibold">分层规划 · {(a.config as Partial<TaskModelProfile> | undefined)?.provider?.toUpperCase() ?? "Provider 未记录"} / {a.model}</h3>
    <p>局部成功 {a.windows.filter(w => w.status === "success").length}/{a.windows.length} · 缓存命中 {a.windows.filter(w => w.cacheHit).length} · 总耗时 {a.wallTimeMs === undefined ? "运行中" : `${(a.wallTimeMs / 1000).toFixed(1)}s`}</p>
    {a.windows.map(w => <p key={w.key} className="mt-1 break-words">段落 {w.window?.paragraphStart}–{w.window?.paragraphEnd} · {w.status}{w.cacheHit ? " · cache" : ""} · {timing(w)}{w.error ? ` · ${w.error}` : ""}</p>)}
    {a.global.map((g, i) => <p key={`${g.key}:${i}`} className="mt-1 break-words">全局协调 {i + 1} · {g.status}{g.cacheHit ? " · cache" : ""} · {timing(g)}{g.error ? ` · ${g.error}` : ""}</p>)}
  </div>;
}

export function ManualCandidateDetails({ candidate: c }: { candidate: ManualCandidateView }) {
  const config = (c.sourceManifest as { modelConfig?: { planner?: TaskModelProfile; extractor?: TaskModelProfile } } | null)?.modelConfig;
  return <details className="border-t border-ink/15 py-3" open>
    <summary className="text-sm font-semibold">{c.format} · 候选，未发布 · {c.status} · {c.createdAt}</summary>
    <p className="mt-2 break-all text-xs text-ink/60">{c.id}</p>
    <ProfileLabel name="Planner" profile={config?.planner} />
    <ProfileLabel name="Extractor" profile={config?.extractor} />
    {c.errorMessage ? <p className="text-sm text-ember">{c.errorMessage}</p> : null}
    <h3 className="mt-3 text-sm font-semibold">全手册规划</h3>
    <PlanningProgress response={c.planResponse} />
    {c.plan?.regions.map(r => <p key={r.regionId} className="mt-1 break-words text-xs">{r.semanticSectionType} · {r.logicalActId ?? "-"} · 幕 {r.actIndex ?? "-"} · 段落 {r.paragraphStart}–{r.paragraphEnd} · {r.sourceHeading ?? "无标题"} · {r.interpretation} · confidence {r.confidence}</p>)}
    {c.plan?.variants.map(v => <p key={v.variantGroupId} className="mt-2 text-xs">互斥版本 {v.variantGroupId}：{v.branches.map(b => b.label).join(" / ")} · 未选择 · 共同后续 {v.commonContinuationRegionIds.join(", ") || "无"}</p>)}
    <p className="mt-2 text-xs">角色：{c.plan?.roster.map(r => `${r.canonicalRole} (${r.kind}; ${r.aliases.join(", ")})`).join("、") ?? "-"}</p>
    <h3 className="mt-3 text-sm font-semibold">语义与来源</h3>
    {c.semantic?.regions.map(r => <details key={r.region.regionId} className="py-2"><summary className="text-xs">{r.region.regionId} · {r.conversationPolicy?.mode ?? "策略未确定"} · {r.items.length} 项</summary>
      {r.items.map(i => <div key={i.id} className="border-l border-ink/10 pl-3 pt-2 text-xs"><p>{i.kind} · {i.channel} · 分支 {i.branchId ?? "公共"} · confidence {i.confidence}</p><p className="break-words">{i.instruction}</p><p className="text-ink/60">来源 {i.evidence.sourceSpan.start}–{i.evidence.sourceSpan.end} · 段落 {i.evidence.paragraphStart}–{i.evidence.paragraphEnd}</p><blockquote className="break-words">{i.evidence.sourceQuote}</blockquote></div>)}
    </details>)}
    <h3 className="mt-3 text-sm font-semibold">校验</h3>
    <p className="text-xs">Semantic {c.semanticValidation?.status ?? "未完成"} · {c.semanticValidation?.validatorVersion ?? "-"} · Runtime {c.runtimeValidation?.status ?? "未完成"}</p>
    {[...(c.semanticValidation?.errors ?? []), ...(c.semanticValidation?.warnings ?? []), ...(c.runtimeValidation?.errors ?? [])].map((i, n) => <p className="mt-1 break-words text-xs" key={n}>{i.code}: {i.message}{"repairCandidate" in i && i.repairCandidate ? " · 待定向修复" : ""}</p>)}
    {c.compiled?.acts.map((a, index) => a.control ? <ManualControlDetails key={index} control={a.control} /> : <p key={index} className="text-xs">第 {a.actIndex} 幕控制未编译：策略缺少证据</p>)}
    <details className="mt-3"><summary className="text-xs">原始候选产物</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(c, null, 2)}</pre></details>
  </details>;
}

export function ManualSemanticCandidates({ scriptPackageId, refreshKey }: { scriptPackageId: string; refreshKey: number }) {
  const [candidates, setCandidates] = useState<ManualCandidateView[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/script-packages/${scriptPackageId}/dm-flow/candidates`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("候选产物加载失败");
      const body = await response.json() as { candidates: ManualCandidateView[] };
      setCandidates(body.candidates); setError(null);
    }).catch(e => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, [scriptPackageId, refreshKey]);
  return <section className="mt-4"><h2 className="text-sm font-semibold">Semantic v2 候选</h2>{error ? <p>{error}</p> : null}
    {!candidates.length && !error ? <p className="mt-2 text-xs text-ink/60">暂无候选</p> : null}{candidates.map(c => <ManualCandidateDetails key={c.id} candidate={c} />)}</section>;
}

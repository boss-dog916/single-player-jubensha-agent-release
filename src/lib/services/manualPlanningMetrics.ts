import type { HierarchicalPlanningArtifact, PlanningAttempt } from "./manualPlanningService";
import type { ChunkRecord } from "./manualSemanticPipeline";

const distribution = (values: number[]) => {
  if (!values.length) return { n: 0, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, avgMs: sorted.reduce((a, b) => a + b, 0) / sorted.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1)! };
};
function attempts(entries: PlanningAttempt[]) {
  const live = entries.filter(e => !e.cacheHit && e.startedAt), success = live.filter(e => e.status === "success");
  const usage = live.map(e => e.trace.find(t => t.stage === "completion")?.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined).filter((u): u is { prompt_tokens?: number; completion_tokens?: number } => Boolean(u));
  return { entries: entries.length, attempted: live.length, successful: entries.filter(e => e.status === "success").length,
    failed: entries.filter(e => e.status === "failed").length, pending: entries.filter(e => e.status === "pending").length, cacheHits: entries.filter(e => e.cacheHit).length,
    successRate: entries.length ? entries.filter(e => e.status === "success").length / entries.length : null,
    successfulLiveLatency: distribution(success.flatMap(e => e.latencyMs === undefined ? [] : [e.latencyMs])),
    allAttemptLatency: distribution(live.flatMap(e => e.latencyMs === undefined ? [] : [e.latencyMs])),
    observedUsageCalls: usage.length, inputTokens: usage.length ? usage.reduce((s, u) => s + (u.prompt_tokens ?? 0), 0) : null,
    outputTokens: usage.length ? usage.reduce((s, u) => s + (u.completion_tokens ?? 0), 0) : null,
    ttftMs: null, providerAcceptedAt: null };
}
export function manualPlanningMetrics(artifact: HierarchicalPlanningArtifact, chunks: ChunkRecord[]) {
  const extraction = chunks.filter(c => c.output && !c.error), usage = chunks.map(c => c.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined).filter((u): u is { prompt_tokens?: number; completion_tokens?: number } => Boolean(u));
  return { planning: { numberOfWindows: artifact.windows.length, local: attempts(artifact.windows), global: attempts(artifact.global), wallTimeMs: artifact.wallTimeMs ?? null },
    extraction: { chunks: chunks.length, successful: extraction.length, failed: chunks.filter(c => c.error).length,
      successfulLatency: distribution(extraction.flatMap(c => c.latencyMs === undefined ? [] : [c.latencyMs])),
      inputTokens: usage.length ? usage.reduce((s, u) => s + (u.prompt_tokens ?? 0), 0) : null, outputTokens: usage.length ? usage.reduce((s, u) => s + (u.completion_tokens ?? 0), 0) : null },
    note: "Non-streaming TTFT/provider queue time unavailable. Failed/time-limited attempts are not successful latency observations. Cache hits do not add historical tokens to live totals." };
}

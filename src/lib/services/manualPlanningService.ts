import "server-only";
import { z } from "zod";
import { prisma } from "@/src/lib/db/prisma";
import { generateStructured } from "@/src/lib/llm/llmClient";
import { withLlmPriority } from "@/src/lib/llm/concurrencyBudget";
import { resolveTaskModelProfile } from "@/src/lib/llm/taskModelProfiles";
import type { LlmMessage, LlmTraceEvent } from "@/src/lib/llm/llmTypes";
import { LocalStructureSchema, GlobalRelationsSchema, PLANNING_VERSIONS, type LocalStructure, type GlobalRelations } from "@/src/lib/schemas/manualPlanningSchema";
import type { ManualPlan, SemanticValidation } from "@/src/lib/schemas/manualSemanticV2Schema";
import type { ManualContext } from "./manualSemanticPipeline";
import { makeValidation } from "./manualSemanticPipeline";
import { fromJsonValue, toJsonInput } from "./jsonFields";
import { plannerRoleIdentity } from "./manualRoleIdentity";
import { documentOutline, planningWindows, groundLocalStructure, localPlanningPrompt, compactLocalSummary, planningCacheKey, globalPlanningPrompt, reconcilePlan, validateGlobalSource, fingerprint,
  type PlanningWindow, type GroundedCandidate, type GroundedReference } from "./manualPlanningPipeline";

export type PlanningAttempt<T = unknown> = {
  key: string; status: "pending" | "running" | "success" | "failed"; cacheHit: boolean; messages: LlmMessage[];
  startedAt?: string; completedAt?: string; latencyMs?: number; output: T | null; raw?: unknown;
  trace: LlmTraceEvent[]; error?: string; validation?: SemanticValidation; window?: PlanningWindow;
  formatValidation?: { json: "pass" | "fail"; zod: "pass" | "fail" | "not_run"; issues?: unknown };
};
export type HierarchicalPlanningArtifact = {
  mode: "hierarchical"; versions: typeof PLANNING_VERSIONS; model: string; config: unknown;
  targetChars: number; outline: ReturnType<typeof documentOutline>; windows: PlanningAttempt<LocalStructure>[];
  global: PlanningAttempt<GlobalRelations>[]; startedAt: string; completedAt?: string; wallTimeMs?: number;
};
type PlanningHooks = { persist: (artifact: HierarchicalPlanningArtifact) => Promise<void>; assertSource: () => Promise<void> };
export type PlanningCache = { get: (key: string) => Promise<{ output: unknown; artifact: unknown } | null>; put: (key: string, kind: string, output: unknown, artifact: unknown) => Promise<void> };
const errorIssue = (code: string, message: string) => ({ code, message, severity: "error" as const, repairCandidate: false });

export function databasePlanningCache(context: ManualContext): PlanningCache {
  return {
    get: async key => { const row = await prisma.manualPlanningCache.findUnique({ where: { cacheKey: key } }); return row ? { output: fromJsonValue(row.outputJson, null), artifact: fromJsonValue(row.artifactJson, null) } : null; },
    put: async (key, kind, output, artifact) => { const data = { cacheKey: key, documentId: context.source.documentId, documentRevision: context.source.documentRevision,
      sectionSetRevision: context.source.sectionSetRevision, kind, outputJson: toJsonInput(output), artifactJson: toJsonInput(artifact) };
      await prisma.manualPlanningCache.upsert({ where: { cacheKey: key }, create: data, update: { outputJson: data.outputJson, artifactJson: data.artifactJson } }); }
  };
}

export async function hierarchicalManualPlanning(context: ManualContext, end: number, options: { targetChars: number; timeoutMs?: number; maxOutputTokens?: number; maxRequests?: number; lastWindowIndex?: number }, hooks: PlanningHooks,
  cache: PlanningCache = databasePlanningCache(context)): Promise<{ plan: ManualPlan | null; artifact: HierarchicalPlanningArtifact; validation: SemanticValidation }> {
  if (options.lastWindowIndex !== undefined && (!Number.isInteger(options.lastWindowIndex) || options.lastWindowIndex < 0)) throw new Error("Invalid last local planning window index");
  const startedAt = Date.now(), profile = resolveTaskModelProfile("manual_planner");
  const config = { ...profile, timeoutMs: options.timeoutMs ?? profile.timeoutMs, maxOutputTokens: options.maxOutputTokens ?? profile.maxOutputTokens };
  const artifact: HierarchicalPlanningArtifact = { mode: "hierarchical", versions: PLANNING_VERSIONS, model: config.model, config,
    targetChars: options.targetChars, outline: documentOutline(context, end), windows: [], global: [], startedAt: new Date(startedAt).toISOString() };
  const candidates: GroundedCandidate[] = [], references: GroundedReference[] = [];
  let requestCount = 0;
  const finish = async (plan: ManualPlan | null, validation: SemanticValidation) => { artifact.completedAt = new Date().toISOString(); artifact.wallTimeMs = Date.now() - startedAt; await hooks.persist(artifact); return { plan, validation, artifact }; };
  async function request<T>(entry: PlanningAttempt<T>, schema: z.ZodType<T>, kind: "local" | "global", validate?: (output: T) => SemanticValidation) {
    await hooks.assertSource();
    const cached = await cache.get(entry.key);
    if (cached) {
      const parsed = schema.safeParse(cached.output);
      if (parsed.success) {
        const validation = validate?.(parsed.data);
        if (!validation || validation.status === "valid") {
          Object.assign(entry, { output: parsed.data, status: "success", cacheHit: true, raw: { cachedArtifact: cached.artifact }, validation, latencyMs: 0 });
          await hooks.persist(artifact); return;
        }
      }
    }
    if (options.maxRequests !== undefined && requestCount >= options.maxRequests) { entry.error = "Planning request budget exhausted; pending work retained"; await hooks.persist(artifact); return; }
    requestCount++;
    const begin = Date.now(); entry.status = "running"; entry.startedAt = new Date(begin).toISOString(); await hooks.persist(artifact);
    try {
      const result = await withLlmPriority(4, () => generateStructured({ agentType: kind === "local" ? "manual_local_planner" : "manual_global_planner", phase: "ingestion", schemaName: kind === "local" ? "manual_local_structure" : "manual_global_relations", zodSchema: schema,
        taskProfile: "manual_planner", messages: entry.messages, temperature: config.temperature, maxOutputTokens: config.maxOutputTokens, timeoutMs: config.timeoutMs, maxRetries: 0,
        onTrace: event => { entry.trace.push(event); }, onRawResponse: async raw => {
          entry.raw = raw;
          try {
            const parsed: unknown = JSON.parse(raw.text), checked = schema.safeParse(parsed);
            entry.formatValidation = checked.success ? { json: "pass", zod: "pass" } : { json: "pass", zod: "fail", issues: checked.error.issues };
          } catch { entry.formatValidation = { json: "fail", zod: "not_run" }; }
          await hooks.persist(artifact);
        } }));
      entry.output = result.data; entry.validation = validate?.(result.data); await hooks.assertSource();
      entry.status = entry.validation?.status === "needs_attention" ? "failed" : "success";
      if (entry.status === "success") await cache.put(entry.key, kind, entry.output, { raw: entry.raw, trace: entry.trace });
      else entry.error = entry.validation?.errors.map(e => e.code).join(", ");
    } catch (e) { entry.error = e instanceof Error ? e.message : String(e); entry.status = "failed"; }
    entry.completedAt = new Date().toISOString(); entry.latencyMs = Date.now() - begin; await hooks.persist(artifact);
  }
  // Sequential local planning stays inside the existing shared provider budget.
  let previous: unknown = [];
  for (const window of planningWindows(context, end, options.targetChars)) {
    const messages = localPlanningPrompt(context, window, previous);
    const key = planningCacheKey(context, "local", { sourceHash: window.sourceHash, paragraphRange: [window.paragraphStart, window.paragraphEnd], previous,
      overlap: [...window.contextBefore, ...window.contextAfter].map(i => [i, context.paragraphs[i].text]), nextHeading: window.nextHeading?.heading ?? null,
      roleIdentity: plannerRoleIdentity(context.source) }, config);
    const entry: PlanningAttempt<LocalStructure> = { key, window, messages, status: "pending", cacheHit: false, trace: [], output: null };
    artifact.windows.push(entry);
    if (options.lastWindowIndex !== undefined && artifact.windows.length - 1 > options.lastWindowIndex) {
      entry.error = "Outside explicit local first-pass scope; no cache or model access";
      await hooks.persist(artifact); continue;
    }
    await request(entry, LocalStructureSchema, "local", output => groundLocalStructure(context, window, output, candidates).validation);
    if (entry.status === "success" && entry.output) {
      const grounded = groundLocalStructure(context, window, entry.output, candidates);
      candidates.push(...grounded.candidates); references.push(...grounded.references); previous = compactLocalSummary(grounded);
    } else {
      // Continue other windows, but do not invent context from a failed result.
      previous = { missingWindow: window.id, warning: "Previous local planning unavailable" };
    }
  }
  if (artifact.windows.some(w => w.status !== "success")) return finish(null, makeValidation([errorIssue("LOCAL_PLANNING_INCOMPLETE", "Successful windows are retained and cached; retry only missing/failed dependencies, not semantic repair.")]));
  if (options.lastWindowIndex !== undefined) return finish(null, makeValidation([errorIssue("LOCAL_FIRST_PASS_ONLY", "Explicit window audit never invokes global planning, even with a complete local cache.")]));
  await hooks.assertSource();
  const compactCandidate = ({ branchEvidence: _branchEvidence, ...candidate }: GroundedCandidate) => candidate;
  const facts = { candidates: candidates.map(compactCandidate), references };
  const compactLength = JSON.stringify(facts).length;
  let payload: unknown = facts;
  // Bound global input using act-neighbour batches, then reconcile only compact relationships.
  if (compactLength > 12000) {
    const batches: GroundedCandidate[][] = []; let batch: GroundedCandidate[] = [];
    for (const c of candidates) {
      if (batch.length && JSON.stringify([...batch, c]).length > 8000) { batches.push(batch); batch = []; }
      batch.push(c);
    }
    if (batch.length) batches.push(batch);
    for (const batch of batches) {
      const low = Math.min(...batch.map(c => c.paragraphStart)), high = Math.max(...batch.map(c => c.paragraphEnd));
      const localFacts = { candidates: batch.map(compactCandidate), references: references.filter(r => r.paragraph >= low && r.paragraph <= high), scope: "act-neighbour reconciliation; unresolved variants may continue in following batches" };
      const entry: PlanningAttempt<GlobalRelations> = { key: planningCacheKey(context, "global", localFacts, config), status: "pending", cacheHit: false, messages: globalPlanningPrompt(context, localFacts), trace: [], output: null };
      artifact.global.push(entry); await request(entry, GlobalRelationsSchema, "global", output => validateGlobalSource(batch, localFacts.references, output));
      if (entry.status !== "success") return finish(null, makeValidation([errorIssue("GLOBAL_PLANNING_FAILED", entry.error ?? "Act-level reconciliation failed; local results retained")]));
    }
    let summaries = artifact.global.map(g => g.output!);
    const unresolvedBranches = candidates.filter(c => c.relation !== "none").map(c => ({ id: c.id, variantGroupCandidateId: c.variantGroupCandidateId, branchId: c.branchId,
      relation: c.relation, variantAmbiguity: c.variantAmbiguity, branchLabel: c.branchLabel, variantHint: c.variantHint, continuationHint: c.continuationHint }));
    payload = { summaries, unresolvedBranches, references };
    for (let depth = 0; JSON.stringify(payload).length > 12000 && depth < 3; depth++) {
      const packs: GlobalRelations[][] = []; let pack: GlobalRelations[] = [];
      for (const summary of summaries) {
        if (pack.length && JSON.stringify([...pack, summary]).length > 6500) { packs.push(pack); pack = []; }
        pack.push(summary);
      }
      if (pack.length) packs.push(pack);
      if (packs.length >= summaries.length) return finish(null, makeValidation([errorIssue("GLOBAL_INPUT_TOO_LARGE", "Relationship summaries cannot be reduced safely; local results retained")]));
      const reduced: GlobalRelations[] = [];
      for (const pack of packs) {
        const memberIds = new Set(pack.flatMap(s => s.groups.flatMap(g => g.candidateIds))), memberRefs = references.filter(r => pack.some(s => s.aliases.some(a => a.referenceIds.includes(r.id))));
        const packFacts = { summaries: pack, unresolvedBranches: unresolvedBranches.filter(c => memberIds.has(c.id)), references: memberRefs };
        const entry: PlanningAttempt<GlobalRelations> = { key: planningCacheKey(context, "global", packFacts, config), status: "pending", cacheHit: false, messages: globalPlanningPrompt(context, packFacts), trace: [], output: null };
        artifact.global.push(entry); await request(entry, GlobalRelationsSchema, "global", output => validateGlobalSource(candidates.filter(c => memberIds.has(c.id)), memberRefs, output));
        if (entry.status !== "success" || !entry.output) return finish(null, makeValidation([errorIssue("GLOBAL_PLANNING_FAILED", entry.error ?? "Intermediate reconciliation failed")]));
        reduced.push(entry.output);
      }
      const nextPayload = { summaries: reduced, unresolvedBranches, references };
      if (JSON.stringify(nextPayload).length >= JSON.stringify(payload).length) return finish(null, makeValidation([errorIssue("GLOBAL_INPUT_TOO_LARGE", "No safe compact reduction; never resend whole manual")]));
      summaries = reduced; payload = nextPayload;
    }
    if (JSON.stringify(payload).length > 16000) return finish(null, makeValidation([errorIssue("GLOBAL_INPUT_TOO_LARGE", "Bounded hierarchy exhausted; retain local/act summaries")]));
  }
  const globalEntry: PlanningAttempt<GlobalRelations> = { key: planningCacheKey(context, "global", { payload, localFingerprint: fingerprint(facts) }, config), messages: globalPlanningPrompt(context, payload), status: "pending", cacheHit: false, trace: [], output: null };
  artifact.global.push(globalEntry);
  await request(globalEntry, GlobalRelationsSchema, "global", output => {
    try { return makeValidation(reconcilePlan(context, end, candidates, references, output).validation.errors.filter(e => e.code.startsWith("GLOBAL_"))); }
    catch (e) { return makeValidation([errorIssue("GLOBAL_PLAN_UNGROUNDED_REGION", String(e))]); }
  });
  if (globalEntry.status !== "success" || !globalEntry.output) return finish(null, makeValidation([errorIssue("GLOBAL_PLANNING_FAILED", globalEntry.error ?? "Global reconciliation failed; local results retained")]));
  try {
    const reconciled = reconcilePlan(context, end, candidates, references, globalEntry.output);
    await hooks.assertSource();
    const fenceErrors = reconciled.validation.errors.filter(i => i.code.startsWith("GLOBAL_"));
    if (fenceErrors.length) return finish(null, reconciled.validation);
    return finish(reconciled.plan, reconciled.validation);
  } catch (e) { return finish(null, makeValidation([errorIssue("GLOBAL_PLAN_UNGROUNDED_REGION", e instanceof Error ? e.message : String(e))])); }
}

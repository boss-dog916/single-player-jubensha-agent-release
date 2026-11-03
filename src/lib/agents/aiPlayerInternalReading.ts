import "server-only";
import { randomUUID } from "node:crypto";

import { generateStructured } from "@/src/lib/llm/llmClient";
import { buildAiPlayerInternalReadingPrompt } from "@/src/lib/prompts/aiPlayerInternalReadingPrompt";
import { AiInternalReadingSchema, type AiInternalReadingOutput } from "@/src/lib/schemas/aiInternalReadingSchema";
import type { RoleId } from "@/src/lib/script/scriptTypes";
import { buildAiPlayerContext, getGameSession } from "@/src/lib/services/gameService";
import { getLatestAgentRunForRole } from "@/src/lib/services/agentRunService";
import { prisma } from "@/src/lib/db/prisma";
import { getRuntimeReadingSourcesForGameSession } from "@/src/lib/services/runtimeDefinitionSessionService";
import { combineReadingBooklets } from "@/src/lib/services/runtimeReadingSources";
import { readingSourceReceiptsComplete } from "@/src/lib/services/runtimeReadingService";
import { fromJsonValue, toJsonInput } from "@/src/lib/services/jsonFields";
import { getTraceContext } from "@/src/lib/observability/traceContext";
import {
  createEmptyRoleMemory,
  getRoleMemory,
  updateInternalReadingRecord,
  upsertRoleMemory
} from "@/src/lib/services/roleMemoryService";
import type { InternalReadingRecord, RoleMemory } from "@/src/lib/types/game";

export type RunAiPlayerInternalReadingInput = {
  gameSessionId: string;
  roleId: RoleId;
  mockOutput?: unknown;
};

export type RunAiPlayerInternalReadingResult = {
  roleId: RoleId;
  output: AiInternalReadingOutput;
  memory: RoleMemory;
  agentRunId: string;
  skipped?: boolean;
};

export type RunAiInternalReadingForAllResult = {
  actId: string;
  status: "completed" | "failed";
  results: RunAiPlayerInternalReadingResult[];
  failures: Array<{
    roleId: RoleId;
    errorMessage: string;
    agentRunId?: string | null;
  }>;
};

export async function runAiPlayerInternalReading({
  gameSessionId,
  roleId,
  mockOutput
}: RunAiPlayerInternalReadingInput): Promise<RunAiPlayerInternalReadingResult> {
  const session = await getGameSession(gameSessionId);
  if (session.runtimeDefinitionId && await (await import("@/src/lib/services/runtimeModelPolicy")).runtimeModelsDisabled(gameSessionId))
    return acknowledgeNoModelReading(gameSessionId, roleId);
  if (session.runtimeDefinitionId) return loadRuntimeBooklet(gameSessionId, roleId, session.runtimeDefinitionId);
  const context = await buildAiPlayerContext(gameSessionId, roleId);
  const existing = context.roleMemory.internal_readings?.[context.act_id];

  if (existing?.status === "completed" || existing?.status === "running") {
    if (existing.status === "completed") await prepareDraftsAfterReading(gameSessionId);
    return {
      roleId,
      output: createOutputFromMemory(context.roleMemory),
      memory: context.roleMemory,
      agentRunId: existing.agentRunId ?? "",
      skipped: true
    };
  }

  // The bundled demo already has structured, scoped booklets. Like published
  // Runtime reading, loading these facts needs no model-generated summary.
  const demo = !session.scriptPackageId || (await prisma.scriptPackage.findUnique({
    where: { id: session.scriptPackageId }, select: { slug: true }
  }))?.slug === "demo-script";
  if (demo) return loadDemoBooklet(gameSessionId, roleId, context);

  const readingStartedAt = new Date().toISOString();
  await updateInternalReadingRecord(gameSessionId, roleId, context.act_id, {
    status: "running",
    agentRunId: existing?.agentRunId ?? null,
    errorMessage: null,
    startedAt: readingStartedAt,
    completedAt: null
  });

  let agentRunId: string | null = null;

  try {
    const result = await generateStructured<AiInternalReadingOutput>({
      gameSessionId,
      agentType: "ai_player_internal_reading",
      roleId,
      actId: context.act_id,
      phase: "ai_internal_reading",
      schemaName: "ai_internal_reading",
      zodSchema: AiInternalReadingSchema,
      messages: buildAiPlayerInternalReadingPrompt(context),
      mockOutput: mockOutput ?? createBookletReadingOutput(context)
    });
    agentRunId = result.agentRunId;
    const memory = await upsertRoleMemory({
      gameSessionId,
      roleId,
      memory: mergeRoleMemory(
        await getRoleMemory(gameSessionId, roleId),
        result.data,
        {
          status: "completed",
          agentRunId: result.agentRunId,
          errorMessage: null,
          startedAt: readingStartedAt,
          completedAt: new Date().toISOString()
        },
        context.act_id
      )
    });

    await prepareDraftsAfterReading(gameSessionId);
    return {
      roleId,
      output: result.data,
      memory,
      agentRunId: result.agentRunId
    };
  } catch (error) {
    const latestRun = await getLatestAgentRunForRole({
      gameSessionId,
      agentType: "ai_player_internal_reading",
      roleId,
      actId: context.act_id
    });
    const message = error instanceof Error ? error.message : "AI internal reading failed.";

    await updateInternalReadingRecord(gameSessionId, roleId, context.act_id, {
      status: "failed",
      agentRunId: agentRunId ?? latestRun?.id ?? null,
      errorMessage: message,
      startedAt: readingStartedAt,
      completedAt: new Date().toISOString()
    });

    throw error;
  }
}

async function loadDemoBooklet(gameSessionId: string, roleId: RoleId,
  context: Awaited<ReturnType<typeof buildAiPlayerContext>>): Promise<RunAiPlayerInternalReadingResult> {
  const started = new Date(), runId = randomUUID();
  const trace = getTraceContext();
  const row = await prisma.roleMemory.findUniqueOrThrow({ where: { gameSessionId_roleId: { gameSessionId, roleId } } });
  const current = fromJsonValue<RoleMemory>(row.memory, createEmptyRoleMemory());
  if (current.internal_readings?.[context.act_id]?.status === "completed")
    return { roleId, output: createOutputFromMemory(current), memory: current,
      agentRunId: current.internal_readings[context.act_id].agentRunId ?? "", skipped: true };
  const output = AiInternalReadingSchema.parse({ ...createBookletReadingOutput({ ...context, roleMemory: current }),
    private_memory_update: JSON.stringify({ roleId, actId: context.act_id, privateText: context.private_text }) });
  const finished = new Date();
  const memory = mergeRoleMemory(current, output, { status: "completed", agentRunId: runId,
    errorMessage: null, startedAt: started.toISOString(), completedAt: finished.toISOString() }, context.act_id);
  try {
    await prisma.$transaction([
      prisma.roleMemory.update({ where: { id: row.id, memory: row.memory, gameSession: {
        runtimeDefinitionId: null, currentActId: context.act_id, currentPhase: { in: ["reading", "ai_internal_reading"] },
        userRoleId: { not: roleId }
      } }, data: { memory: toJsonInput(memory) } }),
      prisma.agentRun.create({ data: { id: runId, gameSessionId, roleId, actId: context.act_id,
        phase: "ai_internal_reading", agentType: "ai_player_internal_reading", runKind: "span", status: "success",
        traceId: trace?.traceId ?? null, parentRunId: trace?.parentRunId ?? null,
        input: toJsonInput({ source: "demo_booklet", actId: context.act_id, roleId }),
        output: toJsonInput({ completed: true, source: "demo_booklet", llmInvoked: false, privateTextChars: context.private_text.length }),
        startedAt: started, finishedAt: finished, latencyMs: finished.getTime() - started.getTime() } })
    ]);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "P2025")) throw error;
    const latest = await getGameSession(gameSessionId), loaded = await getRoleMemory(gameSessionId, roleId);
    const receipt = loaded.internal_readings?.[context.act_id];
    if (latest.currentActId !== context.act_id || latest.runtimeDefinitionId || receipt?.status !== "completed")
      throw new Error("Reading scope changed; no stale demo booklet was committed");
    return { roleId, output: createOutputFromMemory(loaded), memory: loaded, agentRunId: receipt.agentRunId ?? "", skipped: true };
  }
  await prepareDraftsAfterReading(gameSessionId);
  return { roleId, output, memory, agentRunId: runId };
}

// Published Runtime already contains the authoritative, scoped role knowledge.
// Loading it is not summarization or semantic inference. Preserve every source
// field privately; do not copy public chat, other roles or future acts into it.
async function loadRuntimeBooklet(gameSessionId: string, roleId: RoleId, definitionId: string): Promise<RunAiPlayerInternalReadingResult> {
  const started = Date.now();
  const context = await buildAiPlayerContext(gameSessionId, roleId);
  const actIndex = Number(context.act_id.match(/^runtime_act_(\d+)$/)?.[1]);
  const sources = (await getRuntimeReadingSourcesForGameSession({ gameSessionId, roleName: roleId, actIndex }))?.booklets ?? [];
  const booklet = combineReadingBooklets(sources);
  if (!booklet?.privateText.trim()) throw new Error("Current role's published booklet is missing or empty");
  const trace = getTraceContext();
  const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: gameSessionId } });
  if (session.runtimeDefinitionId !== definitionId || session.currentActId !== context.act_id ||
    !["reading", "ai_internal_reading"].includes(session.currentPhase) || session.userRoleId === roleId ||
    !fromJsonValue<string[]>(session.aiRoleIds, []).includes(roleId)) throw new Error("Reading scope changed before loading role knowledge");
  const row = await prisma.roleMemory.findUniqueOrThrow({ where: { gameSessionId_roleId: { gameSessionId, roleId } } });
  const current = { ...createEmptyRoleMemory(), ...fromJsonValue<RoleMemory>(row.memory, createEmptyRoleMemory()) };
  const receipt = current.internal_readings?.[context.act_id];
  if (readingSourceReceiptsComplete(receipt, sources.map(b => b.sourceRoleActBookletId)) ||
    receipt?.status === "completed" && !receipt.sourceReadings && sources.length === 1 && !sources[0].bookKey) return { roleId, output: createOutputFromMemory(current), memory: current, agentRunId: receipt?.agentRunId ?? "", skipped: true };
  const speakable = [...booklet.mustShare, ...booklet.mayShare];
  const tone = booklet.emotionalPoints.join("；") || current.emotional_state || "谨慎观察";
  const output = AiInternalReadingSchema.parse({
    private_memory_update: JSON.stringify({ roleId, actId: context.act_id, privateText: booklet.privateText,
      emotionalPoints: booklet.emotionalPoints, relationshipPoints: booklet.relationshipPoints, timelineFragments: booklet.timelineFragments }),
    beliefs: current.beliefs, emotional_state: tone, unresolved_questions: current.unresolved_questions ?? [],
    share_intentions: { must_share_summary: booklet.mustShare, may_share_summary: booklet.mayShare, must_not_share_reminder: booklet.mustNotShare },
    share_plan: { must_mention: booklet.mustShare, emotional_tone: tone, safe_boundaries: booklet.mustNotShare, possible_opening: null },
    reaction_profile: { known_event_tags: [...new Set([...speakable, ...extractTags(speakable)])],
      related_role_ids: current.reaction_profile?.related_role_ids ?? [], emotional_triggers: booklet.emotionalPoints,
      unresolved_questions: current.unresolved_questions ?? [], current_act_speakable_topics: speakable,
      forbidden_boundaries_summary: booklet.mustNotShare }
  });
  const now = new Date(), runId = randomUUID();
  const memory = mergeRoleMemory(current, output, { status: "completed", agentRunId: runId, errorMessage: null,
    startedAt: new Date(started).toISOString(), completedAt: now.toISOString(),
    sourceReadings: sources.map(b => ({ sourceId: b.sourceRoleActBookletId, completedAt: now.toISOString() })) }, context.act_id);
  try {
    // A short batch transaction avoids holding SQLite's writer lock across JS
    // callbacks. Extended unique WHERE is a compare-and-swap: a stale refresh
    // fails and rolls back both the knowledge write and the loading receipt.
    await prisma.$transaction([
      prisma.roleMemory.update({ where: { id: row.id, memory: row.memory,
        gameSession: { runtimeDefinitionId: definitionId, currentActId: context.act_id,
          currentPhase: { in: ["reading", "ai_internal_reading"] }, dmFlowCursorJson: session.dmFlowCursorJson, aiRoleIds: session.aiRoleIds, userRoleId: session.userRoleId } },
        data: { memory: toJsonInput(memory) } }),
      // Trace contains only a loading receipt, never this private knowledge body.
      prisma.agentRun.create({ data: { id: runId, gameSessionId, roleId, actId: context.act_id, phase: "ai_internal_reading",
        agentType: "ai_player_internal_reading", runKind: "span", model: null, status: "success", retryCount: 0,
        traceId: trace?.traceId ?? null, parentRunId: trace?.parentRunId ?? null,
        input: toJsonInput({ source: "runtime_booklet", definitionId, actId: context.act_id, roleId }),
        output: toJsonInput({ completed: true, source: "runtime_booklet", llmInvoked: false, privateTextChars: booklet.privateText.length, sourceIds: sources.map(b => b.sourceRoleActBookletId) }),
        startedAt: new Date(started), finishedAt: now, latencyMs: now.getTime() - started } })
    ]);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "P2025")) throw error;
    const loaded = await getRoleMemory(gameSessionId, roleId), receipt = loaded.internal_readings?.[context.act_id];
    const latestSession = await getGameSession(gameSessionId);
    if (!readingSourceReceiptsComplete(receipt, sources.map(b => b.sourceRoleActBookletId)) || latestSession.runtimeDefinitionId !== definitionId || latestSession.currentActId !== context.act_id)
      throw new Error("Reading scope or memory changed; no stale knowledge was committed");
    return { roleId, output: createOutputFromMemory(loaded), memory: loaded, agentRunId: receipt?.agentRunId ?? "", skipped: true };
  }
  await prepareDraftsAfterReading(gameSessionId);
  return { roleId, output, memory, agentRunId: runId };
}

async function prepareDraftsAfterReading(gameId: string) {
  if (process.env.SHARE_DRAFT_ENABLED !== "true") return;
  const { ensureShareDrafts, scheduleShareDraftDrain } = await import("@/src/lib/services/shareDraftService");
  await ensureShareDrafts(gameId).then(() => scheduleShareDraftDrain(gameId)).catch((error) => {
    console.error("ShareDraft preparation failed; internal reading remains completed", error);
  });
}

export async function runAiInternalReadingForAllAiPlayers(
  gameSessionId: string
): Promise<RunAiInternalReadingForAllResult> {
  const session = await getGameSession(gameSessionId);

  if (session.currentPhase !== "reading" && session.currentPhase !== "ai_internal_reading") {
    throw new Error(`AI internal_reading can only run during reading or ai_internal_reading phase.`);
  }

  const settled = await Promise.allSettled(
    session.aiRoleIds.map((roleId) => runAiPlayerInternalReading({ gameSessionId, roleId }))
  );
  const results: RunAiPlayerInternalReadingResult[] = [];
  const failures: RunAiInternalReadingForAllResult["failures"] = [];

  settled.forEach((result, index) => {
    const roleId = session.aiRoleIds[index];

    if (!roleId) {
      return;
    }

    if (result.status === "fulfilled") {
      results.push(result.value);
      return;
    }

    failures.push({
      roleId,
      errorMessage:
        result.reason instanceof Error ? result.reason.message : "AI internal reading failed."
    });
  });

  return {
    actId: session.currentActId,
    status: failures.length === 0 ? "completed" : "failed",
    results,
    failures
  };
}

function mergeRoleMemory(
  current: RoleMemory,
  output: AiInternalReadingOutput,
  status: InternalReadingRecord,
  actId: string
): RoleMemory {
  return {
    ...current,
    private_memory_so_far: [
      ...current.private_memory_so_far,
      output.private_memory_update
    ],
    beliefs: output.beliefs,
    emotional_state: output.emotional_state,
    unresolved_questions: output.unresolved_questions,
    share_intentions: output.share_intentions,
    share_plan: output.share_plan,
    reaction_profile: output.reaction_profile,
    internal_readings: {
      ...(current.internal_readings ?? {}),
      [actId]: status
    }
  };
}

function createOutputFromMemory(memory: RoleMemory): AiInternalReadingOutput {
  return {
    private_memory_update: memory.private_memory_so_far.at(-1) ?? "已完成当前幕私下阅读。",
    beliefs: memory.beliefs,
    emotional_state: memory.emotional_state,
    unresolved_questions: memory.unresolved_questions ?? [],
    share_intentions: memory.share_intentions ?? {
      must_share_summary: [],
      may_share_summary: [],
      must_not_share_reminder: []
    },
    share_plan: memory.share_plan ?? {
      must_mention: [],
      emotional_tone: memory.emotional_state,
      safe_boundaries: [],
      possible_opening: null
    },
    reaction_profile: memory.reaction_profile ?? {
      known_event_tags: [],
      related_role_ids: [],
      emotional_triggers: [],
      unresolved_questions: memory.unresolved_questions ?? [],
      current_act_speakable_topics: [],
      forbidden_boundaries_summary: []
    }
  };
}

function createBookletReadingOutput(
  context: Awaited<ReturnType<typeof buildAiPlayerContext>>
): AiInternalReadingOutput {
  return {
    private_memory_update: `阅读 ${context.act_id} 后，${context.role_id} 记下了自己的当前幕私密信息。`,
    beliefs: context.roleMemory.beliefs,
    emotional_state: context.roleMemory.emotional_state || "谨慎观察",
    unresolved_questions: context.roleMemory.unresolved_questions ?? [],
    share_intentions: {
      must_share_summary: context.must_share,
      may_share_summary: context.may_share,
      must_not_share_reminder: context.must_not_share
    },
    share_plan: {
      must_mention: context.must_share,
      emotional_tone: context.roleMemory.emotional_state || "谨慎而克制",
      safe_boundaries: context.must_not_share,
      possible_opening: context.must_share[0]
        ? `我先说一件我能确认的事：${context.must_share[0]}`
        : "我先把我当前能公开确认的信息说出来。"
    },
    reaction_profile: {
      known_event_tags: extractTags([...context.must_share, ...context.may_share]),
      related_role_ids: [],
      emotional_triggers: context.may_share,
      unresolved_questions: context.roleMemory.unresolved_questions ?? [],
      current_act_speakable_topics: extractTags([...context.must_share, ...context.may_share]),
      forbidden_boundaries_summary: context.must_not_share
    }
  };
}

function extractTags(items: string[]): string[] {
  return Array.from(
    new Set(
      items
        .flatMap((item) => item.split(/[，。；、\s]+/))
        .map((item) => item.trim())
        .filter((item) => item.length >= 2)
        .slice(0, 8)
    )
  );
}

async function acknowledgeNoModelReading(gameSessionId: string, roleId: string): Promise<RunAiPlayerInternalReadingResult> {
  const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: gameSessionId } });
  if (!["reading", "ai_internal_reading"].includes(session.currentPhase) || !fromJsonValue<string[]>(session.aiRoleIds, []).includes(roleId)) throw new Error("Invalid deterministic reading actor");
  const sources = await getRuntimeReadingSourcesForGameSession({ gameSessionId, roleName: roleId, actIndex: Number(session.currentActId.replace("runtime_act_", "")) });
  const ids = sources?.displays.map(p => p.sourceDocumentSectionId) ?? [];
  if (!ids.length) throw new Error("Missing authorized epilogue PDFs");
  const row = await prisma.roleMemory.findUniqueOrThrow({ where: { gameSessionId_roleId: { gameSessionId, roleId } } });
  const current = { ...createEmptyRoleMemory(), ...fromJsonValue<RoleMemory>(row.memory, createEmptyRoleMemory()) };
  const old = current.internal_readings?.[session.currentActId];
  if (readingSourceReceiptsComplete(old, ids)) return { roleId, memory: current, output: createOutputFromMemory(current), agentRunId: old!.agentRunId!, skipped: true };
  const now = new Date(), runId = randomUUID();
  const memory = { ...current, internal_readings: { ...current.internal_readings, [session.currentActId]: { status: "completed" as const, agentRunId: runId,
    errorMessage: null, startedAt: now.toISOString(), completedAt: now.toISOString(), sourceReadings: ids.map(sourceId => ({ sourceId, completedAt: now.toISOString() })) } } };
  try {
    await prisma.$transaction([
      prisma.roleMemory.update({ where: { id: row.id, memory: row.memory, gameSession: { currentActId: session.currentActId, runtimeDefinitionId: session.runtimeDefinitionId,
        currentPhase: { in: ["reading", "ai_internal_reading"] }, dmFlowCursorJson: session.dmFlowCursorJson } }, data: { memory: toJsonInput(memory) } }),
      prisma.agentRun.create({ data: { id: runId, gameSessionId, roleId, actId: session.currentActId, phase: "ai_internal_reading", agentType: "ai_player_internal_reading",
        runKind: "span", status: "success", model: null, startedAt: now, finishedAt: now, latencyMs: 0, input: "{}",
        output: toJsonInput({ source: "no_model_pdf_acknowledgement", llmInvoked: false, comprehensionClaimed: false, sourceIds: ids }) } })
    ]);
  } catch (error) {
    const fresh = await getRoleMemory(gameSessionId, roleId);
    if (!readingSourceReceiptsComplete(fresh.internal_readings?.[session.currentActId], ids)) throw error;
    return { roleId, memory: fresh, output: createOutputFromMemory(fresh), agentRunId: fresh.internal_readings![session.currentActId].agentRunId!, skipped: true };
  }
  return { roleId, memory, output: createOutputFromMemory(memory), agentRunId: runId };
}

import { ManualActivityExtractionSchema, ACTIVITY_WIRE_VERSION, activityExtractionGrammar } from "@/src/lib/schemas/manualActivityExtractionSchema";
import { ManualActivityIRSchema, type ManualActivityIR } from "@/src/lib/schemas/manualActivityIRSchema";
import { activityExtractionMessages, ACTIVITY_PROMPT_VERSION } from "@/src/lib/prompts/manualActivityExtractionPrompt";
import { resolveTaskModelProfile } from "@/src/lib/llm/taskModelProfiles";
import { providerConnection, redactLlmSecrets } from "@/src/lib/llm/providerAdapter";
import { activitySourceEvidence, type ActivitySourcePack } from "./manualActivitySourcePreparation";
import { activityTextHash, validateManualActivityIR } from "./manualActivityValidation";

const completion = { READ: "reading_confirmed", DISCUSS: "discussion_checkpoint", DM_INTERVENE: "inputs_recorded", PERFORM: "performance_finished",
  PRIVATE_INTERACTION: "private_finished", PLAYER_CHOICE: "inputs_recorded", RESOURCE_ACTION: "resource_committed", TRANSITION: "transitioned" };
const extraRefKeys = new Set(["storyRole", "speakingPersona", "participants", "confirmationsFrom", "firstApplicablePhase", "duePhase", "entryCondition", "exceptions", "preferredOrder", "fallbackOrder", "option"]);
type Obj = Record<string, unknown>;
export function hydrateActivityCandidate(wire: Obj, pack: ActivitySourcePack): ManualActivityIR {
  const prefix = `activity_${pack.fixture}_${pack.sourceFingerprint.slice(0, 12)}_`;
  const stable = (symbol: string) => prefix + activityTextHash(symbol).slice(0, 20);
  const ids = new Set<string>();
  function hydrate(value: unknown, key = "", index = 0): unknown {
    if (key === "sourceEvidence" || key === "bindingEvidence") return (value as string[]).map(ref => activitySourceEvidence(pack, ref));
    if (Array.isArray(value)) return value.map((v, i) => hydrate(v, key, i));
    if (value && typeof value === "object") {
      const o = value as Obj;
      if (typeof o.id === "string") {
        if (ids.has(o.id)) throw new Error(`DUPLICATE_ID: ${o.id}`);
        ids.add(o.id);
      }
      const result = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, hydrate(v, k)]));
      if (["phases", "activities", "beats"].includes(key)) result.order = index;
      if (key === "activities") result.completion = completion[o.kind as keyof typeof completion];
      return result;
    }
    if (typeof value === "string" && (key === "id" || /Refs?$/.test(key) && key !== "capabilityRef" || extraRefKeys.has(key))) return stable(value);
    return value;
  }
  // Check issue provenance too, even though issues are not part of executable IR.
  for (const issue of wire.unresolvedIssues as Obj[]) for (const ref of issue.sourceEvidence as string[]) activitySourceEvidence(pack, ref);
  if (pack.fixture === "B") {
    const mainEntities = [...wire.actors as Obj[], ...wire.configurations as Obj[], ...wire.phases as Obj[]];
    for (const phase of wire.phases as Obj[]) mainEntities.push(...phase.activities as Obj[]);
    for (const entity of mainEntities) if ((entity.sourceEvidence as string[]).some(ref => ["p40", "p41"].includes(ref)))
      throw new Error(`CROSS_REFERENCE_SCOPE: ${String(entity.id)}`);
  }
  const { unresolvedIssues: _issues, ...candidate } = wire;
  const hydrated = hydrate(candidate) as Obj;
  const d = pack.corpus[0];
  hydrated.sourceManifest = [{ documentId: d.documentId, revision: d.revision, sourceHash: d.sourceHash, textHash: pack.normalizedTextHash,
    locatorVersion: d.locatorVersion, layoutFidelity: "unsupported" }];
  return ManualActivityIRSchema.parse(hydrated);
}
export function prepareActivityRequest(pack: ActivitySourcePack) {
  const profile = resolveTaskModelProfile("manual_activity_extractor");
  const messages = activityExtractionMessages(pack);
  const contract = activityExtractionGrammar();
  const request = { model: profile.model, messages, temperature: profile.temperature, max_tokens: profile.maxOutputTokens,
    enable_thinking: false, response_format: { type: "json_object" } };
  return { profile, request, promptChars: messages.reduce((s, m) => s + m.content.length, 0),
    fingerprint: activityTextHash(JSON.stringify({ sourceFingerprint: pack.sourceFingerprint, profile, schemaVersion: "manual_activity_v1",
      wireVersion: ACTIVITY_WIRE_VERSION, promptVersion: ACTIVITY_PROMPT_VERSION, grammar: contract.text, request })) };
}
export function inspectActivityResponse(text: string, pack: ActivitySourcePack) {
  let parsed: unknown = null, candidate: ManualActivityIR | null = null;
  const stages: Array<{ stage: string; status: "PASS" | "FAIL" | "NOT_RUN"; details?: unknown }> = [];
  try { parsed = JSON.parse(text); stages.push({ stage: "json", status: "PASS" }); }
  catch (error) { stages.push({ stage: "json", status: "FAIL", details: String(error) }); }
  let wire: Obj | null = null;
  if (stages[0].status === "PASS") {
    const result = ManualActivityExtractionSchema.safeParse(parsed);
    stages.push({ stage: "wire_zod", status: result.success ? "PASS" : "FAIL", details: result.success ? undefined : result.error.issues });
    if (result.success) wire = result.data;
  }
  if (wire) {
    try { candidate = hydrateActivityCandidate(wire, pack); stages.push({ stage: "source_fence_and_hydrated_zod", status: "PASS" }); }
    catch (error) { stages.push({ stage: "source_fence_and_hydrated_zod", status: "FAIL", details: String(error) }); }
  }
  const semantic = candidate ? validateManualActivityIR(candidate, pack.corpus) : null;
  if (semantic) stages.push({ stage: "semantic_references_privacy_config_choice_assets_disclosure", status: semantic.status === "invalid" ? "FAIL" : "PASS", details: semantic });
  stages.push({ stage: "human_ground_truth", status: "NOT_RUN" });
  return { parsed, candidate, semantic, unresolvedIssues: wire?.unresolvedIssues ?? null, stages,
    status: candidate && semantic?.status !== "invalid" ? "REQUIRES_HUMAN_REVIEW" : "FAIL",
    stopFurtherLiveCalls: !candidate || semantic?.status === "invalid" };
}

export type ActivityTransportResult = { status: number; rawBody: string; headersAtMs: number; requestId: string | null };
export function assertActivityFollowupAllowed(previous: { fingerprint?: string; error?: unknown; finishReason?: unknown;
  validation?: { status?: string; stopFurtherLiveCalls?: boolean } }, review: { allowNextFixture?: boolean; requestFingerprint?: string; rawArtifactSha256?: string }, artifactSha256: string) {
  if (previous.error || previous.finishReason !== "stop" || previous.validation?.status !== "REQUIRES_HUMAN_REVIEW" || previous.validation.stopFurtherLiveCalls !== false)
    throw new Error("Prior first-pass failed: further live calls blocked");
  if (review.allowNextFixture !== true || review.requestFingerprint !== previous.fingerprint || review.rawArtifactSha256 !== artifactSha256)
    throw new Error("Human review missing/failed/mismatched: further live calls blocked");
}
export type ActivityTransport = (request: ReturnType<typeof prepareActivityRequest>) => Promise<ActivityTransportResult>;
export const fetchActivityCompletion: ActivityTransport = async prepared => {
  const connection = providerConnection("bailian", prepared.profile.model);
  if (!connection.apiKey) throw new Error(`${connection.apiKeyName} is not configured; no runtime fallback`);
  const start = performance.now();
  const response = await fetch(`${prepared.profile.endpointIdentity}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.apiKey}` },
    body: JSON.stringify(prepared.request), signal: AbortSignal.timeout(prepared.profile.timeoutMs)
  });
  const headersAtMs = performance.now() - start;
  return { status: response.status, rawBody: await response.text(), headersAtMs, requestId: response.headers.get("x-request-id") };
};

// Single transport call; no retry/cache lookup, DB, runtime/publish imports or repair.
export async function runActivityFirstPass(pack: ActivitySourcePack, capture: (record: unknown) => Promise<void>, transport: ActivityTransport = fetchActivityCompletion) {
  const prepared = prepareActivityRequest(pack), startedAt = new Date().toISOString(), start = performance.now();
  const record: Obj = { format: "manual_activity_candidate_artifact_v1", candidateOnly: true, coldClientRequest: true,
    schemaVersion: "manual_activity_v1", wireVersion: ACTIVITY_WIRE_VERSION, promptVersion: ACTIVITY_PROMPT_VERSION,
    source: pack, ...prepared, startedAt, attempts: 0, retries: 0, rawResponse: null, rawText: null, parsedResult: null,
    candidate: null, validation: null, usage: null, error: null, ttftMs: null, ttftReason: "non-streaming; headers are NOT TTFT" };
  const save = () => capture(redactLlmSecrets(record));
  await save();
  try {
    record.attempts = 1;
    await save();
    const result = await transport(prepared);
    record.rawResponse = redactLlmSecrets(result.rawBody);
    record.statusCode = result.status; record.headersAtMs = result.headersAtMs; record.providerRequestId = result.requestId;
    record.latencyMs = performance.now() - start;
    await save();
    const envelope = JSON.parse(record.rawResponse as string);
    if (result.status < 200 || result.status >= 300) throw new Error(`Provider HTTP ${result.status}: ${JSON.stringify(envelope.error ?? envelope)}`);
    record.usage = envelope.usage ?? null; record.returnedModel = envelope.model ?? null;
    record.finishReason = envelope.choices?.[0]?.finish_reason ?? null;
    const text = envelope.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("Missing completion text");
    record.rawText = text;
    await save();
    const validation = inspectActivityResponse(text, pack);
    record.parsedResult = validation.parsed; record.candidate = validation.candidate; record.validation = validation;
    if (record.finishReason !== "stop") { record.error = `Non-stop finish reason: ${String(record.finishReason)}`; validation.stopFurtherLiveCalls = true; validation.status = "FAIL"; }
    record.completedAt = new Date().toISOString();
    await save();
    return { record, validation };
  } catch (error) {
    record.latencyMs ??= performance.now() - start;
    record.error = redactLlmSecrets(String(error)); record.completedAt = new Date().toISOString();
    await save();
    return { record, validation: null };
  }
}

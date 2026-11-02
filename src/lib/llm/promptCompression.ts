import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { LOCAL_CONTEXT_HARD_LIMIT, serializedMessageChars } from "./contextBudget";
import { LlmClientError } from "./llmErrors";
import type { LlmMessage } from "./llmTypes";

// A request-local rendering pass, not a memory store or a retrieval policy.
// Unknown prompt shapes are never shortened. All private originals stay intact.
type RecordValue = Record<string, any>;
// Keep SDK routing and shape adapters on one registry to avoid partial opt-in.
export function supportsPromptCompression(agentType: string) {
  return ["discussion_checker", "ai_player_discussion_utterance", "ai_player_reaction_planner"].includes(agentType);
}
const taskContext = (payload: RecordValue): RecordValue => payload.context ?? payload.allowed_inputs ?? payload.compact_reaction_context;
export type CompressionOptions = {
  enabled: boolean; triggerChars: number; targetChars: number;
  modelWindowTokens: number; outputTokens: number; reserveTokens: number;
};
export function compressionOptions(outputTokens = 1500): CompressionOptions {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= min && value <= max ? Math.floor(value) : fallback;
  };
  const triggerChars = integer("AUTO_CONTEXT_TRIGGER_CHARS", 54_000, 10_000, 55_000);
  return {
    enabled: !/^(0|false|off)$/i.test(process.env.AUTO_CONTEXT_COMPRESSION_ENABLED ?? "true"),
    triggerChars,
    targetChars: integer("AUTO_CONTEXT_TARGET_CHARS", Math.min(52_000, triggerChars - 2000), 5000, triggerChars - 2000),
    // Conservative application budget, NOT a claim about a custom API proxy.
    modelWindowTokens: integer("AUTO_CONTEXT_MODEL_WINDOW_TOKENS", 65_536, 8192, 1_000_000),
    outputTokens, reserveTokens: 4096
  };
}
export function estimatePromptTokens(messages: LlmMessage[]) {
  const content = messages.map(m => m.content).join("");
  const ascii = (content.match(/[\x00-\x7f]/g) ?? []).length;
  return Math.ceil((content.length - ascii) + ascii / 4 + messages.length * 12);
}
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const chars = (value: unknown) => value === undefined ? 0 : JSON.stringify(value).length;
const sectionValues = (c: RecordValue, k: RecordValue) => ({
  current_booklet: k.current_role_booklet, historical_booklets: k.historical_booklets,
  allowed_facts: c.allowed_facts, public_messages: k.public_messages, recent_messages: c.recent_messages,
  reaction_profile: c.reaction_profile ?? c.role_reaction_profile, public_claims: k.public_claims, role_memory: c.own_memory,
  public_state_brief_copy: c.public_state_brief ?? c.public_state_brief_ref,
  constraints: [k.restrictions, c.flow_constraints, c.boundaries, k.input_policy, c.current_input_policy],
  identity: [c.identity_anchor, c.role],
  current_question_and_dm: [c.latest_message, c.reply_context, k.reply_context, k.dm_interaction],
  formal_activity: k.public_choice_context,
  memory_connections: c.memory_connections,
  previous_statements: [c.own_act_messages, k.own_previous_statements, k.own_hypotheses],
  candidate_and_risks: [c.candidate, c.semantic_risks]
});
const sectionSizes = (c: RecordValue, k: RecordValue) => Object.fromEntries(Object.entries(sectionValues(c, k)).map(([name, value]) => [name, chars(value)]));
const sectionTokens = (value: unknown) => value === undefined ? 0 : estimatePromptTokens([{ role: "user", content: JSON.stringify(value) }]);
export type CompressionReport = {
  version: "request-sections-v1"; enabled: boolean; supported: boolean; triggered: boolean;
  beforeChars: number; afterChars: number; beforeEstimatedTokens: number; afterEstimatedTokens: number;
  conservativeInputTokens: number; inputTokenBudget: number; outputTokens: number; reserveTokens: number;
  triggerChars: number; targetChars: number; safeCeilingChars: number; targetReached: boolean; durationMs: number; reductionRatio: number;
  sections: Record<string, { beforeChars: number; afterChars: number; reducedChars: number; beforeEstimatedTokens: number; afterEstimatedTokens: number; estimatedTokensSaved: number }>;
  stages: string[]; omittedPublicMessageIds: string[]; protectedHash?: string;
  safetyPassed: boolean; failure?: string;
};

export function compressPrompt(input: {
  agentType: string; messages: LlmMessage[]; protectedPublicMessageIds?: string[];
}, options = compressionOptions()) {
  const started = performance.now(), original = input.messages;
  const inputTokenBudget = Math.max(0, options.modelWindowTokens - options.outputTokens - options.reserveTokens);
  const report: CompressionReport = {
    version: "request-sections-v1", enabled: options.enabled, supported: false, triggered: false,
    beforeChars: serializedMessageChars(original), afterChars: serializedMessageChars(original),
    beforeEstimatedTokens: estimatePromptTokens(original), afterEstimatedTokens: estimatePromptTokens(original),
    conservativeInputTokens: 0, inputTokenBudget, outputTokens: options.outputTokens, reserveTokens: options.reserveTokens,
    triggerChars: options.triggerChars, targetChars: options.targetChars,
    safeCeilingChars: Math.min(options.triggerChars + 3000, LOCAL_CONTEXT_HARD_LIMIT * .95), targetReached: false, durationMs: 0, reductionRatio: 0,
    sections: {}, stages: [], omittedPublicMessageIds: [], safetyPassed: true
  };
  let messages = original;
  const finish = (failure?: string) => {
    report.afterChars = serializedMessageChars(messages); report.afterEstimatedTokens = estimatePromptTokens(messages);
    report.conservativeInputTokens = Math.ceil(report.afterEstimatedTokens * 1.25);
    report.targetReached = report.afterChars <= options.targetChars && report.conservativeInputTokens <= inputTokenBudget * .85;
    report.reductionRatio = 1 - report.afterChars / report.beforeChars;
    report.durationMs = performance.now() - started;
    if (failure) report.failure = failure;
    return { messages, report, error: failure ? new LlmClientError({ type: "context_limit", message: failure }) : undefined };
  };
  if (!options.enabled || !supportsPromptCompression(input.agentType)) return finish();
  const pressure = (ms: LlmMessage[]) => serializedMessageChars(ms) >= options.triggerChars ||
    estimatePromptTokens(ms) * 1.25 >= inputTokenBudget * .92;
  if (!pressure(original)) return finish();
  report.triggered = true;
  // Only the known structured task document may be edited; schema/system/repair stay untouched.
  const index = original.findIndex(m => {
    if (m.role !== "user") return false;
    try { const p = JSON.parse(m.content); return !!(input.agentType === "ai_player_reaction_planner" ? p.compact_reaction_context?.knowledge
      : input.agentType === "discussion_checker" ? p.context?.knowledge : p.allowed_inputs?.current_role_booklet); }
    catch { return false; }
  });
  if (index < 0) return finish("本地上下文无法安全压缩：未识别的任务区段，保留原文，请求尚未发送。");
  report.supported = true;
  const p = JSON.parse(original[index].content), c = taskContext(p), k: RecordValue = c.knowledge ?? c;
  const before = JSON.parse(JSON.stringify(p)), oldC = taskContext(before), oldK = oldC.knowledge ?? oldC;
  const beforeSections = sectionSizes(c, k);
  const beforeSectionTokens = Object.fromEntries(Object.entries(sectionValues(c, k)).map(([name, value]) => [name, sectionTokens(value)]));
  const render = () => { messages = original.map((m, i) => i === index ? { ...m, content: JSON.stringify(p) } : m); };
  const fits = () => serializedMessageChars(messages) <= options.targetChars && estimatePromptTokens(messages) * 1.25 <= inputTokenBudget * .85;
  const safelyFits = () => serializedMessageChars(messages) <= report.safeCeilingChars && estimatePromptTokens(messages) * 1.25 <= inputTokenBudget * .9;

  // Replace only verbatim annotations by exact offsets in the SAME retained original.
  // Permission labels, array indices, source IDs, negation and chronology survive.
  for (const b of k.historical_booklets ?? []) for (const field of ["mustShare", "mayShare"]) {
    b[field] = (b[field] ?? []).map((text: unknown) => {
      if (typeof text !== "string" || typeof b.privateText !== "string") return text;
      const start = b.privateText.indexOf(text), ref = { original_range: [start, start + text.length] };
      return start >= 0 && chars(ref) < chars(text) ? ref : text;
    });
  }
  // Compatibility summaries are not a knowledge whitelist. Remove a copy only
  // when its exact text still exists in a legal original/current annotation.
  const sources = [k.current_role_booklet?.privateText,
    ...(k.current_role_booklet?.mustShare ?? []), ...(k.current_role_booklet?.mayShare ?? []),
    ...(k.historical_booklets ?? []).map((b: RecordValue) => b.privateText)].filter((s): s is string => typeof s === "string");
  const duplicatedFact = (fact: unknown) => typeof fact === "string" && fact.length > 0 && sources.some(s => s.includes(fact));
  if (Array.isArray(c.allowed_facts)) c.allowed_facts = c.allowed_facts.filter((f: unknown) => !duplicatedFact(f));
  const deduplicateMessages = (list: RecordValue[]) => {
    const seen = new Set<string>();
    return list.filter(m => { const key = JSON.stringify(m); if (!m.id || seen.has(key)) return !m.id;
      seen.add(key); return true; });
  };
  k.public_messages = deduplicateMessages(k.public_messages ?? []);
  if (Array.isArray(c.recent_messages)) c.recent_messages = c.recent_messages.filter((m: RecordValue) =>
    !(k.public_messages ?? []).some((s: RecordValue) => s.id === m.id && Object.entries(m).every(([key, value]) => JSON.stringify(s[key]) === JSON.stringify(value))));
  const reactionProfile = c.reaction_profile ?? c.role_reaction_profile;
  if (reactionProfile && k.current_role_booklet && JSON.stringify(reactionProfile.current_act_speakable_topics) ===
    JSON.stringify([...k.current_role_booklet.mustShare, ...k.current_role_booklet.mayShare])) {
    delete reactionProfile.current_act_speakable_topics;
    const prefix = c.knowledge ? "knowledge." : "";
    reactionProfile.current_act_speakable_topics_ref = `${prefix}current_role_booklet.mustShare + ${prefix}current_role_booklet.mayShare`;
  }
  p.context_rendering = "预算触发的同源引用：历史mustShare/mayShare中的original_range=[起,止)为该条privateText的UTF-16原文位置，保留原标签及顺序。全文仍在；current_act_speakable_topics_ref引用当前私本的原分享条目；allowed_facts仅去掉已在合法原文中逐字出现的副本，不能因摘要未列出而拒绝。未改变身份、事实/猜测或有效禁令。";
  // Planner's legacy brief may be an exact second copy of shared public claims.
  // Adapt that alias only; retain differing briefs and all addressing inputs.
  if (c.knowledge && c.public_state_brief && JSON.stringify(c.public_state_brief) === JSON.stringify(k.public_claims)) {
    delete c.public_state_brief;
    c.public_state_brief_ref = "knowledge.public_claims";
    p.context_rendering += "public_state_brief_ref引用同一knowledge.public_claims，原公共说法及事实/推测状态不变。";
  }
  report.stages.push("exact_source_copies"); render();

  // Only older public context outside the caller's EXISTING recent window is
  // eligible. Without that trusted hint, retain every public message.
  const protectedIds = new Set(input.protectedPublicMessageIds ?? (k.public_messages ?? []).map((m: RecordValue) => m.id));
  for (const m of [c.latest_message, c.reply_context, k.reply_context]) if (m?.id) protectedIds.add(m.id);
  for (const link of c.memory_connections ?? []) if (link.public_message_id) protectedIds.add(link.public_message_id);
  // Existing exact evidence/DM/activity references pin their messages too.
  const protectedContext = JSON.stringify([c.latest_message, c.reply_context, k.reply_context, c.candidate,
    c.memory_connections, k.public_claims, k.dm_interaction, k.public_choice_context, k.runtime_clues]);
  const queryGrams = textGrams([c.latest_message?.content, k.dm_interaction?.question, c.candidate?.content].filter(Boolean).join(" "));
  const isRelevant = (m: RecordValue) => {
    if (protectedIds.has(m.id) || (m.id && protectedContext.includes(m.id))) return true;
    if (m.speaker_role_id === "dm" || /clue|question/.test(m.speech_act ?? "") || m.metadata?.revealed_facts?.length) return true;
    const overlap = [...textGrams(m.content ?? "")].filter(g => queryGrams.has(g));
    return overlap.length >= 2;
  };
  // The target is intentionally soft: don't discard protected evidence or pause
  // a safe near-budget request merely to reach 52k. Retain >=5% character margin
  // and 10% estimated-input-token margin, in addition to output+4096 reserve.
  if (!safelyFits()) {
    let omitted = 0;
    for (const m of k.public_messages ?? []) {
      if (omitted < 256 && !fits() && !isRelevant(m)) {
        omitted++;
        report.omittedPublicMessageIds.push(m.id);
        // Bounded pass; never synthesize a "fact" from omitted conversation.
        k.public_messages = (k.public_messages ?? []).filter((s: RecordValue) => s !== m);
        render();
      }
    }
    if (report.omittedPublicMessageIds.length) report.stages.push("older_unrelated_public_messages");
  }
  // Verify a resolved projection: everything except proven copies and explicitly
  // omitted old public messages must be byte-equivalent in its original field.
  const resolved = JSON.parse(JSON.stringify(p)); delete resolved.context_rendering;
  const rc = taskContext(resolved), rk = rc.knowledge ?? rc;
  for (const b of rk.historical_booklets ?? []) for (const field of ["mustShare", "mayShare"]) b[field] = (b[field] ?? []).map((v: any) =>
    v && typeof v === "object" && Array.isArray(v.original_range) ? b.privateText.slice(...v.original_range) : v);
  const resolvedProfile = rc.reaction_profile ?? rc.role_reaction_profile;
  if (resolvedProfile?.current_act_speakable_topics_ref) {
    delete resolvedProfile.current_act_speakable_topics_ref;
    resolvedProfile.current_act_speakable_topics = [...rk.current_role_booklet.mustShare, ...rk.current_role_booklet.mayShare];
  }
  if (rc.public_state_brief_ref === "knowledge.public_claims") {
    delete rc.public_state_brief_ref;
    rc.public_state_brief = rk.public_claims;
  }
  if (Array.isArray(oldC.allowed_facts)) oldC.allowed_facts = oldC.allowed_facts.filter((f: unknown) => !duplicatedFact(f));
  if (Array.isArray(oldC.recent_messages)) oldC.recent_messages = oldC.recent_messages.filter((m: RecordValue) =>
    !(oldK.public_messages ?? []).some((s: RecordValue) => s.id === m.id && Object.entries(m).every(([key, value]) => JSON.stringify(s[key]) === JSON.stringify(value))));
  oldK.public_messages = deduplicateMessages(oldK.public_messages ?? []).filter((m: RecordValue) => !report.omittedPublicMessageIds.includes(m.id));
  report.protectedHash = hash(before); report.safetyPassed = hash(resolved) === report.protectedHash;
  const afterSections = sectionSizes(c, k), afterValues = sectionValues(c, k);
  for (const [name, size] of Object.entries(beforeSections)) {
    const afterChars = afterSections[name], afterEstimatedTokens = sectionTokens(afterValues[name as keyof typeof afterValues]);
    report.sections[name] = { beforeChars: size, afterChars, reducedChars: size - afterChars,
      beforeEstimatedTokens: beforeSectionTokens[name], afterEstimatedTokens, estimatedTokensSaved: beforeSectionTokens[name] - afterEstimatedTokens };
  }
  if (!report.safetyPassed) { messages = original; return finish("本地上下文保护检查失败：不发送压缩请求，原始记忆未修改。"); }
  if (!safelyFits()) {
    const sizes = Object.entries(sectionSizes(c, k)).map(([name, size]) => `${name}=${size}`).join(", ");
    return finish(`本地上下文无法安全压缩：保留区段 ${sizes}；序列化 ${serializedMessageChars(messages)} 字符，压缩目标 ${options.targetChars}，安全预算 ${report.safeCeilingChars}（硬上限 ${LOCAL_CONTEXT_HARD_LIMIT}）；输入Token保守估计 ${Math.ceil(estimatePromptTokens(messages) * 1.25)}，预算 ${inputTokenBudget}，至少保留10%输入余量。完整私本、禁令、当前提问与相关证据未截断，请求尚未发送。`);
  }
  return finish();
}

// Used only to PIN additional old evidence, never to retrieve/delete private memory.
function textGrams(text: string) {
  const clean = text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  return new Set(Array.from({ length: Math.max(0, clean.length - 2) }, (_, i) => clean.slice(i, i + 3)));
}

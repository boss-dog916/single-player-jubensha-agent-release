import type { DiscussionUtteranceContext } from "../agents/aiPlayerDiscussionUtterance";
import { roleDisclosurePolicy, isSoftDisclosurePreference } from "./roleDisclosurePolicy";

/** One view over already authorized readings. This module never reads a
 * definition, another player's memory, or an unselected branch itself. */
export function discussionKnowledge(context: DiscussionUtteranceContext) {
  const history = context.historical_private_knowledge;
  const policy = roleDisclosurePolicy(context);
  return {
    public_choice_context: context.public_choice_context ?? null,
    dm_interaction: context.dm_interaction ?? null,
    current_role_booklet: policy.current,
    disclosure_preferences: policy.preferences,
    disclosure_review_evidence: policy.reviewEvidence,
    reviewed_facts: policy.reviewedFacts,
    public_audience: context.public_audience ?? [],
    historical_booklets: policy.history.map(b => ({
      source_id: b.sourceRoleActBookletId, actId: b.actId, actIndex: b.actIndex,
      privateText: b.privateText, mustShare: b.mustShare, mayShare: b.mayShare, mustNotShare: b.mustNotShare.map(text => policy.restriction(text, b.actIndex))
    })),
    restrictions: [
      ...(context.current_role_booklet?.mustNotShare ?? []).filter(t => !isSoftDisclosurePreference(t)).map((text, i) => ({ id: `current.mustNotShare.${i}`, text: policy.restriction(text, context.current_role_booklet?.actIndex) })),
      ...(history?.restrictions ?? []).flatMap(b => b.mustNotShare.filter(t => !isSoftDisclosurePreference(t)).map((text, i) => ({ id: `${b.bookletId}.mustNotShare.${i}`, text: policy.restriction(text, policy.history.find(h => h.sourceRoleActBookletId === b.bookletId)?.actIndex) }))),
      ...(context.runtime_clues ?? []).filter(c => !c.shareAllowed && !c.publiclyShared)
        .map(c => ({ id: `clue.${c.clueId}`, text: `此私密线索禁止转述：${c.text}` })),
      ...context.role_reaction_profile.forbidden_boundaries_summary.filter(t => !isSoftDisclosurePreference(t)).map((text, i) => ({ id: `profile.boundary.${i}`, text: policy.restriction(text) }))
    ],
    public_messages: [...context.recent_public_messages, ...(context.reply_context && !context.recent_public_messages.some(m => m.id === context.reply_context!.id) ? [context.reply_context] : [])],
    reply_context: context.reply_context ?? null,
    public_claims: context.public_state_brief,
    own_previous_statements: context.own_act_messages ?? [],
    own_hypotheses: (context.own_act_messages ?? []).filter(isTentativeDiscussion),
    runtime_clues: context.runtime_clues ?? [],
    input_policy: context.input_policy ?? null
  };
}
export type DiscussionKnowledge = ReturnType<typeof discussionKnowledge>;

export function ownKnowledgeSources(knowledge: DiscussionKnowledge) {
  return [
    ...knowledge.reviewed_facts,
    ...(knowledge.current_role_booklet ? [{ id: "current.privateText", text: knowledge.current_role_booklet.privateText }] : []),
    ...knowledge.historical_booklets.map(b => ({ id: `${b.source_id}.privateText`, text: b.privateText })),
    // Authored annotations can supply facts not quoted verbatim in privateText.
    ...(knowledge.current_role_booklet ? ["mustShare", "mayShare"].flatMap(field =>
      knowledge.current_role_booklet![field as "mustShare" | "mayShare"].map((text, i) => ({ id: `current.${field}.${i}`, text }))) : []),
    ...knowledge.historical_booklets.flatMap(b => [...b.mustShare, ...b.mayShare].map((text, i) => ({ id: `${b.source_id}.annotation.${i}`, text })))
  ];
}

export function isTentativeDiscussion(text: string) {
  return hasDiscussionHypothesis(text) || /会不会|是否|是不是|难道|[?？]|像不像/.test(text);
}
export function hasDiscussionHypothesis(text: string) {
  return /可能|也许|或许|怀疑|猜测|推测|假设|不确定|好像|似乎|大概|仿佛|说不准|未必|应该是|如果|假如|倘若|(?:会不会|是不是|是否|难道).*(?:同伴|同行|同一|同一个|关系|你就是|就是你)/.test(text);
}
export function normalizeDiscussionText(text: string) {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}
export function discussionOverlap(left: string, right: string) {
  const a = grams(left), b = grams(right);
  return a.size ? [...a].filter(g => b.has(g)).length / a.size : 0;
}
function grams(text: string) {
  const value = normalizeDiscussionText(text);
  return new Set(Array.from({ length: Math.max(0, value.length - 1) }, (_, i) => value.slice(i, i + 2)));
}

export type MemoryConnection = {
  own_source_id: string; own_quote: string; public_message_id: string;
  public_role_id: string; public_quote: string; shared_details: string[];
  status: "hypothesis_to_verify";
};

// A small candidate prefilter, not an identity resolver. It proposes concrete
// source pairs to the existing Planner; no link becomes an objective fact.
export function findMemoryConnections(knowledge: DiscussionKnowledge, latest: {
  id: string; speaker_role_id: string | null; content: string;
}, ownRoleId: string): MemoryConnection[] {
  if (!latest.speaker_role_id || [ownRoleId, "dm", "system"].includes(latest.speaker_role_id)) return [];
  const common = new Set(grams("我们你们他们自己对方当时后来现在之前记得记忆醒来房间一名一个男人女人男性女性一起知道不是没有什么发现看见离开这里那里事情经历觉得确认还有只是已经"));
  const publicGrams = grams(latest.content);
  const matches = ownKnowledgeSources(knowledge).filter(s => s.id.endsWith("privateText")).flatMap(source =>
    source.text.split(/[\r\n]+/).filter(p => p.trim()).flatMap(quote => {
      const shared = [...grams(quote)].filter(g => publicGrams.has(g) && !common.has(g));
      // Generic waking/room/gender words cannot trigger a conversation alone.
      if (shared.length < 5) return [];
      if (knowledge.restrictions.some(r => secretSemanticOverlap(quote, r.text))) return [];
      const alreadyAsked = knowledge.own_previous_statements.some(text => isTentativeDiscussion(text) &&
        shared.filter(g => normalizeDiscussionText(text).includes(g)).length >= Math.max(4, shared.length * .65));
      if (alreadyAsked) return [];
      return [{ own_source_id: source.id, own_quote: quote, public_message_id: latest.id,
        public_role_id: latest.speaker_role_id!, public_quote: latest.content,
        shared_details: shared.slice(0, 12), status: "hypothesis_to_verify" as const }];
    }));
  return matches.sort((a, b) => b.shared_details.length - a.shared_details.length).slice(0, 2);
}

export function protectedText(rule: string) {
  return rule.replace(/^阶段保密：(第六幕前保留秘密。|第六幕前保密。)?/, "")
    .replace(/^此私密线索禁止转述：/, "");
}
export function isGeneralKnowledgeGuard(rule: string) {
  return /^(不得编造|禁止编造|不要编造)/.test(rule);
}
export function secretSemanticOverlap(candidate: string, rule: string) {
  if (isGeneralKnowledgeGuard(rule)) return false;
  // A named corpse can identify the protected person without repeating the
  // words “identity”. Route to the existing semantic check; anonymous scene
  // details are still allowed, rather than automatically blocked.
  if (/(?:尸体|死者|遗体).{0,4}身份/.test(rule) && /尸体|死者|遗体/.test(candidate)) return true;
  const source = protectedText(rule);
  const a = grams(candidate), b = grams(source), shared = [...a].filter(g => b.has(g));
  if (shared.length >= 4 && shared.length / Math.max(1, a.size) >= .28) return true;
  // Topic instructions often describe a relationship rather than quote it.
  const topics = rule.match(/爱人|恋人|凶手|病情|疾病|密码|口令|密钥|作案|杀人|真实身份/g) ?? [];
  const credentials = ["密码", "口令", "暗号", "密钥", "password", "passcode"];
  return topics.some(topic => candidate.includes(topic)) ||
    credentials.some(word => rule.toLowerCase().includes(word)) && credentials.some(word => candidate.toLowerCase().includes(word));
}

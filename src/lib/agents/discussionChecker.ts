import "server-only";

import type { DiscussionUtteranceContext } from "@/src/lib/agents/aiPlayerDiscussionUtterance";
import { generateStructured } from "@/src/lib/llm/llmClient";
import { buildDiscussionCheckerPrompt } from "@/src/lib/prompts/discussionCheckerPrompt";
import type { AiPlayerDiscussionUtteranceOutput } from "@/src/lib/schemas/aiPlayerDiscussionUtteranceSchema";
import {
  CompactDiscussionCheckerSchema,
  type CompactDiscussionCheckerOutput,
  type DiscussionCheckerOutput
} from "@/src/lib/schemas/discussionCheckerSchema";
import type { RoleId } from "@/src/lib/script/scriptTypes";
import {
  completeAgentRun,
  createAgentRun
} from "@/src/lib/services/agentRunService";
import { discussionKnowledge, ownKnowledgeSources, isTentativeDiscussion, protectedText,
  isGeneralKnowledgeGuard, secretSemanticOverlap,
  type DiscussionKnowledge } from "@/src/lib/services/discussionKnowledge";
import { publicDisclosureConflict } from "@/src/lib/services/roleDisclosurePolicy";
import { prisma } from "@/src/lib/db/prisma";

export type DiscussionCheckerMode =
  | "deterministic_pass"
  | "deterministic_fail"
  | "llm_checker";

export type DiscussionCheckerContext = {
  current_act_index?: number;
  knowledge: DiscussionKnowledge;
  flow_constraints: Array<{ id: string; text: string }>;
  semantic_risks?: Array<{ kind: "secret" | "major_fact" | "process"; quote: string; source_id: string }>;
  identity_anchor?: DiscussionUtteranceContext["identity_anchor"];
  max_content_chars?: number;
  role: { role_id: RoleId; name: string };
  action: DiscussionUtteranceContext["selected_reaction"];
  latest_message: {
    speaker_role_id: string | null;
    speech_act: string;
    content: string;
  };
  direct_answer: DiscussionUtteranceContext["direct_answer_mode"];
  boundaries: {
    must_not_share: string[];
    forbidden_summaries: string[];
  };
  allowed_facts: string[];
  candidate: AiPlayerDiscussionUtteranceOutput;
};

export type RunDiscussionCheckerInput = {
  gameSessionId: string;
  roleId: RoleId;
  context: DiscussionUtteranceContext;
  candidate: AiPlayerDiscussionUtteranceOutput;
  attempt?: 1 | 2;
  mockOutput?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type RunDiscussionCheckerResult = {
  roleId: RoleId;
  output: DiscussionCheckerOutput;
  agentRunId: string;
  checkerMode: DiscussionCheckerMode;
  llmInvoked: boolean;
  deterministicLatencyMs: number;
};

type DeterministicDecision = {
  mode: DiscussionCheckerMode;
  output: DiscussionCheckerOutput | null;
  reasons: string[];
};

export async function runDiscussionChecker({
  gameSessionId,
  roleId,
  context,
  candidate,
  attempt = 1,
  mockOutput, timeoutMs, signal
}: RunDiscussionCheckerInput): Promise<RunDiscussionCheckerResult> {
  const deterministicStartedAt = Date.now();
  const checkerContext = buildMinimalCheckerContext(context, candidate);
  const deterministic = evaluateDiscussionCandidate(checkerContext, attempt);
  const deterministicLatencyMs = Date.now() - deterministicStartedAt;

  if (deterministic.mode !== "llm_checker" && deterministic.output) {
    const run = await createAgentRun({
      gameSessionId,
      agentType: "discussion_checker_deterministic",
      roleId,
      actId: context.game_session.currentActId,
      phase: context.game_session.currentPhase,
      runKind: "span",
      inputJson: {
        checkerMode: deterministic.mode,
        attempt,
        candidate: compactCandidate(candidate),
        reasons: deterministic.reasons
      }
    });
    await completeAgentRun({
      agentRunId: run.id,
      outputJson: {
        checkerMode: deterministic.mode,
        deterministicLatencyMs,
        passed: deterministic.output.passed,
        decision: deterministic.output.decision,
        violations: collectIssues(deterministic.output),
        retryHint: deterministic.output.rewrite_advice,
        output: deterministic.output
      },
      checkerResultJson: deterministic.output,
      latencyMs: Date.now() - run.startedAt.getTime()
    });
    return {
      roleId,
      output: deterministic.output,
      agentRunId: run.id,
      checkerMode: deterministic.mode,
      llmInvoked: false,
      deterministicLatencyMs
    };
  }

  const result = await generateStructured<CompactDiscussionCheckerOutput>({
    gameSessionId,
    agentType: "discussion_checker",
    roleId,
    actId: context.game_session.currentActId,
    phase: context.game_session.currentPhase,
    schemaName: "compact_discussion_checker",
    zodSchema: CompactDiscussionCheckerSchema,
    messages: buildDiscussionCheckerPrompt(checkerContext),
    temperature: 0.1,
    maxOutputTokens: 1100,
    reasoningEffort: "none",
    timeoutMs, signal,
    metadata: {
      compressionSafety: { protectedPublicMessageIds: context.recent_public_messages.map(m => m.id) },
      checkerMode: "llm_checker",
      deterministicLatencyMs,
      escalationReasons: deterministic.reasons,
      attempt,
      reasoningMode: "none"
    },
    mockOutput: normalizeMockOutput(mockOutput) ?? createMockCompactCheckerOutput()
  });
  const output = resolveSemanticCheckerOutput(checkerContext, result.data, attempt);
  // Preserve the raw response and token metrics; save the effective decision
  // separately so a spurious model finding is never reported as a real block.
  if (result.agentRunId) await prisma.agentRun.update({ where: { id: result.agentRunId },
    data: { checkerResult: JSON.stringify(output) } });

  return {
    roleId,
    output,
    agentRunId: result.agentRunId,
    checkerMode: "llm_checker",
    llmInvoked: true,
    deterministicLatencyMs
  };
}

export function buildMinimalCheckerContext(
  context: DiscussionUtteranceContext,
  candidate: AiPlayerDiscussionUtteranceOutput
): DiscussionCheckerContext {
  const knowledge = discussionKnowledge(context);
  const booklet = knowledge.current_role_booklet;
  const recentFacts = context.recent_public_messages.flatMap((message) => [
    message.content,
    ...message.metadata.revealed_facts
  ]);
  return {
    current_act_index: context.current_role_booklet?.actIndex ?? (Number(context.game_session.currentActId.match(/(?:runtime_)?act_(\d+)/)?.[1]) || undefined),
    knowledge,
    flow_constraints: [
      { id: "publication_audience", text: "公开发言全桌均能听见。不要在公开承认同一件事后仍把在场听众当作不知情，也不要将内心的未来否认/诬陷策略当作公开台词；原本隐瞒、如今承认是合法表达。仅有隐瞒愿望不是泄密禁令，未说出的其他秘密仍可保留。" },
      { id: "current_phase", text: `当前阶段=${context.game_session.currentPhase}；当前幕=${context.current_role_booklet?.actIndex ?? context.game_session.currentActId}；不得宣告未读未来幕事实。` },
      ...(context.input_policy ? [{ id: "input_policy", text: context.input_policy === "answer_only"
        ? (context.dm_interaction?.requests_experience
          ? `当前只定向回答：${context.dm_interaction.question}。相关合法已读经历允许回答，不扩散无关本幕新回忆，不解除knowledge.restrictions。`
          : "当前只回答实际DM问题或同线程追问。盲猜保留猜测语气，不主动分享本幕新回忆；已读历史普通经历不是本幕新回忆，硬秘密仍保护。") : `当前互动窗口=${context.input_policy}` }] : [])
    ],
    identity_anchor: context.identity_anchor,
    max_content_chars: context.publication_mode === "act_share" ? 600 : 220,
    role: context.role,
    action: context.selected_reaction,
    latest_message: {
      speaker_role_id: context.latest_message.speaker_role_id,
      speech_act: context.latest_message.speech_act,
      content: context.latest_message.content
    },
    direct_answer: context.direct_answer_mode,
    boundaries: {
      must_not_share: knowledge.restrictions.filter(r => !r.id.startsWith("profile.")).map(r => r.text),
      forbidden_summaries: [...knowledge.restrictions.filter(r => r.id.startsWith("profile.")).map(r => r.text), ...(context.input_policy === "answer_only" && !context.dm_interaction?.requests_experience ? ["不得主动扩散无关本幕新回忆，须围绕当前问题回答。"] : [])]
    },
    allowed_facts: uniqueStrings([
      ...knowledge.reviewed_facts.map(f => f.text),
      ...(booklet?.mustShare ?? []),
      ...(booklet?.mayShare ?? []),
      ...(context.historical_private_knowledge?.summary.filter(e => e.permission === "mustShare" || e.permission === "mayShare").map(e => e.text) ?? []),
      ...(context.historical_private_knowledge?.relevant_original_passages.filter(e => e.permission === "mustShare" || e.permission === "mayShare").map(e => e.text) ?? []),
      ...(context.runtime_clues ?? []).filter(c => c.shareAllowed || c.publiclyShared).map(c => c.text),
      // The identical board brief is already in knowledge.public_claims.
      // Keep one copy; do not duplicate it in the legacy compatibility list.
      ...recentFacts
    ]),
    candidate
  };
}

/** Publication gates, not a style or completeness grader. */
export function evaluateDiscussionCandidate(
  context: DiscussionCheckerContext, attempt: 1 | 2 = 1
): DeterministicDecision {
  const content = context.candidate.content.trim();
  if (!content) return deterministicFailure("候选正文为空；依据 publication.nonempty。", attempt, false);
  const allText = [content, ...Object.values(context.candidate.metadata).flat()].join("\n");
  const knowledge = context.knowledge;
  const restrictions = knowledge.restrictions;
  for (const r of restrictions) {
    if (isGeneralKnowledgeGuard(r.text)) continue;
    const protectedSource = protectedText(r.text);
    const parts = [protectedSource, ...protectedSource.split(/\n+/).filter(s => normalizeText(s).length >= 12)];
    const match = parts.find(part => containsForbidden(allText, part));
    if (match) return deterministicFailure(`禁止公开原文：候选含“${match}”；依据 ${r.id}：${r.text}`, attempt, true);
  }
  if (knowledge.input_policy === "choice_only")
    return deterministicFailure(`当前不可发表讨论：“${content}”；依据 input_policy=choice_only。`, attempt, true);
  const current = context.current_act_index;
  const future = [...allText.matchAll(/第([一二三四五六七八九十\d]+)幕(?:将|会|才|的真相|揭露|公布)/g)]
    .find(m => actNumber(m[1]) > (current ?? Infinity));
  if (future)
    return deterministicFailure(`越权宣告未读剧情：“${future[0]}”；依据 current_phase：当前第${current}幕，未读未来幕。`, attempt, true);

  const clauses = allText.split(/[。！？!?；;\n]+/).map(s => s.trim()).filter(Boolean);
  const risks: NonNullable<DiscussionCheckerContext["semantic_risks"]> = [];
  for (const r of restrictions) {
    const quote = clauses.find(clause => secretSemanticOverlap(clause, r.text));
    if (quote) risks.push({ kind: "secret", quote, source_id: r.id });
  }
  for (const clause of clauses) {
    if (isMajorObjectiveClaim(clause) && !isSupportedStatement(clause, knowledge))
      risks.push({ kind: "major_fact", quote: clause, source_id: "knowledge_scope" });
    const fromHistory = knowledge.historical_booklets.some(b => discussionOverlapForHistory(clause, b.privateText));
    if (knowledge.input_policy === "answer_only" && !fromHistory && !isTentativeDiscussion(clause) &&
      /(?:我|当时|那天|后来|之前).*(?:看见|看到|发现|拿起|走进|去了|见过)/.test(clause))
      risks.push({ kind: "process", quote: clause, source_id: "input_policy" });
  }
  const audienceConflict = publicDisclosureConflict(content, knowledge.public_audience);
  if (audienceConflict) risks.push({ kind: "process", quote: audienceConflict, source_id: "publication_audience" });
  context.semantic_risks = risks;
  if (risks.length) return { mode: "llm_checker", output: null,
    reasons: [...new Set(risks.map(r => `${r.kind}:${r.source_id}`))] };
  return { mode: "deterministic_pass", output: createLegacyOutput({ passed: true,
    decision: "pass", issues: [], retryHint: null }), reasons: ["no_concrete_publication_risk"] };
}

export function isMajorObjectiveClaim(text: string) {
  if (isTentativeDiscussion(text) || /不知道|不清楚|无法确定|不能确定|不记得/.test(text)) return false;
  return /凶手(?:就是|是)|(?:就是|是)凶手|杀死|杀害|杀了|杀过人|下毒|投毒|谋杀|枪杀|已经死亡|已经死了|已死|死于|警方证实|监控证明|DNA|真正身份(?:就是|是)|我(?:确定|亲眼).*(?:时间|案发|到场|离开|拿走|进入)|(?:案发|死亡)时间.*[0-9一二三四五六七八九十]|(?:就是|肯定是|一定是)(?:当时|那天|那个|那名|和我|我的同伴)|(?:同伴|同行者|那个男人|那个女人)(?:就是|是)/i.test(text);
}

function actNumber(text: string) {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = "零一二三四五六七八九";
  const parts = text.split("十");
  return parts.length === 1 ? digits.indexOf(text) :
    (parts[0] ? digits.indexOf(parts[0]) : 1) * 10 + (parts[1] ? digits.indexOf(parts[1]) : 0);
}

function isSupportedStatement(text: string, knowledge: DiscussionKnowledge) {
  const sources = [...ownKnowledgeSources(knowledge).map(s => s.text),
    ...knowledge.public_messages.filter(m => !isTentativeDiscussion(m.content) &&
      (m.speaker_role_id === "dm" || /听说|据.{1,8}说|公开(?:说|称)|他(?:说|声称)|她(?:说|声称)/.test(text))).map(m => m.content)];
  return sources.some(source => source.split(/[。！？!?；;\n]+/).some(p => {
    if (!isGroundedIn(text, p) || isTentativeDiscussion(p)) return false;
    // Similar wording does not ground a changed time, polarity or victim.
    const numbers = text.match(/\d+/g) ?? [];
    const sourceNumbers: string[] = p.match(/\d+/g) ?? [];
    if (numbers.some(n => !sourceNumbers.includes(n))) return false;
    const negated = (s: string) => /没有|从未|不曾|并非|未曾|不是|未接触/.test(s);
    if (negated(text) !== negated(p)) return false;
    const core = text.match(/(?:杀死|杀害|杀了|凶手(?:就是|是)|真正身份(?:就是|是))[^，,。；;]{1,12}|[^，,。；;]{1,8}(?:就是|是)凶手/)?.[0];
    if (/(?:就是|肯定是|一定是)(?:当时|那天|那个|那名|和我|我的同伴)|(?:同伴|同行者|那个男人|那个女人)(?:就是|是)/.test(text))
      return normalizeText(p).includes(normalizeText(text));
    return !core || normalizeText(p).includes(normalizeText(core));
  }));
}

/** A rejection needs an actual candidate quote plus a matching source. Public
 * guesses cannot serve as the source of a contradiction with private memory. */
export function resolveSemanticCheckerOutput(context: DiscussionCheckerContext,
  compact: CompactDiscussionCheckerOutput, attempt: 1 | 2 = 1): DiscussionCheckerOutput {
  const actualText = [context.candidate.content, ...Object.values(context.candidate.metadata).flat()].join("\n");
  const findings = (compact.findings ?? []).filter(f => {
    if (normalizeText(f.candidate_quote).length < 3 || !normalizeText(actualText).includes(normalizeText(f.candidate_quote))) return false;
    if (f.kind === "secret") {
      const rule = context.knowledge.restrictions.find(r => r.id === f.source_id);
      return rule && f.source_quote.trim().length >= 4 && rule.text.includes(f.source_quote) &&
        secretSemanticOverlap(f.candidate_quote, rule.text);
    }
    if (f.kind === "contradiction") {
      const source = ownKnowledgeSources(context.knowledge).find(s => s.id === f.source_id);
      return !isTentativeDiscussion(f.candidate_quote) && source && f.source_quote.trim().length >= 4 && source.text.includes(f.source_quote);
    }
    if (f.kind === "unsupported_major_claim") return f.source_id === "knowledge_scope" &&
      isMajorObjectiveClaim(f.candidate_quote) && !isSupportedStatement(f.candidate_quote, context.knowledge);
    const flow = context.flow_constraints.find(r => r.id === f.source_id);
    return flow && f.source_quote.trim().length >= 4 && flow.text.includes(f.source_quote) &&
      context.semantic_risks?.some(r => r.kind === "process" && r.source_id === f.source_id);
  });
  if (findings.length) return createLegacyOutput({ passed: false,
    decision: findings.some(f => f.kind === "secret") || attempt === 2 ? "block" : "rewrite_required",
    issues: findings.map(f => `“${f.candidate_quote}”：${f.explanation}；依据 ${f.source_id}：${f.source_quote || "合法已读原文与公共消息均无该重大断言来源"}`),
    retryHint: "只修改上述有依据的问题；保留其他合法经历与明确标为假设的推理。" });
  // An unsubstantiated model accusation is not proof. Ambiguous explicit
  // secrecy is the exception: fail closed, with its original rule and quote,
  // rather than silently treating a malformed/unsupported judgment as safe.
  const secret = context.semantic_risks?.find(r => r.kind === "secret");
  if (secret && !(compact.passed && compact.decision === "pass" && !compact.violations.length)) {
    const rule = context.knowledge.restrictions.find(r => r.id === secret.source_id)!;
    return deterministicFailure(`保密语义审核未能排除风险：“${secret.quote}”；依据 ${rule.id}：${rule.text}。`, attempt, true).output!;
  }
  const major = context.semantic_risks?.find(r => r.kind === "major_fact");
  if (major && !(compact.passed && compact.decision === "pass" && !compact.violations.length))
    return deterministicFailure(`无来源的重大事实断言：“${major.quote}”；依据 knowledge_scope：合法已读原文及公共消息均无该断言，请改为推测或删除。`, attempt, false).output!;
  const process = context.semantic_risks?.find(r => r.kind === "process");
  if (process && !(compact.passed && compact.decision === "pass" && !compact.violations.length))
    return deterministicFailure(`流程风险未解除：“${process.quote}”；依据 ${process.source_id}：${context.flow_constraints.find(r => r.id === process.source_id)?.text}`, attempt, false).output!;
  return createLegacyOutput({ passed: true, decision: "pass", issues: [], retryHint: null });
}

function deterministicFailure(
  issue: string,
  attempt: 1 | 2,
  severe: boolean
): DeterministicDecision {
  const decision = severe || attempt === 2 ? "block" : "rewrite_required";
  return {
    mode: "deterministic_fail",
    output: createLegacyOutput({
      passed: false,
      decision,
      issues: [issue],
      retryHint: severe ? "删除禁止公开或越权内容。" : issue
    }),
    reasons: [issue]
  };
}

function createLegacyOutput(input: {
  passed: boolean;
  decision: "pass" | "rewrite_required" | "block";
  issues: string[];
  retryHint: string | null;
}): DiscussionCheckerOutput {
  const leakageIssues = input.issues.filter((item) => /(泄露|禁止|私密|保密|秘密|透露|后续|真相|全知|mustNotShare)/.test(item));
  const intentIssues = input.issues.filter((item) => /(意图|回答|speech|问题)/i.test(item));
  const roleIssues = input.issues.filter((item) => /(越权|不知道|角色|来源|编造)/.test(item));
  const qualityIssues = input.issues.filter(
    (item) => !leakageIssues.includes(item) && !intentIssues.includes(item) && !roleIssues.includes(item)
  );
  return {
    passed: input.passed,
    decision: input.decision,
    leakage: { has_leakage: leakageIssues.length > 0, items: leakageIssues },
    boundary: { violated: leakageIssues.length > 0, items: leakageIssues },
    intent_alignment: {
      follows_brief_intent: intentIssues.length === 0,
      issues: intentIssues
    },
    role_consistency: { is_consistent: roleIssues.length === 0, issues: roleIssues },
    quality: { is_usable: qualityIssues.length === 0, issues: qualityIssues },
    rewrite_advice: input.retryHint
  };
}

function collectIssues(output: DiscussionCheckerOutput): string[] {
  return uniqueStrings([
    ...output.leakage.items,
    ...output.boundary.items,
    ...output.intent_alignment.issues,
    ...output.role_consistency.issues,
    ...output.quality.issues
  ]);
}

function compactCandidate(candidate: AiPlayerDiscussionUtteranceOutput) {
  return {
    content: candidate.content,
    revealedFacts: candidate.metadata.revealed_facts,
    questionsRaised: candidate.metadata.questions_raised,
    selfCheck: candidate.self_check
  };
}

function normalizeMockOutput(value: unknown): CompactDiscussionCheckerOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.checker_mode === "llm_checker") {
    return value as CompactDiscussionCheckerOutput;
  }
  if (typeof record.passed === "boolean" && typeof record.decision === "string") {
    const issues: string[] = [];
    for (const key of ["leakage", "boundary", "intent_alignment", "role_consistency", "quality"]) {
      const section = record[key];
      if (section && typeof section === "object" && !Array.isArray(section)) {
        const fields = section as Record<string, unknown>;
        for (const field of ["items", "issues"]) {
          if (Array.isArray(fields[field])) {
            issues.push(...fields[field].filter((item): item is string => typeof item === "string"));
          }
        }
      }
    }
    return {
      checker_mode: "llm_checker",
      passed: record.passed,
      decision: record.decision as CompactDiscussionCheckerOutput["decision"],
      violations: uniqueStrings(issues).slice(0, 4),
      findings: [],
      retry_hint: typeof record.rewrite_advice === "string" ? record.rewrite_advice : null
    };
  }
  return null;
}

function createMockCompactCheckerOutput(): CompactDiscussionCheckerOutput {
  return {
    checker_mode: "llm_checker",
    passed: true,
    decision: "pass",
    violations: [],
    findings: [],
    retry_hint: null
  };
}

function containsForbidden(candidate: string, forbidden: string): boolean {
  const normalizedForbidden = normalizeText(forbidden);
  return normalizedForbidden.length >= 4 && normalizeText(candidate).includes(normalizedForbidden);
}

function isGroundedIn(statement: string, source: string): boolean {
  const left = normalizeText(statement);
  const right = normalizeText(source);
  if (!left || !right) {
    return false;
  }
  return left.includes(right) || right.includes(left) || overlapScore(left, right) >= 0.42;
}

function overlapScore(left: string, right: string): number {
  const leftGrams = ngrams(normalizeText(left));
  const rightGrams = new Set(ngrams(normalizeText(right)));
  if (leftGrams.length === 0 || rightGrams.size === 0) {
    return 0;
  }
  return leftGrams.filter((gram) => rightGrams.has(gram)).length / leftGrams.length;
}

function ngrams(value: string): string[] {
  if (value.length < 2) {
    return value ? [value] : [];
  }
  return Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

// Only a strong verbatim historical source match can remove a new-memory risk.
function discussionOverlapForHistory(clause: string, original: string) {
  const normalized = normalizeText(clause);
  return normalized.length >= 8 && normalizeText(original).includes(normalized.replace(/^(?:我记得|我想起|当时我|我)/, ""));
}

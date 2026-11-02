import type {
  DMConditionalRule,
  DMFlowNode,
  DMFlowNodeType,
  DMNodeGuidance
} from "@/src/lib/schemas/dmFlowSchema";

export type NormalizedDMFlowActFlow = {
  actIndex: number;
  title?: string;
  nodes: DMFlowNode[];
  warnings: string[];
  sourceSectionId?: string;
  sourceEvidence?: DMFlowNode["sourceEvidence"];
};

export type NormalizedDMFlow = {
  openingNodes: DMFlowNode[];
  actFlows: NormalizedDMFlowActFlow[];
  endingNodes: DMFlowNode[];
  warnings: string[];
};

const CONDITIONAL_PATTERNS = [
  /如果玩家/,
  /若玩家/,
  /当玩家/,
  /如果有人/,
  /若有人/,
  /如果他们问/,
  /如果玩家问/,
  /如果玩家没有/,
  /若无人提及/,
  /如果无人提及/,
  /如果玩家想/,
  /如果玩家选择/,
  /如果讨论/,
  /玩家卡住/,
  /可以回答/,
  /DM\s*可以回答/i,
  /主持人可提示/
];

const MAIN_FLOW_PATTERNS = [
  /进入.*幕/,
  /下一幕/,
  /请.*(?:阅读|读本|打开|翻开)/,
  /请.*(?:依次|轮流).*分享/,
  /开始.*(?:读本|分享|自由讨论)/,
  /本幕.*(?:结束|总结)/
];

const ATTACHMENT_TYPES: DMFlowNodeType[] = ["free_discussion", "dm_prompt", "sharing_round"];

export function normalizeDMFlowForRuntime(flow: {
  openingNodes?: unknown[];
  actFlows?: Array<{
    actIndex: number;
    title?: string;
    nodes?: unknown[];
    warnings?: string[];
    sourceSectionId?: string;
    sourceEvidence?: DMFlowNode["sourceEvidence"];
  }>;
  endingNodes?: unknown[];
  warnings?: string[];
}): NormalizedDMFlow {
  const opening = normalizeNodeList(flow.openingNodes ?? [], "opening");
  const ending = normalizeNodeList(flow.endingNodes ?? [], "ending");
  const normalizedOpening = splitConditionalNodes(opening.nodes, "opening");
  const normalizedEnding = splitConditionalNodes(ending.nodes, "ending");
  const actFlows = (flow.actFlows ?? []).map((actFlow) => {
    const list = normalizeNodeList(actFlow.nodes ?? [], `act_${actFlow.actIndex}`);
    const split = splitConditionalNodes(list.nodes, `act_${actFlow.actIndex}`);

    return {
      actIndex: actFlow.actIndex,
      title: actFlow.title,
      nodes: split.nodes,
      warnings: [
        ...(actFlow.warnings ?? []),
        ...list.warnings,
        ...split.warnings
      ],
      sourceSectionId: actFlow.sourceSectionId,
      sourceEvidence: actFlow.sourceEvidence
    };
  });

  return {
    openingNodes: normalizedOpening.nodes,
    actFlows,
    endingNodes: normalizedEnding.nodes,
    warnings: [
      ...(flow.warnings ?? []),
      ...opening.warnings,
      ...ending.warnings,
      ...normalizedOpening.warnings,
      ...normalizedEnding.warnings,
      ...actFlows.flatMap((actFlow) => actFlow.warnings)
    ]
  };
}

export function normalizeDMFlowNode(value: unknown, index: number): DMFlowNode {
  const record = isRecord(value) ? value : {};
  const nodeId = typeof record.nodeId === "string" && record.nodeId.trim() ? record.nodeId : `legacy_node_${index + 1}`;
  const sourceQuote =
    stringOrNull(record.sourceQuote) ??
    stringOrNull(record.text) ??
    stringOrNull(record.fixedLine) ??
    nodeId;
  const requiredPublicPoints = stringArray(record.requiredPublicPoints);
  const ifMissingPoints = stringArray(record.ifMissingPoints);
  const forbiddenReveals = stringArray(record.forbiddenReveals);
  const guidance = normalizeGuidance(record.guidance, {
    discussionGoal: stringOrNull(record.promptGoal) ?? stringOrNull(record.text),
    requiredPublicPoints,
    ifMissingPoints,
    forbiddenReveals
  });

  return {
    nodeId,
    sourceEvidence: record.sourceEvidence as DMFlowNode["sourceEvidence"],
    semanticItemId: stringOrNull(record.semanticItemId) ?? undefined,
    variantGroup: stringOrNull(record.variantGroup) ?? undefined,
    branchId: stringOrNull(record.branchId) ?? undefined,
    textExecution: record.textExecution as DMFlowNode["textExecution"],
    discussionExit: record.discussionExit as DMFlowNode["discussionExit"],
    knowledgeRelease: record.knowledgeRelease as DMFlowNode["knowledgeRelease"],
    continuationRequired: record.continuationRequired as DMFlowNode["continuationRequired"],
    inputPolicy: record.inputPolicy as DMFlowNode["inputPolicy"],
    clueAction: record.clueAction as DMFlowNode["clueAction"],
    choice: record.choice as DMFlowNode["choice"],
    choiceRecap: record.choiceRecap as DMFlowNode["choiceRecap"],
    matchingReveal: record.matchingReveal as DMFlowNode["matchingReveal"],
    choiceEnding: record.choiceEnding as DMFlowNode["choiceEnding"],
    whenChoice: record.whenChoice as DMFlowNode["whenChoice"],
    type: normalizeDMFlowNodeType(record.type),
    actIndex: typeof record.actIndex === "number" && Number.isInteger(record.actIndex) ? record.actIndex : null,
    title: stringOrNull(record.title),
    text: stringOrNull(record.text),
    fixedLine: stringOrNull(record.fixedLine),
    promptGoal: stringOrNull(record.promptGoal),
    targetRoleNames: stringArray(record.targetRoleNames),
    expectedSpeakerRoleNames: stringArray(record.expectedSpeakerRoleNames),
    durationHint: stringOrNull(record.durationHint),
    orderHint: typeof record.orderHint === "number" && Number.isInteger(record.orderHint) ? record.orderHint : null,
    requiredPublicPoints,
    ifMissingPoints,
    forbiddenReveals,
    conditionalRules: Array.isArray(record.conditionalRules)
      ? record.conditionalRules.map((rule, ruleIndex) => normalizeConditionalRule(rule, `${nodeId}_rule_${ruleIndex + 1}`))
      : [],
    guidance,
    clueRefs: Array.isArray(record.clueRefs) ? record.clueRefs.map(normalizeClueRef) : [],
    performance: normalizePerformance(record.performance),
    sourceQuote,
    confidence: typeof record.confidence === "number" ? Math.min(1, Math.max(0, record.confidence)) : 0.5,
    warnings: [...stringArray(record.warnings), ...(typeof record.type === "string" && normalizeDMFlowNodeType(record.type) !== record.type
      ? [`UNSUPPORTED_DM_NODE_TYPE: ${record.type}`] : [])]
  };
}

export function isConditionalLikeNode(node: DMFlowNode): boolean {
  // Conditions inside an action may select parameters, not whether it happens.
  if (node.type === "clue_release" || node.type === "performance_instruction" || node.clueRefs.length || node.performance) return false;
  const text = collectNodeText(node);

  if (MAIN_FLOW_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }

  return CONDITIONAL_PATTERNS.some((pattern) => pattern.test(text));
}

function normalizeNodeList(nodes: unknown[], scope: string): { nodes: DMFlowNode[]; warnings: string[] } {
  const warnings: string[] = [];

  return {
    nodes: nodes.map((node, index) => {
      const normalized = normalizeDMFlowNode(node, index);

      if (!normalized.nodeId.startsWith(scope)) {
        return normalized;
      }

      warnings.push(`节点 ${normalized.nodeId} 已按旧格式补齐 DMFlow runtime 字段。`);

      return normalized;
    }),
    warnings
  };
}

function splitConditionalNodes(nodes: DMFlowNode[], scope: string): { nodes: DMFlowNode[]; warnings: string[] } {
  const result: DMFlowNode[] = [];
  const warnings: string[] = [];
  let lastAttachableIndex = -1;

  for (const node of nodes) {
    if (!isConditionalLikeNode(node)) {
      const ambiguousAction = (node.type === "clue_release" || node.type === "performance_instruction" || node.clueRefs.length || node.performance) && /如果|若|否则|条件/.test(collectNodeText(node));
      result.push(ambiguousAction ? { ...node, warnings: [...node.warnings, "SEMANTIC_REPAIR_CANDIDATE: action condition preserved without moving payload"] } : node);

      if (ATTACHMENT_TYPES.includes(node.type)) {
        lastAttachableIndex = result.length - 1;
      }

      continue;
    }

    const rule = convertNodeToConditionalRule(node);
    let attachIndex = lastAttachableIndex;

    if (attachIndex === -1) {
      attachIndex = result.findIndex((candidate) => ATTACHMENT_TYPES.includes(candidate.type));
    }

    if (attachIndex === -1) {
      const fallback = createFallbackFreeDiscussionNode(scope, node.actIndex);
      result.push(fallback);
      attachIndex = result.length - 1;
      lastAttachableIndex = attachIndex;
      warnings.push(`条件提示 ${node.nodeId} 未找到可挂载节点，已创建 fallback free_discussion。`);
    }

    const target = result[attachIndex];
    result[attachIndex] = {
      ...target,
      conditionalRules: [...target.conditionalRules, rule],
      warnings: [
        ...target.warnings,
        `旧节点 ${node.nodeId} 已从主流程移入 conditionalRules。`
      ]
    };
  }

  return { nodes: result, warnings };
}

function convertNodeToConditionalRule(node: DMFlowNode): DMConditionalRule {
  const rawText = collectNodeText(node);

  return {
    ruleId: `rule_from_${node.nodeId}`,
    triggerType: inferRuleTriggerType(rawText),
    conditionText: extractConditionText(rawText),
    responseType: inferRuleResponseType(node, rawText),
    responseText: node.fixedLine ?? node.text ?? node.promptGoal ?? node.sourceQuote,
    targetRoleNames: node.targetRoleNames,
    keywords: extractKeywords(rawText),
    sourceQuote: node.sourceQuote,
    confidence: Math.min(0.86, Math.max(0.45, node.confidence)),
    warnings: [`由旧 DMFlow 主流程节点 ${node.nodeId} 自动转换。`, ...node.warnings]
  };
}

function createFallbackFreeDiscussionNode(scope: string, actIndex: number | null): DMFlowNode {
  return {
    nodeId: `${scope}_fallback_free_discussion`,
    type: "free_discussion",
    actIndex,
    title: "自由讨论",
    text: "现在进入自由讨论阶段，大家可以围绕刚才公开的信息提问或补充。",
    fixedLine: null,
    promptGoal: "承接当前幕条件提示。",
    targetRoleNames: [],
    expectedSpeakerRoleNames: [],
    durationHint: null,
    orderHint: null,
    requiredPublicPoints: [],
    ifMissingPoints: [],
    forbiddenReveals: [],
    conditionalRules: [],
    guidance: {
      discussionGoal: "承接当前幕条件提示。",
      requiredPublicPoints: [],
      ifMissingPoints: [],
      forbiddenReveals: [],
      toneGuidance: null,
      fallbackHint: "只说流程，不补充剧情事实。"
    },
    clueRefs: [],
    performance: null,
    sourceQuote: "fallback free_discussion",
    confidence: 0.4,
    warnings: ["由 runtime normalization 创建，用于挂载无法定位的条件规则。"]
  };
}

function inferRuleTriggerType(text: string): DMConditionalRule["triggerType"] {
  if (/没有|无人提及|未提到/.test(text)) return "missing_public_point";
  if (/卡住|讨论不下去|僵住/.test(text)) return "discussion_stuck";
  if (/太久|超时|时间/.test(text)) return "discussion_too_long";
  if (/想看|查看|要求看|索要|发放/.test(text)) return "clue_requested";
  if (/说到|提到|关键词/.test(text)) return "keyword_mentioned";
  if (/问/.test(text)) return "if_player_asks";
  return "manual";
}

function inferRuleResponseType(node: DMFlowNode, text: string): DMConditionalRule["responseType"] {
  if (/不能回答|不要回答|暂不回答/.test(text)) return "do_not_answer";
  if (node.type === "clue_release" || /发放|给.*看|公开.*线索/.test(text)) return "release_clue";
  if (node.type === "fixed_line" || node.fixedLine) return "fixed_answer";
  if (node.type === "dm_prompt" || /提示|追问|提醒/.test(text)) return "dm_prompt";
  return "guided_answer";
}

function extractConditionText(text: string): string {
  const match = text.match(/((?:如果|若|当).{1,80}?)(?:，|。|：|:)/);

  return match?.[1]?.trim() || text.slice(0, 120).trim();
}

function extractKeywords(text: string): string[] {
  const quoted = Array.from(text.matchAll(/[“"《]([^”"》]{1,20})[”"》]/g)).map((match) => match[1]);

  return Array.from(new Set(quoted.filter((item): item is string => Boolean(item?.trim()))));
}

function normalizeConditionalRule(value: unknown, fallbackId: string): DMConditionalRule {
  const record = isRecord(value) ? value : {};

  return {
    ruleId: stringOrNull(record.ruleId) ?? fallbackId,
    triggerType: normalizeTriggerType(record.triggerType),
    conditionText: stringOrNull(record.conditionText) ?? stringOrNull(record.sourceQuote) ?? fallbackId,
    responseType: normalizeResponseType(record.responseType),
    responseText: stringOrNull(record.responseText),
    targetRoleNames: stringArray(record.targetRoleNames),
    keywords: stringArray(record.keywords),
    ...(Array.isArray(record.publicPointClaims) ? { publicPointClaims: stringArray(record.publicPointClaims) } : {}),
    sourceQuote: stringOrNull(record.sourceQuote),
    confidence: typeof record.confidence === "number" ? Math.min(1, Math.max(0, record.confidence)) : 0.5,
    warnings: stringArray(record.warnings)
  };
}

function normalizeGuidance(value: unknown, fallback: Partial<DMNodeGuidance>): DMNodeGuidance {
  const record = isRecord(value) ? value : {};

  return {
    discussionGoal: stringOrNull(record.discussionGoal) ?? fallback.discussionGoal ?? null,
    requiredPublicPoints: stringArray(record.requiredPublicPoints).length
      ? stringArray(record.requiredPublicPoints)
      : fallback.requiredPublicPoints ?? [],
    ifMissingPoints: stringArray(record.ifMissingPoints).length
      ? stringArray(record.ifMissingPoints)
      : fallback.ifMissingPoints ?? [],
    forbiddenReveals: stringArray(record.forbiddenReveals).length
      ? stringArray(record.forbiddenReveals)
      : fallback.forbiddenReveals ?? [],
    toneGuidance: stringOrNull(record.toneGuidance) ?? fallback.toneGuidance ?? null,
    fallbackHint: stringOrNull(record.fallbackHint) ?? fallback.fallbackHint ?? null
  };
}

function normalizeTriggerType(value: unknown): DMConditionalRule["triggerType"] {
  const allowed: DMConditionalRule["triggerType"][] = [
    "if_player_asks",
    "keyword_mentioned",
    "missing_public_point",
    "discussion_stuck",
    "discussion_too_long",
    "specific_role_speaks",
    "clue_requested",
    "fallback_answer",
    "manual"
  ];

  return allowed.includes(value as DMConditionalRule["triggerType"]) ? (value as DMConditionalRule["triggerType"]) : "manual";
}

function normalizeResponseType(value: unknown): DMConditionalRule["responseType"] {
  const allowed: DMConditionalRule["responseType"][] = [
    "fixed_answer",
    "guided_answer",
    "release_clue",
    "dm_prompt",
    "do_not_answer"
  ];

  return allowed.includes(value as DMConditionalRule["responseType"]) ? (value as DMConditionalRule["responseType"]) : "guided_answer";
}

function normalizeDMFlowNodeType(value: unknown): DMFlowNodeType {
  const allowed: DMFlowNodeType[] = [
    "fixed_line",
    "reading_start",
    "sharing_round",
    "free_discussion",
    "dm_prompt",
    "performance_instruction",
    "clue_release",
    "act_summary",
    "transition",
    "ending_reveal",
    "unknown"
  ];

  return allowed.includes(value as DMFlowNodeType) ? (value as DMFlowNodeType) : "unknown";
}

function normalizeClueRef(value: unknown): DMFlowNode["clueRefs"][number] {
  const record = isRecord(value) ? value : {};

  return {
    title: stringOrNull(record.title),
    rawText: stringOrNull(record.rawText),
    releaseMode:
      record.releaseMode === "fixed_at_node" ||
      record.releaseMode === "dm_decision" ||
      record.releaseMode === "user_choice" ||
      record.releaseMode === "manual" ||
      record.releaseMode === "unknown"
        ? record.releaseMode
        : "unknown",
    targetRoleNames: stringArray(record.targetRoleNames),
    visibility:
      record.visibility === "public" || record.visibility === "private" || record.visibility === "unknown"
        ? record.visibility
        : "unknown"
  };
}

function normalizePerformance(value: unknown): DMFlowNode["performance"] {
  if (!isRecord(value)) {
    return null;
  }

  return {
    kind:
      value.kind === "npc_line" ||
      value.kind === "bgm" ||
      value.kind === "prop" ||
      value.kind === "letter" ||
      value.kind === "audio" ||
      value.kind === "video" ||
      value.kind === "other"
        ? value.kind
        : null,
    instruction: stringOrNull(value.instruction),
    rawText: stringOrNull(value.rawText)
  };
}

function collectNodeText(node: DMFlowNode): string {
  return [
    node.title,
    node.text,
    node.fixedLine,
    node.promptGoal,
    node.sourceQuote,
    node.performance?.instruction,
    node.performance?.rawText
  ]
    .filter((item): item is string => Boolean(item?.trim()))
    .join("\n");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

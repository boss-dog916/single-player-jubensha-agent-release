import type { ScriptRuntimeDefinitionJson } from "@/src/lib/services/scriptRuntimeDefinitionService";
import { DMFlowNodeSchema, type DMFlowNode } from "@/src/lib/schemas/dmFlowSchema";
import { RuntimeChoiceSchema, ChoiceRecapSchema, ChoiceEqualsSchema, ChoiceEndingSchema, GroupMatchingRevealSchema } from "@/src/lib/schemas/runtimeChoiceSchema";
import { earlierChoiceNode } from "./runtimeChoiceState";
import { clueNodeErrors } from "./runtimeClueValidation";
import { RUNTIME_CAPABILITIES } from "@/src/lib/services/manualControlCompiler";
import { ConversationPolicySchema, SourceEvidenceSchema } from "@/src/lib/schemas/manualSemanticSchema";

export type DMLifecycleIssue = { code: string; message: string; fatal: boolean; actIndex?: number };
export type DMLifecycleScope = { actRange: { start: number; end: number }; roleNames: string[] };
const types = new Set(["fixed_line", "reading_start", "sharing_round", "free_discussion", "dm_prompt",
  "performance_instruction", "clue_release", "act_summary", "transition", "ending_reveal"]);

export function isStageOperation(node: DMFlowNode): boolean {
  return /BGM|背景音|背景音乐|播放.*(?:音乐|提示音|音效)|舞台说明|灯光|交付.*道具|演绎(?:执行|操作|模式)|DM\s*下场/i.test(
    [node.title, node.text, node.semanticItemId ? null : node.sourceQuote, node.performance?.instruction, node.performance?.rawText].filter(Boolean).join("\n"));
}

export function isSensitiveRecoveryNode(node: DMFlowNode): boolean {
  return ["ending_reveal", "clue_release", "performance_instruction"].includes(node.type) ||
    /身份(?:揭示|揭晓)|揭(?:示|露|晓).*(?:身份|真相|结局)|结局揭|凶手是|我是.*(?:小说家|凶手|幕后)/.test(
      [node.title, node.fixedLine, node.text].filter(Boolean).join("\n"));
}

export function validateDMLifecycle(definition: ScriptRuntimeDefinitionJson, scope?: DMLifecycleScope): DMLifecycleIssue[] {
  const issues: DMLifecycleIssue[] = [];
  const flows = definition.dmFlow?.actFlows ?? [];
  const range = scope?.actRange;
  const selected = flows.filter(f => !range || f.actIndex >= range.start && f.actIndex <= range.end);
  const acts = definition.acts.filter(a => !range || a.actIndex >= range.start && a.actIndex <= range.end);
  const ids = new Set<string>();
  for (let i = 1; i < selected.length; i++) if (selected[i].actIndex < selected[i - 1].actIndex) {
    issues.push({ code: "DM_ACT_ORDER", message: "DMFlow 幕顺序异常。", fatal: true });
  }
  for (const act of acts) {
    const matches = selected.filter(f => f.actIndex === act.actIndex);
    if (matches.length !== 1) issues.push({ code: matches.length ? "DUPLICATE_DM_ACT_FLOW" : "MISSING_DM_ACT_FLOW",
      message: `第 ${act.actIndex} 幕必须有且只有一份权威 DMFlow，当前 ${matches.length} 份。`, fatal: true, actIndex: act.actIndex });
    if (matches.length === 1) {
      const ns = matches[0].nodes;
      const control = act.control;
      if (control) {
        const error = (code: string, message: string) => issues.push({ code, message, fatal: true, actIndex: act.actIndex });
      if (control.requiredCapabilities.includes("group_matching_delayed_score") && !ns.some(n => n.matchingReveal))
        error("INVALID_RUNTIME_CHOICE", "声明延迟匹配公布的幕必须绑定真实公布节点。");
      if (control.requiredCapabilities.includes("no_model_epilogue") && act.modelPolicy !== "disabled") error("INVALID_MODEL_POLICY", "无模型尾声必须有明确执行策略。");
      if (control.requiredCapabilities.includes("human_reason_ending") && !ns.some(n => n.choice?.type !== "group_matching" && n.choice?.endsGame && n.choice.requiresReason)) error("INVALID_HUMAN_ENDING", "缺少真实真人结局选择。");
      if (control.requiredCapabilities.includes("pdf_only_private_delivery") && !ns.some(n => n.clueAction?.action === "grant")) error("INVALID_PDF_GRANT", "缺少PDF发放节点。");
      if (control.requiredCapabilities.includes("choice_bound_ending") && !ns.some(n => n.choiceEnding))
        error("INVALID_CHOICE_ENDING", "声明选择结局的幕必须包含真实结局消费节点。");
        if (!ConversationPolicySchema.safeParse(control.conversationPolicy).success) error("INVALID_CONVERSATION_POLICY", "conversationPolicy 缺少有效来源证据。");
        const gates = [control.readingGate, ...(control.conversationPolicy.mode === "ordered_share_then_discuss" ? [control.shareGate] : []), ...control.discussionWindows];
        if (gates.some(g => !g) || act.modelPolicy !== "disabled" && !control.discussionWindows.length) error("INCOMPLETE_RUNTIME_CONTROL", "编译后的 reading/share/discussion 控制不完整。");
        if (control.conversationPolicy.mode === "free_discussion_after_reading" && (control.shareGate || ns.some(n => n.type === "sharing_round"))) error("FAKE_ORDERED_SHARING", "自由公聊策略不允许插入顺序分享 gate。");
        const positions = gates.filter(g => Boolean(g)).map(g => ns.findIndex(n => n.nodeId === g!.id && n.semanticItemId === g!.semanticItemId));
        if (positions.some((p, i) => p < 0 || i > 0 && p <= positions[i - 1])) error("INVALID_CONTROL_ORDER", "Gate 缺失或窗口顺序不合法。");
        const typedGates = [[control.readingGate, "reading_start"], [control.shareGate, "sharing_round"], ...control.discussionWindows.map(w => [w, "free_discussion"])] as const;
        for (const [gate, type] of typedGates) if (gate && (typeof gate === "string" || !ns.some(n => n.nodeId === gate.id && n.semanticItemId === gate.semanticItemId && n.type === type))) error("INVALID_GATE_BINDING", "Gate 必须绑定正确类型的编译节点。");
        if (new Set(control.discussionWindows.map(w => w.windowId)).size !== control.discussionWindows.length || control.discussionWindows.some((w, i) => i > 0 && w.order <= control.discussionWindows[i - 1].order)) error("AMBIGUOUS_DISCUSSION_WINDOW", "讨论窗口必须有唯一 identity 和明确顺序。");
        for (const gate of [...gates, control.transitionTarget].filter(g => Boolean(g))) if (!SourceEvidenceSchema.safeParse(gate!.evidence).success) error("MISSING_CONTROL_EVIDENCE", "控制项来源证据无效。");
        for (const reason of control.needsAttention) error("SEMANTIC_NEEDS_ATTENTION", reason);
        for (const capability of control.requiredCapabilities) if (!(RUNTIME_CAPABILITIES as readonly string[]).includes(capability)) error("unsupported_runtime_capability", `Runtime 尚不支持 ${capability}。`);
        if (control.transitionTarget) {
          const next = definition.acts.find(a => a.actIndex > act.actIndex)?.actIndex ?? null;
          const index = ns.findIndex(n => n.nodeId === control.transitionTarget!.id && n.semanticItemId === control.transitionTarget!.semanticItemId && n.type === "transition");
          if (control.transitionTarget.nextActIndex !== next || index < 0 || positions.some(p => p >= index)) error("INVALID_TRANSITION_CONTROL", "转场目标或关卡顺序与明确下一幕不一致。");
        }
      }
      if (act.modelPolicy !== undefined && (act.modelPolicy !== "disabled" || act.actIndex !== definition.acts.at(-1)?.actIndex ||
        ns.some(n => n.type === "free_discussion" || n.type === "sharing_round" || n.discussionExit || n.textExecution?.wait || n.textExecution?.when ||
          n.textExecution?.fidelity === "reference" || n.conditionalRules.length || n.choice?.type === "group_matching" ||
          n.choice && n.choice.participants !== "human" ||
          !(["reading_start", "transition"].includes(n.type) && Boolean(n.fixedLine?.trim()) || n.textExecution?.fidelity === "fixed" || n.type === "dm_prompt" && n.choice?.participants === "human")))) issues.push({ code: "INVALID_MODEL_POLICY", message: "无模型尾声只能执行确定性阅读、固定正文及真人选择。", fatal: true });
      const entries = control ? [] : ["reading_start", "sharing_round", "free_discussion"];
      let previous = -1;
      for (const type of entries) {
        const positions = ns.flatMap((n, index) => n.type === type ? [index] : []);
        if (positions.length !== 1 || positions[0] <= previous) issues.push({ code: "MISSING_OR_AMBIGUOUS_DM_ENTRY",
          message: `第 ${act.actIndex} 幕 ${type} 入口缺失、重复或顺序错误。`, fatal: true, actIndex: act.actIndex });
        previous = positions[0] ?? previous;
      }
    }
  }
  const nodes = [...(definition.dmFlow?.openingNodes ?? []), ...selected.flatMap(f => f.nodes),
    ...(!scope ? definition.dmFlow?.endingNodes ?? [] : [])];
  const choiceIds = new Set<string>();
  for (const node of nodes) {
    const invalidChoice = (message: string) => issues.push({ code: "INVALID_RUNTIME_CHOICE", message: `${node.nodeId}: ${message}`, fatal: true });
    if (node.continuationRequired !== undefined && (node.continuationRequired !== true || node.type !== "transition" ||
      !definition.acts.some(a => a.actIndex > (node.actIndex ?? Infinity)))) invalidChoice("连续流程边界必须有真实的后续幕。");
    if (node.inputPolicy !== undefined && (node.inputPolicy === "choice_only" ? !node.choice || node.choice.type === "group_matching" : ["answer_only", "directed_sharing"].includes(node.inputPolicy) ? !node.textExecution?.wait || !node.expectedSpeakerRoleNames.length : true))
      invalidChoice("受限输入必须绑定个人结构化选择。");
    if (node.knowledgeRelease) {
      const entries = node.knowledgeRelease;
      if (!Array.isArray(entries) || !entries.length || node.type !== "dm_prompt" || node.choice || node.textExecution || node.clueAction || node.choiceRecap || node.matchingReveal || node.whenChoice || node.choiceEnding || node.discussionExit ||
        !SourceEvidenceSchema.safeParse(node.sourceEvidence).success || entries.some(r => {
          const b = definition.roleBooklets.find(b => b.sourceRoleActBookletId === r.sourceBookletId);
          return !b || !node.actIndex || b.actIndex > node.actIndex || !b.mustNotShare.includes(r.restriction) ||
            !Array.isArray(r.allowedFacts) || !r.allowedFacts.length || r.allowedFacts.some(t => typeof t !== "string" || !t.trim() || !b.privateText.includes(t));
        })) invalidChoice("历史授权必须引用真实来源、已有禁令及原文事实。");
    }
    if (node.choice) {
      if (!RuntimeChoiceSchema.safeParse(node.choice).success) { invalidChoice("选择配置格式无效。"); continue; }
      if (!selected.some(f => f.actIndex === node.actIndex && f.nodes.includes(node)) || node.type !== "dm_prompt" || node.textExecution || node.choiceRecap || node.matchingReveal || node.whenChoice ||
        !SourceEvidenceSchema.safeParse(node.sourceEvidence).success ||
        new Set(node.choice.options.map(o => o.optionId)).size !== node.choice.options.length || choiceIds.has(node.choice.choiceId) && node.choice.type !== "group_matching" ||
        node.choice.participants === "targets" && (!node.targetRoleNames.length || node.targetRoleNames.some(r => !definition.roles.some(role => role.roleName === r))))
        invalidChoice("选择配置、参与者、来源或选项唯一性无效。");
      if (node.choice.type === "group_matching") {
        const choice = node.choice;
        const earlier = nodes.slice(0, nodes.indexOf(node)).filter(n => n.choice?.choiceId === choice.choiceId);
        const declared = flows.flatMap(f => f.nodes).filter(n => n.choice?.type === "group_matching" && n.choice.choiceId === choice.choiceId);
        if (declared.length !== choice.maxRounds || choice.round > choice.maxRounds || new Set(node.targetRoleNames).size !== node.targetRoleNames.length ||
          node.targetRoleNames.length !== choice.options.length || earlier.length !== choice.round - 1 ||
          earlier.some((n, i) => n.choice?.type !== "group_matching" || n.choice.round !== i + 1 || n.choice.maxRounds !== choice.maxRounds ||
            JSON.stringify(n.choice.options) !== JSON.stringify(choice.options) || JSON.stringify(n.targetRoleNames) !== JSON.stringify(node.targetRoleNames)) ||
          choice.inviteRoleNames.some(r => !node.targetRoleNames.includes(r))) invalidChoice("团队匹配必须有一一对应的角色/选项，以及连续且一致的合法轮次。");
      }
      if (node.choice.type !== "group_matching" && (node.choice.requiresReason || node.choice.endsGame)) {
        const rest = selected.find(f => f.nodes.includes(node))?.nodes.slice(selected.find(f => f.nodes.includes(node))!.nodes.indexOf(node) + 1) ?? [];
        if (!node.choice.requiresReason || !node.choice.endsGame || node.choice.participants !== "human" || node.actIndex !== definition.acts.at(-1)?.actIndex ||
          rest.length !== 1 || rest[0].type !== "transition" || node.inputPolicy !== "choice_only") invalidChoice("最终理由必须绑定最后一幕真人选择及唯一终止转场。");
      }
      choiceIds.add(node.choice.choiceId);
    }
    if (node.matchingReveal) {
      const config = GroupMatchingRevealSchema.safeParse(node.matchingReveal);
      const prior = earlierChoiceNode(nodes, node, node.matchingReveal);
      const priorIndex = prior ? nodes.indexOf(prior) : -1;
      const question = nodes.slice(priorIndex + 1, nodes.indexOf(node)).find(n => n.nodeId === node.matchingReveal!.afterQuestionNodeId);
      if (!config.success || node.type !== "dm_prompt" || node.choice || node.choiceRecap || node.choiceEnding || node.textExecution || node.whenChoice || node.clueAction ||
        !SourceEvidenceSchema.safeParse(node.sourceEvidence).success || prior?.choice?.type !== "group_matching" || prior.choice.resultMode !== "deferred" ||
        prior.actIndex !== node.actIndex || !question?.textExecution?.wait || question.actIndex !== node.actIndex || question.textExecution.when || question.whenChoice)
        invalidChoice("延迟公布必须引用本幕更早的延迟匹配，以及匹配之后的无条件有界提问。");
    }
    if (node.choice?.type === "group_matching" && node.choice.resultMode === "deferred") {
      const choice = node.choice;
      const all = flows.flatMap(f => f.nodes);
      const publications = all.filter(n => n.matchingReveal?.choiceId === choice.choiceId && n.matchingReveal.round === choice.round);
      const later = all.slice(all.indexOf(node) + 1);
      if (publications.length !== 1 || !later.includes(publications[0]) || publications[0].actIndex !== node.actIndex ||
        later.slice(0, later.indexOf(publications[0])).some(n => n.choice?.choiceId === choice.choiceId))
        invalidChoice("每轮延迟匹配必须在本幕及下一轮之前有且只有一次正式公布。");
    }
    const ref = node.choiceRecap ?? node.whenChoice;
    if (ref) {
      const earlier = earlierChoiceNode(nodes, node, ref);
      if (!selected.some(f => f.actIndex === node.actIndex && f.nodes.includes(node)) || !earlier || !RuntimeChoiceSchema.safeParse(earlier.choice).success || !SourceEvidenceSchema.safeParse(node.sourceEvidence).success ||
        node.choiceRecap && (!ChoiceRecapSchema.safeParse(node.choiceRecap).success || node.type !== "dm_prompt" || node.textExecution || node.whenChoice) ||
        node.whenChoice && (!ChoiceEqualsSchema.safeParse(node.whenChoice).success || !node.textExecution || node.textExecution.when ||
          ("correctCount" in node.whenChoice ? earlier.choice?.type !== "group_matching" || node.whenChoice.correctCount > earlier.targetRoleNames.length :
            ("participant" in node.whenChoice ? earlier.choice?.participants !== "human" :
            !definition.roles.some(r => "roleName" in node.whenChoice! && r.roleName === node.whenChoice.roleName) ||
            scope && !scope.roleNames.includes(node.whenChoice.roleName) ||
            earlier.choice?.participants === "targets" && !earlier.targetRoleNames.includes(node.whenChoice.roleName)) ||
            !earlier.choice?.options.some(o => "optionId" in node.whenChoice! && o.optionId === node.whenChoice.optionId)))) invalidChoice("回顾/相等条件必须引用范围内更早的合法选择、角色和选项。");
    }
    if (node.whenChoice && "correctCount" in node.whenChoice) {
      const prior = earlierChoiceNode(nodes, node, node.whenChoice);
      if (prior?.choice?.type === "group_matching" && prior.choice.resultMode === "deferred" &&
        !nodes.slice(nodes.indexOf(prior) + 1, nodes.indexOf(node)).some(n => n.matchingReveal?.choiceId === prior.choice!.choiceId &&
          n.matchingReveal.round === (prior.choice as { round: number }).round)) invalidChoice("未公布分数不得驱动可见剧情分支。");
    }
    if (node.choiceEnding) {
      const config = ChoiceEndingSchema.safeParse(node.choiceEnding);
      const prior = earlierChoiceNode(nodes, node, node.choiceEnding);
      const finalAct = definition.acts.at(-1)?.actIndex;
      if (!config.success || node.type !== "ending_reveal" || node.actIndex !== finalAct ||
        !selected.some(f => f.nodes.includes(node)) || node.choice || node.choiceRecap || node.matchingReveal || node.whenChoice || node.textExecution || node.clueAction ||
        !SourceEvidenceSchema.safeParse(node.sourceEvidence).success || prior?.choice?.type === "group_matching" ||
        prior?.choice?.participants !== "all_players" || !prior.choice.options.some(o => o.optionId === node.choiceEnding!.unanimousOptionId) ||
        [node.choiceEnding.unanimous, node.choiceEnding.otherwise].some(t => t.text.trim() !== t.evidence.sourceQuote.trim() ||
          node.forbiddenReveals.some(s => s.trim() && t.text.includes(s.trim()))) ||
        nodes.filter(n => n.choiceEnding).length !== 1 ||
        selected.find(f => f.nodes.includes(node))?.nodes.slice(selected.find(f => f.nodes.includes(node))!.nodes.indexOf(node) + 1).some(n => n.type !== "transition"))
        issues.push({ code: "INVALID_CHOICE_ENDING", message: `${node.nodeId}: 结局需最后一幕完整全员选择、互斥固定来源正文及末尾转场。`, fatal: true });
    }
    if (ids.has(node.nodeId)) issues.push({ code: "DUPLICATE_DM_NODE_ID", message: `DM nodeId 重复：${node.nodeId}`, fatal: true });
    ids.add(node.nodeId);
    if (node.textExecution) {
      const config = DMFlowNodeSchema.shape.textExecution.safeParse(node.textExecution);
      const text = node.fixedLine?.trim();
      const allowedType = ["fixed_line", "dm_prompt", "performance_instruction"].includes(node.type);
      const evidence = SourceEvidenceSchema.safeParse(node.sourceEvidence);
      const ownerFlow = selected.find(f => f.nodes.some(n => n.nodeId === node.nodeId));
      const when = node.textExecution.when;
      const earlier = when && ownerFlow?.nodes.slice(0, ownerFlow.nodes.indexOf(node)).find(n => n.nodeId === when.questionNodeId);
      if (!config.success || !allowedType || !text || !evidence.success ||
        node.textExecution.fidelity === "fixed" && text !== node.sourceEvidence?.sourceQuote.trim() ||
        node.type === "performance_instruction" && (node.performance?.kind !== "npc_line" || node.clueRefs.length > 0 || isStageOperation(node)) ||
        node.forbiddenReveals.some(secret => secret.trim() && text.includes(secret.trim())) ||
        node.textExecution.wait && node.textExecution.wait.maxWaitMs > 300_000 ||
        when && (!earlier?.textExecution?.wait || when.roleName && !definition.roles.some(r => r.roleName === when.roleName))) {
        issues.push({ code: "INVALID_TEXT_EXECUTION", message: `${node.nodeId}: 文字执行需完整来源、合法类型、前置交互及安全正文。`, fatal: true });
      }
    }
    if (node.discussionExit && (!DMFlowNodeSchema.shape.discussionExit.safeParse(node.discussionExit).success ||
      node.type !== "free_discussion" || node.discussionExit.maxMessages < node.discussionExit.minMessages ||
      node.discussionExit.questionWaitMs > 300_000 || !selected.some(f => f.nodes.includes(node) &&
        f.nodes.slice(f.nodes.indexOf(node) + 1).some(n => n.textExecution)))) {
      issues.push({ code: "INVALID_DISCUSSION_EXIT", message: `${node.nodeId}: 讨论结束条件或后续文字流程无效。`, fatal: true });
    }
    for (const rule of node.conditionalRules.filter(r => r.publicPointClaims !== undefined)) {
      const compact = (s: string) => s.replace(/[\s，。！？、：；,.!?:;“”"'（）()]/g, "");
      const cue = compact(rule.responseText ?? "");
      if (node.type !== "free_discussion" || rule.triggerType !== "missing_public_point" || rule.responseType !== "fixed_answer" ||
        !node.requiredPublicPoints.includes(rule.conditionText) || !rule.sourceQuote?.trim() ||
        node.conditionalRules.filter(r => r.ruleId === rule.ruleId).length !== 1 ||
        !cue || (rule.responseText?.length ?? 0) > 240 || !rule.publicPointClaims?.length || rule.publicPointClaims.some(k => compact(k).length < 4) ||
        [...node.forbiddenReveals, ...node.requiredPublicPoints, ...(rule.publicPointClaims ?? []), ...rule.keywords].some(k => compact(k).length >= 4 && cue.includes(compact(k))) ||
        rule.targetRoleNames.some(r => !definition.roles.some(role => role.roleName === r) || scope && !scope.roleNames.includes(r))) {
        issues.push({ code: "INVALID_PUBLIC_POINT_RULE", message: `${node.nodeId}/${rule.ruleId}: 累计观察规则缺少完整事实、合法目标或安全补问。`, fatal: true });
      }
    }
    if (!types.has(node.type) || node.warnings.some(w => w.startsWith("UNSUPPORTED_DM_NODE_TYPE"))) issues.push({ code: "UNSUPPORTED_DM_NODE_TYPE", message: `不支持的 DM 节点类型：${node.nodeId}`, fatal: true });
    if (node.variantGroup || node.branchId) issues.push({ code: "UNRESOLVED_VARIANT", message: `${node.nodeId} 的互斥分支尚未选择，needs_attention。`, fatal: true });
    for (const message of clueNodeErrors(definition, nodes, node, scope?.roleNames)) issues.push({ code: "INVALID_RUNTIME_CLUE", message: `${node.nodeId}: ${message}`, fatal: true });
    if (node.type === "clue_release" && !node.clueAction || node.type === "performance_instruction" && !node.textExecution) issues.push({ code: "unsupported_runtime_capability", message: `${node.nodeId}: Runtime 不支持自动执行未配置的 ${node.type}。`, fatal: true });
    if (node.type === "dm_prompt" && isStageOperation(node)) issues.push({ code: "STAGE_OPERATION_AS_DM_PROMPT",
      message: `${node.nodeId} 将 BGM/舞台操作解析为 dm_prompt，禁止自动作为聊天执行。`, fatal: false, actIndex: node.actIndex ?? undefined });
    const targets = [...node.targetRoleNames, ...node.expectedSpeakerRoleNames, ...(node.textExecution?.when?.roleName ? [node.textExecution.when.roleName] : [])];
    if (scope && targets.some(r => !scope.roleNames.includes(r))) issues.push({ code: "DM_TARGET_OUT_OF_SCOPE",
      message: `${node.nodeId} 的目标角色不在运行范围：${targets.filter(r => !scope.roleNames.includes(r)).join("、")}`, fatal: true });
    if (scope && node.type === "ending_reveal" && !node.choiceEnding) issues.push({ code: "DM_REVEAL_IN_ACT_FLOW",
      message: `${node.nodeId} 在普通幕内包含结局揭晓，需人工确认授权。`, fatal: true });
  }
  return issues;
}

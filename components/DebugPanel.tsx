"use client";

import { useState } from "react";
import { ManualControlDetails, SourceEvidenceDetails, ValidationProvenance } from "@/components/ManualContractDetails";
import type {
  AgentRunDebugView,
  AutoDiscussionDebugView,
  DMFlowCursorDebugView,
  GameSessionRestoreWarning,
  ReactionExecutionDebugView,
  ReactionPlanDebugView
} from "@/src/lib/services/gameRuntimeSnapshotService";

type DebugPanelProps = {
  shareDrafts: import("@/src/lib/services/gameRuntimeSnapshotService").GameRuntimeSnapshot["shareDrafts"];
  runs: AgentRunDebugView[];
  reactionPlan: ReactionPlanDebugView | null;
  reactionExecution: ReactionExecutionDebugView | null;
  autoDiscussion: AutoDiscussionDebugView | null;
  dmFlowCursor: DMFlowCursorDebugView;
  restoreWarnings: GameSessionRestoreWarning[];
  reactionExecutionPending: boolean;
  onExecuteSelectedReactions: () => void;
  onDMFlowAction: (action: string, payload?: Record<string, unknown>) => void;
};

const agentLabels: Record<string, string> = {
  ai_player_internal_reading: "AI 读本",
  ai_player_public_share: "AI 分享",
  ai_share_visible: "AI 分享可见关键路径",
  share_draft: "AI 分享预生成",
  post_share_discussion: "分享后后台讨论",
  share_checker: "分享检查",
  story_board_writer: "故事板",
  ai_player_reaction_planner: "反应规划",
  discussion_orchestrator: "讨论调度",
  ai_player_discussion_utterance: "AI 讨论发言",
  discussion_checker: "讨论检查",
  discussion_checker_deterministic: "讨论规则检查",
  discussion_reaction_executor: "执行反应",
  auto_discussion_runner: "自动讨论",
  dm_flow_runner: "DM Flow",
  dm_discussion_analyzer: "DM 讨论分析",
  dm_node_realizer: "DM 话术生成",
  dm_agent_guided: "DM 引导生成",
  dm_output_checker: "DM 检查",
  dm_semantic_observer: "公开信息语义观察",
  dm_lifecycle_evaluation: "DM 阶段推进",
  dm_reference_fallback: "DM 参考话术回退",
  dm_text_flow: "DM 文字流程"
};

export function DebugPanel({
  shareDrafts,
  runs,
  reactionPlan,
  reactionExecution,
  autoDiscussion,
  dmFlowCursor,
  restoreWarnings,
  reactionExecutionPending,
  onExecuteSelectedReactions,
  onDMFlowAction
}: DebugPanelProps) {
  return (
    <aside className="max-h-[42%] shrink-0 space-y-3 overflow-y-auto rounded-lg border border-ink/10 bg-white/90 p-4 shadow-panel">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">Debug</p>
        <h2 className="mt-1 text-sm font-semibold text-ink">AI 调试信息</h2>
      </div>

      <ReactionPlanSection
        plan={reactionPlan}
        pending={reactionExecutionPending}
        onExecuteSelectedReactions={onExecuteSelectedReactions}
      />
      <AutoDiscussionSection autoDiscussion={autoDiscussion} />
      {shareDrafts.length ? (
        <section className="border-t border-ink/10 pt-3 text-xs">
          <h3 className="mb-2 font-semibold text-ink">分享准备状态</h3>
          {shareDrafts.map((draft) => (
            <div key={draft.id} className="flex flex-wrap justify-between gap-2 py-1 text-ink/65">
              <span>{draft.actId} / {draft.roleId}</span>
              <span>{draft.status} · attempt {draft.attemptCount}</span>
            </div>
          ))}
        </section>
      ) : null}
      <RestoreWarningsSection warnings={restoreWarnings} />
      <DMFlowCursorSection
        dmFlowCursor={dmFlowCursor}
        reactionPlan={reactionPlan}
        onDMFlowAction={onDMFlowAction}
        fsmLocked={reactionExecutionPending}
      />
      <ReactionExecutionSection execution={reactionExecution} />

      {runs.length === 0 ? (
        <p className="mt-3 text-xs leading-5 text-ink/55">暂无公开分享相关调用。</p>
      ) : (
        <div className="mt-3 space-y-2">
          {runs.map((run) => (
            <article key={run.id} className="rounded-md border border-ink/10 bg-paper/70 p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 truncate text-xs font-semibold text-ink">
                  {getAgentLabel(run.agentType)}
                </p>
                <StatusPill status={run.status} />
              </div>
              <p className="mt-2 text-xs leading-5 text-ink/60">
                {run.runKind} · {run.provider?.toUpperCase() ?? "Provider 未记录"} / {run.model ?? "no model"} · {run.latencyMs ?? "-"} ms
              </p>
              {run.traceId ? (
                <p className="mt-1 truncate font-mono text-[11px] leading-4 text-ink/45">
                  trace {run.traceId.slice(0, 12)}
                </p>
              ) : null}
              {run.runKind === "llm" ? (
                <p className="mt-1 text-xs leading-5 text-ink/60">
                  tokens {run.inputTokens ?? "-"} → {run.outputTokens ?? "-"} · reasoning{" "}
                  {run.reasoningTokens ?? "-"} · cached {run.cachedInputTokens ?? "-"} · retries{" "}
                  {run.retryCount ?? "-"}
                </p>
              ) : null}
              {run.promptChars !== null ? (
                <p className="mt-1 text-xs leading-5 text-ink/50">
                  prompt {run.promptChars} chars · output {run.outputChars ?? "-"} chars · TTFT{" "}
                  {run.ttftMs === null ? "非流式不可测" : `${run.ttftMs} ms`}
                </p>
              ) : null}
              {run.detail ? (
                <p className="mt-1 line-clamp-3 text-xs leading-5 text-ink/60">
                  {run.detail}
                </p>
              ) : null}
              {run.errorMessage ? (
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-ember">
                  {run.errorMessage}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </aside>
  );
}

function getAgentLabel(agentType: string): string {
  if (agentType.startsWith("interaction:")) {
    return `端到端 ${agentType.slice("interaction:".length)}`;
  }

  return agentLabels[agentType] ?? agentType;
}

function DMFlowCursorSection({
  dmFlowCursor,
  reactionPlan,
  onDMFlowAction,
  fsmLocked
}: {
  dmFlowCursor: DMFlowCursorDebugView;
  reactionPlan: ReactionPlanDebugView | null;
  onDMFlowAction: (action: string, payload?: Record<string, unknown>) => void;
  fsmLocked: boolean;
}) {
  const [jumpNodeId, setJumpNodeId] = useState("");

  if (!dmFlowCursor.available) {
    return (
      <fieldset disabled={fsmLocked} className="rounded-md border border-ink/10 bg-paper/70 p-3">
        <p className="text-xs font-semibold text-ink">恢复工具</p>
        <p className="mt-1 text-xs text-ink/60">Runtime 模式：legacy_demo</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <DebugActionButton label="重新加载" onClick={() => onDMFlowAction("reload_state")} />
          <DebugActionButton
            label="重置讨论预算"
            onClick={() => onDMFlowAction("reset_discussion_budget")}
          />
          <DebugActionButton
            label="重新绑定 Runtime"
            danger
            onClick={() => onDMFlowAction("rebind_latest_runtime_definition")}
          />
          <DebugActionButton
            label="清空反应选择"
            onClick={() => onDMFlowAction("clear_selected_reactions")}
          />
        </div>
      </fieldset>
    );
  }

  const cursor = dmFlowCursor.cursor;
  const pendingQuestionPlanningMismatch =
    dmFlowCursor.pendingDMQuestion &&
    reactionPlan?.latestMessage.message_id !== dmFlowCursor.pendingDMQuestion.messageId;

  return (
    <fieldset disabled={fsmLocked} className="rounded-md border border-ink/10 bg-paper/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold text-ink">DMFlow Cursor</p>
        <StatusPill status={cursor?.waitingFor === "test_scope_end" ? "pending" : "success"} />
      </div>
      <p className="mt-1 text-xs leading-5 text-ink/60">
        模式 {dmFlowCursor.runtimeMode ?? "legacy_demo"} · definition {dmFlowCursor.definitionId ?? "-"} · v{dmFlowCursor.definitionVersion ?? "-"}
      </p>
      {dmFlowCursor.manualContract ? <div>
        <ValidationProvenance
          stored={{ validatorVersion: dmFlowCursor.manualContract.storedValidatorVersion, validatedAt: dmFlowCursor.manualContract.storedValidatedAt ?? undefined }}
          current={{ validatorVersion: dmFlowCursor.manualContract.currentValidatorVersion, validatedAt: dmFlowCursor.manualContract.currentValidatedAt ?? undefined }} />
        <p className="text-xs break-words">Runtime 支持：{dmFlowCursor.manualContract.capabilities.join(", ")}</p>
        {dmFlowCursor.manualContract.control ? <ManualControlDetails control={dmFlowCursor.manualContract.control} /> : <p className="text-xs">Legacy control · 未推断新 conversationPolicy</p>}
        {dmFlowCursor.manualContract.source ? <SourceEvidenceDetails source={dmFlowCursor.manualContract.source} status="frozen runtime source" /> : null}
      </div> : null}
      <p className="mt-1 text-xs leading-5 text-ink/60">
        恢复 {cursor?.lifecycle?.recoveryStatus ?? "尚未迁移"} · {cursor?.lifecycle?.recoveryNeedsAttention ?? "无待处理问题"}
      </p>
      <p className="mt-1 text-xs leading-5 text-ink/60">
        最近判断 {dmFlowCursor.lastLifecycleEvaluation?.trigger ?? cursor?.lifecycle?.lastEvaluation?.trigger ?? "-"} · {dmFlowCursor.lastLifecycleEvaluation?.result ?? cursor?.lifecycle?.lastEvaluation?.result ?? "-"} · {dmFlowCursor.lastLifecycleEvaluation?.reason ?? cursor?.lifecycle?.lastEvaluation?.reason ?? "-"} · {dmFlowCursor.lastLifecycleEvaluation?.time ?? cursor?.lifecycle?.lastEvaluation?.evaluatedAt ?? "-"}
      </p>
      <p className="mt-1 text-xs leading-5 text-ink/60">
        最近 DM 来源 {dmFlowCursor.lastDmMessageSourceNodeId ?? "无真实节点"} · {dmFlowCursor.lastDmMessageSourceMode ?? "-"}
      </p>
      <p className="mt-1 text-xs leading-5 text-ink/60">
        当前：{dmFlowCursor.currentNode?.type ?? "-"} · {dmFlowCursor.currentNode?.nodeId ?? "-"}
      </p>
      <p className="mt-1 text-xs leading-5 text-ink/60">
        act {cursor?.actIndex ?? "-"} · nodeIndex {cursor?.nodeIndex ?? "-"} · waitingFor{" "}
        {cursor?.waitingFor ?? "-"}
      </p>
      <p className="mt-1 text-xs leading-5 text-ink/60">
        next {dmFlowCursor.nextNode?.type ?? "-"} · completed {cursor?.completedNodeIds.length ?? 0} · consumed{" "}
        {cursor?.consumedNodeIds.length ?? 0}
      </p>
      <p className="mt-1 text-xs leading-5 text-ink/60">
        conditionalRules {dmFlowCursor.attachedConditionalRulesCount} · triggered{" "}
        {dmFlowCursor.triggeredRuleIds.length} · lastReason {cursor?.lastAdvanceReason ?? "-"}
      </p>
      <p className="mt-1 text-xs leading-5 text-ink/60">
        outputMode {dmFlowCursor.currentNodeOutputMode ?? "-"} · action{" "}
        {dmFlowCursor.lastAnalysis?.suggestedDmAction ?? "-"}
      </p>
      <p className="mt-1 text-xs leading-5 text-ink/60">
        autoExecuted {String(dmFlowCursor.nextNodeAutoExecuted)} · pendingQuestion{" "}
        {dmFlowCursor.pendingDMQuestion?.status ?? "-"}
      </p>
      {cursor?.publicPointCoverage || cursor?.conditionObservations ? <details className="mt-3 text-xs">
        <summary className="cursor-pointer font-semibold">公开信息观察与消息证据</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-2">
          {JSON.stringify({ coverage: cursor?.publicPointCoverage, conditions: cursor?.conditionObservations }, null, 2)}
        </pre>
      </details> : null}
      {dmFlowCursor.pendingDMQuestion ? (
        <div className="mt-3 rounded-sm bg-white/70 p-2">
          <p className="text-xs font-semibold text-ink">Pending DM Question</p>
          <p className="mt-1 text-xs leading-5 text-ink/60">
            target {dmFlowCursor.pendingDMQuestion.targetRoleNames.join("、") || "全体"} · cues{" "}
            {dmFlowCursor.pendingDMQuestion.cueCount} · answered{" "}
            {dmFlowCursor.pendingDMQuestion.answeredByRoleNames.join("、") || "-"}
          </p>
          <p className="mt-1 line-clamp-3 text-xs leading-5 text-ink/60">
            {dmFlowCursor.pendingDMQuestion.questionText}
          </p>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-ink/50">
            topics {dmFlowCursor.pendingDMQuestion.expectedTopics.join("、") || "-"}
          </p>
          {pendingQuestionPlanningMismatch ? (
            <p className="mt-2 rounded-sm bg-amber-50 px-2 py-1.5 text-xs leading-5 text-brass">
              pending question 尚未触发 AI planning；最近 planning seed 是{" "}
              {reactionPlan?.latestMessage.content ?? "空"}。
            </p>
          ) : null}
        </div>
      ) : null}
      {dmFlowCursor.lastPendingQuestionEvaluation ? (
        <div className="mt-3 rounded-sm bg-white/70 p-2">
          <p className="text-xs font-semibold text-ink">Question Evaluation</p>
          <p className="mt-1 text-xs leading-5 text-ink/60">
            answered {String(dmFlowCursor.lastPendingQuestionEvaluation.answered)} · partial{" "}
            {String(dmFlowCursor.lastPendingQuestionEvaluation.partial)} · cue{" "}
            {String(dmFlowCursor.lastPendingQuestionEvaluation.shouldCueAnotherRole)} · advance{" "}
            {String(dmFlowCursor.lastPendingQuestionEvaluation.shouldAdvanceFlow)}
          </p>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-ink/60">
            {dmFlowCursor.lastPendingQuestionEvaluation.reason}
          </p>
        </div>
      ) : null}
      {dmFlowCursor.lastAnalysis?.publicSummary.length ? (
        <DebugList
          title="DM Analysis Summary"
          emptyText="暂无公开总结。"
          items={dmFlowCursor.lastAnalysis.publicSummary.slice(0, 3).map((item, index) => ({
            key: `dm_analysis_summary_${index}`,
            title: `summary ${index + 1}`,
            body: item
          }))}
        />
      ) : null}
      {dmFlowCursor.lastAnalysis?.missingPoints.length ? (
        <DebugList
          title="Missing Points"
          emptyText="暂无缺失点。"
          items={dmFlowCursor.lastAnalysis.missingPoints.slice(0, 3).map((item, index) => ({
            key: `dm_missing_${index}_${item.point}`,
            title: `${item.risk} · ${item.cueSafely ? "can cue" : "broad cue only"}`,
            body: `${item.point}｜${item.cueHint}`
          }))}
        />
      ) : null}
      {dmFlowCursor.lastRealizedSpeech ? (
        <div className="mt-3 rounded-sm bg-white/70 p-2">
          <p className="text-xs font-semibold text-ink">Realized Speech</p>
          <p className="mt-1 text-xs leading-5 text-ink/60">
            {dmFlowCursor.lastRealizedSpeech.sourceMode} · advance{" "}
            {String(dmFlowCursor.lastRealizedSpeech.shouldAdvanceAfterSpeaking)} · wait{" "}
            {String(dmFlowCursor.lastRealizedSpeech.shouldWaitForUser)}
          </p>
          <p className="mt-1 line-clamp-4 text-xs leading-5 text-ink/60">
            {dmFlowCursor.lastRealizedSpeech.text}
          </p>
        </div>
      ) : null}
      {dmFlowCursor.currentNode?.sourceQuote ? (
        <p className="mt-2 line-clamp-3 text-xs leading-5 text-ink/55">
          sourceQuote: {dmFlowCursor.currentNode.sourceQuote}
        </p>
      ) : null}
      {dmFlowCursor.warnings.length ? (
        <DebugList
          title="Cursor Warnings"
          emptyText="无 warning。"
          items={dmFlowCursor.warnings.slice(-4).map((warning, index) => ({
            key: `cursor_warning_${index}_${warning}`,
            title: "warning",
            body: warning
          }))}
        />
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <DebugActionButton label="重新加载" onClick={() => onDMFlowAction("reload_state")} />
        <DebugActionButton label="执行当前节点" onClick={() => onDMFlowAction("execute_current")} />
        <DebugActionButton
          label="完成并前进"
          onClick={() => onDMFlowAction("complete_and_advance")}
        />
        <DebugActionButton
          label="检查条件规则"
          onClick={() => onDMFlowAction("check_conditional_rules")}
        />
        <DebugActionButton
          label="重置讨论预算"
          onClick={() => onDMFlowAction("reset_discussion_budget")}
        />
        <DebugActionButton
          label="清空反应选择"
          onClick={() => onDMFlowAction("clear_selected_reactions")}
        />
        <DebugActionButton
          label="重新绑定 Runtime"
          danger
          onClick={() => onDMFlowAction("rebind_latest_runtime_definition")}
        />
        <DebugActionButton
          label="重置 Cursor"
          danger
          onClick={() => onDMFlowAction("reset_cursor")}
        />
      </div>
      <div className="mt-3 flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-md border border-ink/10 bg-white px-2 py-1.5 text-xs text-ink outline-none focus:border-pine/50"
          value={jumpNodeId}
          onChange={(event) => setJumpNodeId(event.target.value)}
          placeholder="DMFlow nodeId"
        />
        <button
          type="button"
          className="shrink-0 rounded-md border border-ink/15 bg-white px-2 py-1.5 text-xs font-semibold text-ink transition hover:bg-paper"
          onClick={() => onDMFlowAction("jump_to_node", { nodeId: jumpNodeId })}
        >
          跳转
        </button>
      </div>
    </fieldset>
  );
}

function RestoreWarningsSection({ warnings }: { warnings: GameSessionRestoreWarning[] }) {
  if (!warnings.length) {
    return null;
  }

  return (
    <section className="rounded-md border border-amber-300/50 bg-amber-50 p-3">
      <p className="text-xs font-semibold text-ink">恢复提示</p>
      <div className="mt-2 space-y-2">
        {warnings.map((warning, index) => (
          <p key={`${warning.code}_${index}`} className="text-xs leading-5 text-ink/70">
            {warning.severity} · {warning.code}：{warning.message}
          </p>
        ))}
      </div>
    </section>
  );
}

function DebugActionButton({
  label,
  danger = false,
  onClick
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={
        danger
          ? "rounded-md border border-ember/30 bg-white px-2 py-1.5 text-xs font-semibold text-ember transition hover:bg-ember/5"
          : "rounded-md border border-ink/15 bg-white px-2 py-1.5 text-xs font-semibold text-ink transition hover:bg-paper"
      }
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function AutoDiscussionSection({
  autoDiscussion
}: {
  autoDiscussion: AutoDiscussionDebugView | null;
}) {
  if (!autoDiscussion) {
    return (
      <section className="rounded-md border border-ink/10 bg-paper/70 p-3">
        <p className="text-xs font-semibold text-ink">自动讨论</p>
        <p className="mt-2 text-xs leading-5 text-ink/55">暂无自动讨论执行记录。</p>
      </section>
    );
  }

  return (
    <section className="rounded-md border border-ink/10 bg-paper/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold text-ink">自动讨论</p>
        <StatusPill status={autoDiscussion.dmCloseTriggered ? "pending" : "success"} />
      </div>
      <p className="mt-1 text-xs leading-5 text-ink/60">
        stopReason: {autoDiscussion.stopReason} · waves {autoDiscussion.waves.length} · AI 回复{" "}
        {autoDiscussion.totalAiReplies}
      </p>
      <p className="mt-1 text-xs leading-5 text-ink/60">
        模式 {autoDiscussion.mode} · phase {autoDiscussion.phase}
        {autoDiscussion.dmCloseTriggered ? " · 已触发 DM 收束" : ""}
      </p>

      <DebugList
        title="Waves"
        emptyText="没有执行 wave。"
        items={autoDiscussion.waves.map((wave) => ({
          key: `wave_${wave.waveIndex}_${wave.seedMessageId}`,
          title: `wave ${wave.waveIndex} · ${wave.phase}`,
          body: [
            `selected ${wave.selectedReactions.length}`,
            `created ${wave.createdMessageIds.length}`,
            `blocked ${wave.blockedCount}`,
            wave.stopReason ? `stop ${wave.stopReason}` : ""
          ]
            .filter(Boolean)
            .join("｜")
        }))}
      />
    </section>
  );
}

function ReactionPlanSection({
  plan,
  pending,
  onExecuteSelectedReactions
}: {
  plan: ReactionPlanDebugView | null;
  pending: boolean;
  onExecuteSelectedReactions: () => void;
}) {
  if (!plan) {
    return (
      <section className="rounded-md border border-ink/10 bg-paper/70 p-3">
        <p className="text-xs font-semibold text-ink">最近反应规划</p>
        <p className="mt-2 text-xs leading-5 text-ink/55">暂无 ReactionIntent。</p>
      </section>
    );
  }

  const selectedCount = plan.schedulerResult.selected_reactions.length;
  const classification = plan.triggerClassification;

  return (
    <section className="rounded-md border border-ink/10 bg-paper/70 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink">最近反应规划</p>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-ink/60">
            {plan.latestMessage.speaker_name ?? plan.latestMessage.speaker_role_id ?? "未知角色"}：
            {plan.latestMessage.content}
          </p>
          <p className="mt-1 text-xs leading-5 text-ink/55">
            speechAct {plan.latestMessage.speech_act} · targets{" "}
            {(plan.latestMessage.target_role_ids ?? []).join("、") || "-"}
          </p>
        </div>
        <StatusPill status={plan.schedulerResult.should_dm_intervene ? "pending" : "success"} />
      </div>

      {plan.addressing ? (
        <div className="mt-3 bg-white/70 p-2 text-xs leading-5 text-ink/65 break-words">
          <p className="font-semibold text-ink">提问对象识别</p>
          <p>模式：{plan.addressing.addressingMode} · 来源：{plan.addressing.source === "planner" ? "Planner 语义判断" : "规则预分析"}</p>
          <p>直接提问 directTargets：{plan.addressing.directTargets.join("、") || "无"}</p>
          <p>仅被引用 referencedRoles：{plan.addressing.referencedRoles.join("、") || "无"}</p>
          <p>排除对象 excludedTargets：{plan.addressing.excludedTargets.join("、") || "无"}</p>
          <p>话题：{plan.addressing.topic || "无"}</p>
          <p>候选：{(plan.plannerCandidates ?? plan.prefilterCandidates).map((candidate) => `${candidate.roleId} (${candidate.roughScore})`).join("、") || "无"}</p>
          <p>最终回应：{plan.schedulerResult.selected_reactions.map((intent) => intent.role_id).join("、") || "无"}</p>
          <p>选择原因：{plan.addressingTrace?.selectionReason ?? plan.schedulerResult.reason}</p>
          <p>规则快路径：{plan.addressingTrace?.heuristicFastPath ? "是" : "否"} · Planner 请求：{plan.addressingTrace?.plannerCalls ?? "未知"} · 独立对象检测请求：0</p>
          {plan.addressingTrace?.plannerFailures ? <p>Planner 失败：{plan.addressingTrace.plannerFailures} 次，失败不代表角色没有信息。</p> : null}
          {plan.addressingTrace?.plannerDisagreement ? <p>候选对语义判断不一致，保留预分析，并按每个角色自己的判断约束回应。</p> : null}
        </div>
      ) : null}

      {classification ? (
        <div className="mt-3 rounded-sm bg-white/70 p-2">
          <p className="text-xs font-semibold text-ink">Trigger</p>
          <p className="mt-1 text-xs leading-5 text-ink/60">
            {classification.triggerType} · confidence {classification.confidence} · targetRoleNames{" "}
            {classification.targetRoleNames.join("、") || "-"}
          </p>
        </div>
      ) : null}

      <DebugList
        title="预筛选"
        emptyText="没有 AI 达到预筛选阈值。"
        items={plan.prefilterCandidates.map((candidate) => ({
          key: candidate.roleId,
          title: `${candidate.roleId} · ${candidate.roughScore} 分`,
          body: candidate.matchedSignals.join("；") || "无命中原因"
        }))}
      />

      <DebugList
        title="ReactionIntent"
        emptyText="没有调用 Reaction Planner。"
        items={plan.reactionIntents.map((intent) => ({
          key: intent.role_id,
          title: `${intent.role_id} · ${intent.trigger_type} · ${intent.wants_to_speak ? intent.speech_act : "不发言"}`,
          body: [
            `相关 ${intent.relevance_score}`,
            `紧急 ${intent.urgency_score}`,
            `情绪 ${intent.emotional_intensity_score}`,
            `边界 ${intent.boundary_risk}`,
            getReactionDebugFlags(intent),
            intent.brief_intent,
            intent.reason
          ].filter(Boolean).join("｜")
        }))}
      />

      <div className="mt-3 rounded-sm bg-white/70 p-2">
        <p className="text-xs font-semibold text-ink">Turn Scheduler</p>
        <p className="mt-1 text-xs leading-5 text-ink/60">{plan.schedulerResult.reason}</p>
        {plan.schedulerResult.selected_reactions.length > 0 ? (
          <p className="mt-1 text-xs leading-5 text-ink/60">
            选中：
            {plan.schedulerResult.selected_reactions
              .map((intent) => `${intent.role_id}(${intent.trigger_type}/${intent.speech_act})`)
              .join("、")}
          </p>
        ) : null}
      </div>

      <DebugList
        title="Selected / Not Selected"
        emptyText="没有可比较的 ReactionIntent。"
        items={plan.reactionIntents.map((intent) => {
          const selected = plan.schedulerResult.selected_reactions.some(
            (reaction) => reaction.role_id === intent.role_id
          );

          return {
            key: `selection_${intent.role_id}`,
            title: `${intent.role_id} · ${selected ? "selected" : "not selected"}`,
            body: selected
              ? `${intent.trigger_type} 触发，${intent.speech_act}，情绪 ${intent.emotional_intensity_score}。`
              : getNotSelectedReason(intent)
          };
        })}
      />

      <button
        type="button"
        disabled={pending || selectedCount === 0}
        onClick={onExecuteSelectedReactions}
        className="mt-3 w-full rounded-md bg-ink px-3 py-2 text-xs font-semibold text-white transition hover:bg-ink/90 disabled:cursor-not-allowed disabled:bg-ink/30"
      >
        {pending ? "正在执行选中 AI 反应..." : "执行选中 AI 反应"}
      </button>
    </section>
  );
}

function getReactionDebugFlags(intent: ReactionPlanDebugView["reactionIntents"][number]): string {
  const flags = intent as typeof intent & {
    forced_by_direct_address?: boolean;
    triggered_by_group_question?: boolean;
    scheduler_bypassed_threshold?: boolean;
  };
  const visibleFlags = [
    flags.forced_by_direct_address ? "forcedByDirectAddress" : null,
    flags.triggered_by_group_question ? "triggeredByGroupQuestion" : null,
    flags.scheduler_bypassed_threshold ? "schedulerBypassedThreshold" : null
  ].filter(Boolean);

  return visibleFlags.join(" / ");
}

function ReactionExecutionSection({
  execution
}: {
  execution: ReactionExecutionDebugView | null;
}) {
  if (!execution) {
    return (
      <section className="rounded-md border border-ink/10 bg-paper/70 p-3">
        <p className="text-xs font-semibold text-ink">最近执行结果</p>
        <p className="mt-2 text-xs leading-5 text-ink/55">暂无已执行 AI 反应。</p>
      </section>
    );
  }

  return (
    <section className="rounded-md border border-ink/10 bg-paper/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold text-ink">最近执行结果</p>
        <StatusPill status={execution.blockedReactions.length > 0 ? "pending" : "success"} />
      </div>

      <DebugList
        title="Attempts"
        emptyText="没有 attempt 记录。"
        items={(execution.attempts ?? []).map((attempt) => ({
          key: `${attempt.roleId}_${attempt.attempt}`,
          title: `${attempt.roleId} · attempt ${attempt.attempt} · ${attempt.checkerMode ?? "legacy"} · ${attempt.checkerResult.decision}`,
          body: [
            attempt.checkerLlmInvoked === false
              ? `规则检查 ${attempt.checkerDeterministicLatencyMs ?? 0}ms`
              : "调用 LLM Checker",
            attempt.candidate.content,
            attempt.checkerResult.rewrite_advice ?? "",
            ...attempt.checkerResult.leakage.items,
            ...attempt.checkerResult.boundary.items,
            ...attempt.checkerResult.intent_alignment.issues,
            ...attempt.checkerResult.role_consistency.issues,
            ...attempt.checkerResult.quality.issues
          ]
            .filter(Boolean)
            .join("；")
        }))}
      />

      <DebugList
        title="创建的 Message"
        emptyText="没有写入正式 AI 讨论消息。"
        items={execution.createdMessages.map((message) => ({
          key: message.message_id,
          title: `${message.speaker_name ?? message.speaker_role_id} · ${message.speech_act}`,
          body: message.content
        }))}
      />

      <DebugList
        title="Checker"
        emptyText="没有 checker 结果。"
        items={execution.checkerResults.map((result, index) => ({
          key: `${result.decision}_${index}`,
          title: `${result.decision} · ${result.passed ? "通过" : "未通过"}`,
          body: [
            ...result.leakage.items,
            ...result.boundary.items,
            ...result.intent_alignment.issues,
            ...result.role_consistency.issues,
            ...result.quality.issues,
            result.rewrite_advice ?? ""
          ]
            .filter(Boolean)
            .join("；") || "无问题"
        }))}
      />

      <DebugList
        title="Blocked"
        emptyText="没有被拦截的反应。"
        items={execution.blockedReactions.map((blocked) => ({
          key: blocked.selectedReaction.role_id,
          title: `${blocked.selectedReaction.role_id} · ${blocked.selectedReaction.speech_act}`,
          body: blocked.reason
        }))}
      />
    </section>
  );
}

function DebugList({
  title,
  emptyText,
  items
}: {
  title: string;
  emptyText: string;
  items: Array<{ key: string; title: string; body: string }>;
}) {
  return (
    <div className="mt-3">
      <p className="text-xs font-semibold text-ink">{title}</p>
      {items.length === 0 ? (
        <p className="mt-1 text-xs leading-5 text-ink/55">{emptyText}</p>
      ) : (
        <div className="mt-1 space-y-1">
          {items.map((item) => (
            <div key={item.key} className="rounded-sm bg-white/70 p-2">
              <p className="text-xs font-semibold text-ink/80">{item.title}</p>
              <p className="mt-1 line-clamp-3 text-xs leading-5 text-ink/60">{item.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function getNotSelectedReason(intent: ReactionPlanDebugView["reactionIntents"][number]): string {
  if (!intent.wants_to_speak) {
    return `Planner 判断不发言：${intent.reason}`;
  }

  if (intent.trigger_type === "minor_relevance" || intent.trigger_type === "none") {
    return "只是轻微相关或没有强触发，Scheduler 不选。";
  }

  if (intent.relevance_score < 4) {
    return `相关度 ${intent.relevance_score} 低于强触发阈值。`;
  }

  if (intent.boundary_risk === "high") {
    return "边界风险较高，优先让更安全的回应发言。";
  }

  return "有更高优先级的直接提问、负面片面描述、明显矛盾或强情绪回应。";
}

function StatusPill({ status }: { status: string }) {
  const className =
    status === "success"
      ? "bg-pine/15 text-pine"
      : status === "failed"
        ? "bg-ember/15 text-ember"
        : "bg-brass/15 text-brass";

  return (
    <span className={`shrink-0 rounded-sm px-2 py-1 text-[11px] font-semibold ${className}`}>
      {status}
    </span>
  );
}

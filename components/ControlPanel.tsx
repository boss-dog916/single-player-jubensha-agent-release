import { useState, useEffect, useRef } from "react";
import { GroupMatchingPanel } from "./GroupMatchingPanel";
import { chatEnterAction, quotePreview, chatSubmissionType, type ShareSendMode } from "./playerInteraction";
import type { GamePhase } from "@/src/lib/types/game";

type ControlPanelProps = {
  phase: GamePhase;
  isCurrentShareUser: boolean;
  isAiInternalReadingCompleted: boolean;
  isUserReadingCompleted: boolean;
  aiInternalReadingStatusText: string;
  pending: boolean;
  aiSharePending: boolean;
  postShareDiscussionPending: boolean;
  fsmActionsLocked?: boolean;
  conversationStatus?: string;
  discussionText: string;
  userShareText: string;
  readingActionLabel?: string;
  onReadingDone: () => void;
  onAiShare: () => void;
  onUserShareTextChange: (value: string) => void;
  canSubmitShare?: boolean;
  shareSendMode?: ShareSendMode;
  onShareSendModeChange?: (mode: ShareSendMode) => void;
  onDiscussionTextChange: (value: string) => void;
  onSubmitDiscussion: () => void;
  onNextAct: () => void;
  canEnterNextAct?: boolean;
  groupMatching?: import("@/src/lib/access/playerView").PlayerGameSnapshot["controls"]["groupMatching"];
  groupMatchingPending?: boolean;
  matchingInSidebar?: boolean;
  discussionSending?: boolean;
  onSubmitGroupMatching?: (assignments: { roleId: string; optionId: string }[], requestId: string) => void;
  choice?: import("@/src/lib/schemas/runtimeChoiceSchema").RuntimeChoiceView | null;
  onChooseOption?: (optionId: string, reason?: string) => void;
  textConfirmation?: { token: string; label: string; ready: boolean; kind?: "start" | "continue" | "transition" } | null;
  discussionReadiness?: import("@/src/lib/access/playerView").PlayerGameSnapshot["controls"]["discussionReadiness"];
  onConfirmText?: () => void;
  replyToMessage?: { speaker_name: string | null; content: string } | null;
  onCancelReply?: () => void;
};

export function ControlPanel({
  phase,
  isCurrentShareUser,
  isAiInternalReadingCompleted,
  isUserReadingCompleted,
  aiInternalReadingStatusText,
  pending,
  aiSharePending,
  postShareDiscussionPending,
  fsmActionsLocked = false,
  conversationStatus,
  discussionText,
  userShareText,
  readingActionLabel,
  onReadingDone,
  onAiShare,
  onUserShareTextChange,
  canSubmitShare = false,
  shareSendMode = "auto",
  onShareSendModeChange,
  onDiscussionTextChange,
  onSubmitDiscussion,
  onNextAct,
  canEnterNextAct = true,
  groupMatching,
  groupMatchingPending = false,
  matchingInSidebar = false,
  discussionSending = false,
  onSubmitGroupMatching,
  choice,
  onChooseOption,
  textConfirmation,
  discussionReadiness,
  onConfirmText,
  replyToMessage,
  onCancelReply
}: ControlPanelProps) {
  const discussionInputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (replyToMessage) discussionInputRef.current?.focus(); }, [replyToMessage?.content]);
  const composing = useRef(false);
  const submitGuard = useRef(false);
  const submitDiscussion = () => {
    if (sendBlocked || submitGuard.current || !discussionText.trim()) return;
    submitGuard.current = true;
    onSubmitDiscussion();
    queueMicrotask(() => { submitGuard.current = false; });
  };
  const [finalReason, setFinalReason] = useState("");
  const actionsLocked = postShareDiscussionPending || fsmActionsLocked;
  const sendsShare = chatSubmissionType({ canShare: canSubmitShare, replyToMessageId: replyToMessage ? "reply" : null,
    content: discussionText, mode: shareSendMode }) === "USER_SHARE";
  const sendBlocked = discussionSending || Boolean(sendsShare && (pending || actionsLocked));
  const performing = phase === "dm_question" && !groupMatching && textConfirmation?.kind !== "start";
  return (
    <footer className="max-h-[48dvh] overflow-y-auto shrink-0 rounded-lg border border-ink/10 bg-white/90 p-4 shadow-panel">
      {groupMatching && !matchingInSidebar ? <GroupMatchingPanel key={groupMatching.nodeId} matching={groupMatching}
        pending={groupMatchingPending} onSubmit={onSubmitGroupMatching} /> : null}
      {choice ? <div className="mb-3 grid gap-2" aria-label="剧情选择">
        <PanelNote text={choice.prompt} />
        {choice.requiresReason ? <label className="grid gap-1 text-sm">最终决定的理由<textarea aria-label="最终决定的理由" maxLength={2000} value={finalReason} onChange={e => setFinalReason(e.target.value)} disabled={!choice.canSubmit || pending} className="rounded border p-2" /></label> : null}
        <div className="flex flex-wrap gap-2">{choice.options.map(option => <PrimaryButton key={option.optionId}
          label={`${option.label}${choice.ownOptionId === option.optionId ? "（已提交）" : ""}`}
          onClick={() => onChooseOption?.(option.optionId, choice.requiresReason ? finalReason.trim() : undefined)} disabled={pending || actionsLocked || !choice.canSubmit || Boolean(choice.requiresReason && !finalReason.trim())} />)}</div>
        <PanelNote text={`已提交 ${choice.participants.filter(p => p.completed).length}/${choice.participants.length}；请完成当前节点要求。`} />
        {choice.participants.filter(p => p.error && !p.completed).map(p => <PanelNote key={p.roleId}
          text={`${p.roleId}选择暂未成功（${p.attempts}/2次）：${p.error}${p.attempts >= 2 ? "；保留待办，停止自动重试。" : ""}`} />)}
      </div> : null}
      {discussionReadiness ? <PanelNote text={discussionReadiness.pendingRoleIds.length
        ? `自由讨论中，等待${discussionReadiness.pendingRoleIds.join("、")}完整分享本幕经历。`
        : !discussionReadiness.humanExpressed ? "大家已分享，你也可以说说自己的经历。"
        : discussionReadiness.pendingQuestions.length ? `角色正在回应；未完成的回应会自动补试，仍失败则继续。`
        : !discussionReadiness.ready ? "大家可以继续核对；讨论暂歇后，DM 会接手。" : "本轮分享与核对已收束，DM 可以接手。"} /> : null}
      {discussionReadiness?.skippedQuestions?.length ? <PanelNote text={`${[...new Set(discussionReadiness.skippedQuestions.map(q => q.roleId))].join("、")}暂未回应，已结束这次等待；你可以继续发言。`} /> : null}
      {textConfirmation && (textConfirmation.kind !== "start" || textConfirmation.ready) ? <div className="mb-3 flex items-center gap-3">
        <PrimaryButton label={textConfirmation.label} onClick={() => onConfirmText?.()} disabled={pending || actionsLocked || !textConfirmation.ready} />
        {!textConfirmation.ready ? <PanelNote text="等待对应玩家回应；你也可以在下方插话。" /> : null}
      </div> : null}
      {phase === "role_selection" ? <PanelNote text="请先在中间区域选择角色。" /> : null}
      {phase !== "role_selection" && phase !== "finished" ? <div className="mb-2 text-xs text-ink/65">
        {replyToMessage ? <div className="flex items-start justify-between gap-2 rounded border border-pine/20 bg-pine/5 p-2">
          <p>回复 {replyToMessage.speaker_name ?? "这条消息"}：{quotePreview(replyToMessage.content)}</p>
          <button type="button" onClick={onCancelReply} className="shrink-0 underline">取消回复</button>
        </div> : <p>公开发言 · 系统会按内容安排回应</p>}
      </div> : null}
      {canSubmitShare ? <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink/70">
        {!replyToMessage ? <label className="flex items-center gap-2">本条用途
          <select aria-label="本条发言用途" value={shareSendMode} disabled={discussionSending}
            className="rounded border border-ink/15 bg-paper px-2 py-1 text-ink"
            onChange={event => onShareSendModeChange?.(event.target.value as ShareSendMode)}>
            <option value="auto">自动判断</option><option value="share">本轮分享</option><option value="discussion">提问或补充</option>
          </select>
        </label> : null}
        <span role="status">{sendsShare ? "发送后完成本轮分享，DM 将点名下一位。" : "本条作为提问、回复或补充，不结束你的分享回合。"}</span>
      </div> : null}
      {phase !== "role_selection" && phase !== "finished" ? (
        <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
          <textarea
            rows={2}
            aria-label="聊天输入"
            className="min-h-11 min-w-0 resize-y rounded-md border border-ink/15 bg-paper px-4 py-2 text-sm text-ink outline-none transition placeholder:text-ink/38 focus:border-pine"
            ref={discussionInputRef}
            placeholder={performing ? "回应 DM 当前的问题，随后继续演绎" : "输入想追问或补充的内容"}
            value={discussionText}
            onChange={(event) => onDiscussionTextChange(event.target.value)}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onBlur={() => { composing.current = false; }}
            onKeyDown={event => {
              const action = chatEnterAction({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey,
                metaKey: event.metaKey, repeat: event.repeat, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode },
                composing.current, discussionText, sendBlocked);
              if (action === "edit") return;
              event.preventDefault();
              if (action === "send") submitDiscussion();
            }}
          />
          <PrimaryButton
            label={discussionSending ? "发送中…" : "发送"}
            onClick={submitDiscussion}
            disabled={!discussionText.trim() || sendBlocked}
          />
          {!groupMatching && !choice && !textConfirmation && (phase === "free_discussion" || phase === "act_summary") && canEnterNextAct ? <SecondaryButton label="进入下一幕阅读" onClick={onNextAct} disabled={pending || actionsLocked} /> : null}
        </div>
      ) : null}
      {phase !== "role_selection" && phase !== "finished" ? <details className="mt-3 rounded border border-ink/10 bg-paper/40 p-3" open={phase === "reading" || phase === "share_round"}>
        <summary className="cursor-pointer text-sm font-semibold text-ink/70">分享草稿（仅自己可见）</summary>
        <textarea aria-label="分享草稿" rows={3} className="mt-2 w-full resize-y rounded border border-ink/15 bg-white p-3 text-sm"
          placeholder="边读边整理，草稿会保留，不会自动发送" value={userShareText} onChange={event => onUserShareTextChange(event.target.value)} />
        <div className="mt-2 flex flex-wrap gap-3">
          <button type="button" className="text-sm text-pine underline disabled:opacity-40" disabled={!userShareText.trim()}
            onClick={() => { onDiscussionTextChange(userShareText); discussionInputRef.current?.focus(); }}>放入聊天输入框</button>
          <button type="button" className="text-sm text-ink/60 underline" onClick={() => onUserShareTextChange("")}>清空草稿</button>
        </div>
      </details> : null}
      {phase === "reading" ? <div className="mt-3 flex flex-wrap items-center gap-3">
        <PrimaryButton label={isUserReadingCompleted ? "已读完，等待 AI" : readingActionLabel ?? "我已读完本幕"}
          onClick={onReadingDone} disabled={isUserReadingCompleted || pending} />
        {!isAiInternalReadingCompleted ? <PanelNote text={aiInternalReadingStatusText} /> : null}
      </div> : null}
      {phase === "ai_internal_reading" ? <PanelNote text={aiInternalReadingStatusText} /> : null}
      {postShareDiscussionPending ? <PanelNote text="当前分享已公开，其他角色与 DM 正在继续处理。" /> : null}
      {phase === "share_round" && !isCurrentShareUser && !actionsLocked ? <div className="mt-3 flex gap-3">
        <PanelNote text="可继续整理草稿，等待点名后正式分享。" />
        <PrimaryButton label={aiSharePending ? "AI 正在组织语言" : "让该 AI 分享"} onClick={onAiShare} disabled={pending || aiSharePending} />
      </div> : null}
      {conversationStatus ? <PanelNote text={conversationStatus} /> : null}

      {performing ? <PanelNote text="演绎中请配合 DM，只回应眼前的问题；自由讨论会在指定环节开放。" /> : null}
      {phase === "act_summary" ? <PanelNote text="本幕总结待实现。" /> : null}
      {phase === "finished" ? <PanelNote text="游戏结束。" /> : null}
    </footer>
  );
}

function PrimaryButton({
  label,
  onClick,
  disabled = false
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="h-11 rounded-md bg-pine px-4 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:cursor-not-allowed disabled:bg-ink/25"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function SecondaryButton({
  label,
  onClick,
  disabled = false
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="h-11 rounded-md bg-brass px-4 text-sm font-semibold text-white transition hover:bg-brass/90 disabled:cursor-not-allowed disabled:bg-ink/25"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function PanelNote({ text }: { text: string }) {
  return <p className="text-sm font-medium text-ink/64">{text}</p>;
}

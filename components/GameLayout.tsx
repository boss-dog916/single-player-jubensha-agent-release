"use client";

import { useEffect, useRef, useState } from "react";
import { MatchingSidebar } from "./MatchingSidebar";
import { shareDraftKey as getShareDraftKey, loadShareDraft, saveShareDraft } from "./playerInteraction";
import { DraggableBookletButton } from "./DraggableBookletButton";
import { chatSubmissionType, type ShareSendMode } from "./playerInteraction";
import { ChatPanel } from "@/components/ChatPanel";
import { conversationPresentation, conversationPollInterval } from "@/components/conversationPresentation";
import { ControlPanel } from "@/components/ControlPanel";
import { DebugPanel } from "@/components/DebugPanel";
import { FlowPanel } from "@/components/FlowPanel";
import { RoleSelectionPanel } from "@/components/RoleSelectionPanel";
import { StoryBoardPanel } from "@/components/StoryBoardPanel";
import type { PlayerGameSnapshot } from "@/src/lib/access/playerView";
import { toPlayerSnapshot } from "@/src/lib/access/playerView";
type GameSession = PlayerGameSnapshot["session"];
import type {
  GameClientView,
  GameRuntimeSnapshot,
  AgentRunDebugView,
  AiInternalReadingStatusView,
  PlayerPdfReadingSnapshotView,
  ReactionPlanDebugView,
  ReactionExecutionDebugView,
  AutoDiscussionDebugView,
  DMFlowCursorDebugView,
  GameSessionRestoreWarning,
  PostShareTaskView,
  PublicActView,
  UserReadingStatusView,
  UserBookletView
} from "@/src/lib/services/gameRuntimeSnapshotService";
import type { Message, PublicStoryBoard } from "@/src/lib/types/game";

type QueuedChat = { id: string; content: string; replyToMessageId?: string | null; addressingMode?: "public" | "reply" };

type GameLayoutProps = {
  initialSnapshot: PlayerGameSnapshot;
  developerMode?: boolean;
  developerAccess?: boolean;
};

export function GameLayout({ initialSnapshot, developerMode = false, developerAccess = false }: GameLayoutProps) {
  const clueRequests = useRef(new Map<string, string>());
  const [clues, setClues] = useState(initialSnapshot.clues ?? []);
  const choiceRequests = useRef(new Map<string, { requestId: string; optionId: string; reason?: string }>());
  const [game, setGame] = useState<GameClientView>(initialSnapshot.game);
  const [session, setSession] = useState<GameSession>(initialSnapshot.session);
  const [messages, setMessages] = useState<Message[]>(initialSnapshot.messages);
  const [storyBoard, setStoryBoard] = useState<PublicStoryBoard>(initialSnapshot.storyBoard);
  const [aiInternalReadingStatus, setAiInternalReadingStatus] =
    useState<AiInternalReadingStatusView>(initialSnapshot.aiInternalReadingStatus);
  const [userReadingStatus, setUserReadingStatus] = useState<UserReadingStatusView>(
    initialSnapshot.userReadingStatus
  );
  const [recentAgentRuns, setRecentAgentRuns] = useState<AgentRunDebugView[]>(
    []
  );
  const [latestReactionPlan, setLatestReactionPlan] = useState<ReactionPlanDebugView | null>(
    null
  );
  const [latestReactionExecution, setLatestReactionExecution] =
    useState<ReactionExecutionDebugView | null>(null);
  const [latestAutoDiscussion, setLatestAutoDiscussion] =
    useState<AutoDiscussionDebugView | null>(null);
  const [postShareDiscussion, setPostShareDiscussion] = useState<PlayerGameSnapshot["postShareDiscussion"]>(
    initialSnapshot.postShareDiscussion
  );
  const [shareDrafts, setShareDrafts] = useState(initialSnapshot.shareDrafts ?? []);
  const [dmFlowCursor, setDMFlowCursor] = useState<PlayerGameSnapshot["controls"]>(
    initialSnapshot.controls
  );
  const [developerSnapshot, setDeveloperSnapshot] = useState<GameRuntimeSnapshot | null>(null);
  useEffect(() => {
    if (!developerMode) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/games/${initialSnapshot.session.gameId}/debug`);
        if (response.ok && !cancelled) {
          const payload = await response.json(); setDeveloperSnapshot(payload.snapshot);
          setRecentAgentRuns(payload.snapshot.recentAgentRuns); setLatestReactionPlan(payload.snapshot.latestReactionPlan);
          setLatestReactionExecution(payload.snapshot.latestReactionExecution); setLatestAutoDiscussion(payload.snapshot.latestAutoDiscussion);
          setRestoreWarnings(payload.snapshot.restoreWarnings);
        } else if (response.status === 401 || response.status === 403) {
          setDeveloperSnapshot(null); setRecentAgentRuns([]); setLatestReactionPlan(null); setLatestReactionExecution(null); setLatestAutoDiscussion(null);
        }
      } catch { /* Debug never blocks player interaction. */ }
    };
    void load(); const timer = window.setInterval(() => void load(), 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [developerMode, initialSnapshot.session.gameId]);
  const [restoreWarnings, setRestoreWarnings] = useState<GameSessionRestoreWarning[]>(
    []
  );
  const [currentUserBooklet, setCurrentUserBooklet] = useState<UserBookletView | null>(
    initialSnapshot.userBooklet
  );
  const [playerPdfReading, setPlayerPdfReading] = useState<PlayerPdfReadingSnapshotView | null>(
    initialSnapshot.playerPdfReading
  );
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [conversation, setConversation] = useState(initialSnapshot.conversation);
  const [modelAvailability, setModelAvailability] = useState(initialSnapshot.modelAvailability);
  const [outbox, setOutbox] = useState<QueuedChat[]>([]);
  const snapshotTimeRef = useRef(0);
  const conversationActive = !modelAvailability && !!conversation?.state && ["pending", "running"].includes(conversation.state.status);
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  useEffect(() => setReplyToMessageId(null), [session.currentActId]);
  const [userShareText, setUserShareText] = useState("");
  const [discussionText, setDiscussionText] = useState("");
  const [shareSendMode, setShareSendMode] = useState<ShareSendMode>("auto");
  const [discussionSending, setDiscussionSending] = useState(false);
  const discussionSubmitRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [aiSharePending, setAiSharePending] = useState(false);
  const [reactionExecutionPending, setReactionExecutionPending] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [liveRefreshError, setLiveRefreshError] = useState(false);
  const [selectedReadingSectionId, setSelectedReadingSectionId] = useState<string | null>(null);
  const aiInternalReadingRequestKeyRef = useRef<string | null>(null);
  const aiInternalReadingDoneRequestKeyRef = useRef<string | null>(null);
  const postSharePollPendingRef = useRef(false);

  const currentAct = game.acts[session.currentActIndex] ?? game.acts[0];
  const currentShareRoleId = getCurrentShareRoleId(currentAct, session);
  const currentShareRoleName = currentShareRoleId ? getRoleName(game, currentShareRoleId) : null;
  const isCurrentShareUser = Boolean(
    currentShareRoleId && session.userRoleId && currentShareRoleId === session.userRoleId
  );
  const canSubmitShare = session.currentPhase === "share_round" && isCurrentShareUser;
  useEffect(() => { setShareSendMode("auto"); }, [session.currentActId, currentShareRoleId]);
  const postShareDiscussionActive =
    postShareDiscussion?.status === "pending" || postShareDiscussion?.status === "running";
  const shareDraftsActive = shareDrafts.some((draft) => draft.actId === session.currentActId &&
    ["pending", "generating", "checking"].includes(draft.status));

  useEffect(() => {
    if (
      session.currentPhase !== "reading" ||
      !currentUserBooklet ||
      aiInternalReadingStatus.overallStatus === "completed" ||
      aiInternalReadingStatus.overallStatus === "running"
    ) {
      return;
    }

    const requestKey = `${session.gameId}:${session.currentActId}`;

    if (aiInternalReadingRequestKeyRef.current === requestKey) {
      return;
    }

    aiInternalReadingRequestKeyRef.current = requestKey;

    void postAiInternalReading();

  }, [
    aiInternalReadingStatus.overallStatus,
    currentUserBooklet,
    session.currentActId,
    session.currentPhase,
    session.gameId
  ]);

  useEffect(() => {
    const key = getShareDraftKey(session.gameId, session.currentActId, session.userRoleId);
    try { setUserShareText(loadShareDraft(window.localStorage, key)); }
    catch { setUserShareText(""); }
  }, [session.currentActId, session.gameId, session.userRoleId]);

  function handleShareDraftChange(value: string) {
    setUserShareText(value);
    const key = getShareDraftKey(session.gameId, session.currentActId, session.userRoleId);
    try { saveShareDraft(window.localStorage, key, value); } catch { /* Keep the editable in-memory draft. */ }
  }

  useEffect(() => {
    if (
      session.currentPhase !== "reading" ||
      userReadingStatus.status !== "completed" ||
      aiInternalReadingStatus.overallStatus !== "completed"
    ) {
      return;
    }

    const requestKey = `${session.gameId}:${session.currentActId}`;

    if (aiInternalReadingDoneRequestKeyRef.current === requestKey) {
      return;
    }

    aiInternalReadingDoneRequestKeyRef.current = requestKey;

    const timer = window.setTimeout(() => {
      void postGameEvent({ type: "AI_INTERNAL_READING_DONE" });
    }, 300);

    return () => window.clearTimeout(timer);
  }, [
    aiInternalReadingStatus.overallStatus,
    session.currentActId,
    session.currentPhase,
    session.gameId,
    userReadingStatus.status
  ]);

  useEffect(() => {
    if (!session.userRoleId) {
      return;
    }

    let cancelled = false;
    const refresh = async () => {
      if (postSharePollPendingRef.current) {
        return;
      }
      postSharePollPendingRef.current = true;
      try {
        const response = await fetch(`/api/games/${session.gameId}`, { cache: "no-store" });
        const payload = await readJsonResponse(response);
        if (!response.ok) throw new Error("snapshot refresh failed");
        if (!cancelled) { applySnapshot(payload as PlayerGameSnapshot); setLiveRefreshError(false); }
      } catch {
        if (!cancelled) setLiveRefreshError(true);
      } finally {
        postSharePollPendingRef.current = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), conversationPollInterval(
      postShareDiscussionActive || shareDraftsActive || conversationActive || outbox.length > 0));
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [postShareDiscussionActive, postShareDiscussion?.id, shareDraftsActive, conversationActive, outbox.length, session.gameId, session.userRoleId]);

  useEffect(() => {
    const saved = JSON.parse(window.localStorage.getItem(`conversation-outbox:${session.gameId}`) ?? "[]") as Array<{ id: string; content: string }>;
    setOutbox(saved);
    for (const item of saved) void sendChat(item);
  }, [session.gameId]);

  const currentGameView = {
    title: game.title,
    currentAct: {
      id: currentAct.act_id,
      index: session.currentActIndex + 1,
      total: session.totalActs,
      title: currentAct.title,
      bgm: currentAct.bgm
    },
    currentPhase: {
      id: session.currentPhase,
      label: getPhaseLabel(session.currentPhase)
    }
  };

  async function handleConfirmRole() {
    if (!selectedRoleId) {
      return;
    }

    await postGameEvent({ type: "SELECT_ROLE", roleId: selectedRoleId });
  }

  async function handleReadingDone() {
    if (!currentUserBooklet) {
      return;
    }

    if (playerPdfReading?.status === "not_configured") {
      setErrorText(playerPdfReading.message);
      return;
    }

    await postGameEvent({ type: "USER_FINISHED_READING", actId: session.currentActId,
      ...(playerPdfReading?.status === "available" ? { sectionId: selectedReadingSectionId ?? playerPdfReading.sectionId } : {}) });
  }

  async function handleAiShare() {
    if (!currentShareRoleId || isCurrentShareUser) {
      return;
    }

    const roleName = getRoleName(game, currentShareRoleId);
    const tempMessageId = `pending_ai_share_${currentShareRoleId}_${Date.now()}`;
    const tempMessage: Message = {
      message_id: tempMessageId,
      speaker_type: "ai_player",
      speaker_role_id: currentShareRoleId,
      speaker_name: roleName,
      phase: "share_round",
      speech_act: "notice",
      content: `${roleName} 正在组织语言中……`,
      metadata: {
        revealed_facts: [],
        emotional_points: [],
        questions_raised: [],
        mentioned_role_ids: [],
        event_tags: [],
        topic_tags: []
      }
    };

    setErrorText(null);
    setAiSharePending(true);
    setMessages((current) => [...current, tempMessage]);

    try {
      await postGameEvent({ type: "AI_SHARE" }, { keepPending: true });
    } catch (error) {
      setMessages((current) => current.filter((message) => message.message_id !== tempMessageId));
      setErrorText(error instanceof Error ? error.message : "AI 分享失败，请稍后重试。");
    } finally {
      setAiSharePending(false);
    }
  }

  async function handleSubmitDiscussion() {
    if (!session.userRoleId || !discussionText.trim() || discussionSubmitRef.current) return;
    const submission = chatSubmissionType({ canShare: canSubmitShare, replyToMessageId, content: discussionText, mode: shareSendMode });
    if (submission === "USER_SHARE" && (pending || conversationActive || postShareDiscussionActive || modelAvailability || outbox.length)) return;
    discussionSubmitRef.current = true;
    setDiscussionSending(true);
    try {
      if (submission === "USER_SHARE") {
        const submittedText = discussionText;
        await postGameEvent({ type: "USER_SHARE", content: submittedText.trim(), actId: session.currentActId, shareIndex: session.currentShareIndex });
        setDiscussionText(current => current === submittedText ? "" : current);
        setShareSendMode("auto");
        return;
      }
      const item: QueuedChat = { id: crypto.randomUUID(), content: discussionText.trim(), replyToMessageId, addressingMode: replyToMessageId ? "reply" : "public" };
      const stored = JSON.parse(window.localStorage.getItem(`conversation-outbox:${session.gameId}`) ?? "[]");
      window.localStorage.setItem(`conversation-outbox:${session.gameId}`, JSON.stringify([...stored, item]));
      setOutbox(current => [...current, item]);
      setDiscussionText(""); setReplyToMessageId(null);
      setShareSendMode("auto");
      await sendChat(item);
    } catch (error) { setErrorText(error instanceof Error ? error.message : "消息未发送，请重试。"); }
    finally { discussionSubmitRef.current = false; setDiscussionSending(false); }
  }

  async function sendChat(item: QueuedChat) {
    try {
      const response = await fetch(`/api/games/${session.gameId}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "USER_DISCUSSION", content: item.content, clientMessageId: item.id, replyToMessageId: item.replyToMessageId ?? null, addressingMode: item.addressingMode ?? "public" }) });
      const snapshot = await readJsonResponse(response);
      if (!response.ok) {
        if (snapshot.inputRejected === true || response.status === 400 && item.addressingMode === "reply") {
          const key = `conversation-outbox:${session.gameId}`;
          const remaining = (JSON.parse(window.localStorage.getItem(key) ?? "[]") as QueuedChat[]).filter(entry => entry.id !== item.id);
          window.localStorage.setItem(key, JSON.stringify(remaining)); setOutbox(remaining);
          setDiscussionText(current => current || item.content); setReplyToMessageId(response.status === 400 ? null : item.replyToMessageId ?? null);
        }
        throw new Error(typeof snapshot.error === "string" ? snapshot.error : "发送失败，刷新后将重试。");
      }
      const key = `conversation-outbox:${session.gameId}`;
      const accepted = (JSON.parse(window.localStorage.getItem(key) ?? "[]") as Array<{ id: string; content: string }>).filter((entry) => entry.id !== item.id);
      window.localStorage.setItem(key, JSON.stringify(accepted));
      setOutbox(accepted);
      applySnapshot(snapshot as PlayerGameSnapshot);
    } catch (error) { setErrorText(error instanceof Error ? error.message : "发送失败，刷新后将重试。"); }
  }

  async function handleExecuteSelectedReactions() {
    const selectedReactions = latestReactionPlan?.schedulerResult.selected_reactions ?? [];
    const latestMessageId = latestReactionPlan?.latestMessage.message_id;

    if (!latestMessageId || selectedReactions.length === 0) {
      return;
    }

    const tempMessages = selectedReactions.map((reaction) => {
      const roleName = getRoleName(game, reaction.role_id);

      return {
        message_id: `pending_reaction_${reaction.role_id}_${Date.now()}`,
        speaker_type: "ai_player" as const,
        speaker_role_id: reaction.role_id,
        speaker_name: roleName,
        target_role_ids: reaction.target_role_ids,
        reply_to_message_id: latestMessageId,
        phase: session.currentPhase,
        speech_act: "notice" as const,
        content: `${roleName} 正在组织语言中……`,
        metadata: {
          revealed_facts: [],
          emotional_points: [],
          questions_raised: [],
          mentioned_role_ids: [],
          event_tags: [],
          topic_tags: []
        }
      };
    });

    setErrorText(null);
    setReactionExecutionPending(true);
    setMessages((current) => [...current, ...tempMessages]);

    try {
      const response = await fetch(`/api/games/${session.gameId}/execute-selected-reactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          latestMessageId,
          selectedReactions
        })
      });
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        if (payload.snapshot) {
          applySnapshot(toPlayerSnapshot(payload.snapshot as GameRuntimeSnapshot));
        }
        throw new Error(getErrorMessage(payload, `执行 AI 反应失败，状态码 ${response.status}。`));
      }

      applySnapshot(toPlayerSnapshot(payload as GameRuntimeSnapshot));
    } catch (error) {
      setMessages((current) =>
        current.filter(
          (message) =>
            !tempMessages.some((tempMessage) => tempMessage.message_id === message.message_id)
        )
      );
      setErrorText(error instanceof Error ? error.message : "执行 AI 反应失败，请稍后重试。");
    } finally {
      setReactionExecutionPending(false);
    }
  }

  async function handleDMFlowDebugAction(
    action: string,
    actionPayload: Record<string, unknown> = {}
  ) {
    setErrorText(null);
    setPending(true);

    try {
      const response = await fetch(`/api/games/${session.gameId}/dm-flow`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ action, ...actionPayload })
      });
      const payload = await readJsonResponse(response);

      if (payload.snapshot) {
        applySnapshot(toPlayerSnapshot(payload.snapshot as GameRuntimeSnapshot));
      }

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `DMFlow debug 操作失败，状态码 ${response.status}。`));
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "DMFlow debug 操作失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  async function handleNextAct() {
    await postGameEvent({ type: "NEXT_ACT" });
  }

  function showRuntimeActionError(error: unknown) {
    setErrorText(error instanceof Error ? error.message : "操作未成功，请稍后重试；已保存的结果不会改变。");
  }

  async function postGameEvent(
    event: Record<string, unknown>,
    options: { keepPending?: boolean } = {}
  ) {
    setErrorText(null);
    if (!options.keepPending) {
      setPending(true);
    }

    try {
      const response = await fetch(`/api/games/${session.gameId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(event)
      });

      const payload = await readJsonResponse(response);

      if (!response.ok) {
        if (payload.snapshot) {
          applySnapshot(payload.snapshot as PlayerGameSnapshot);
        }
        throw new Error(getErrorMessage(payload, `请求失败，状态码 ${response.status}。`));
      }

      applySnapshot(payload as PlayerGameSnapshot);
    } finally {
      if (!options.keepPending) {
        setPending(false);
      }
    }
  }

  async function postAiInternalReading() {
    try {
      const response = await fetch(`/api/games/${session.gameId}/ai-internal-reading`, {
        method: "POST"
      });
      const payload = await readJsonResponse(response);

      if (payload.snapshot) {
        applySnapshot(payload.snapshot as PlayerGameSnapshot);
      }

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `AI 玩家读本失败，状态码 ${response.status}。`));
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "AI 玩家读本失败，请刷新后重试。");
    }
  }

  function applySnapshot(snapshot: PlayerGameSnapshot) {
    const stamp = new Date(snapshot.conversation?.state?.updatedAt ?? 0).getTime();
    if (stamp && stamp < snapshotTimeRef.current) return;
    setModelAvailability(snapshot.modelAvailability ?? null);
    snapshotTimeRef.current = Math.max(snapshotTimeRef.current, stamp);
    setConversation(snapshot.conversation);
    const ack = new Set(snapshot.conversation?.acknowledgements.map((item) => item.clientMessageId) ?? []);
    const stored = JSON.parse(window.localStorage.getItem(`conversation-outbox:${session.gameId}`) ?? "[]") as Array<{ id: string; content: string }>;
    const remaining = stored.filter((item) => !ack.has(item.id));
    window.localStorage.setItem(`conversation-outbox:${session.gameId}`, JSON.stringify(remaining));
    setOutbox(remaining);
    setGame(snapshot.game);
    setSession(snapshot.session);
    setMessages(snapshot.messages);
    setStoryBoard(snapshot.storyBoard);
    setClues(snapshot.clues ?? []);
    setAiInternalReadingStatus(snapshot.aiInternalReadingStatus);
    setUserReadingStatus(snapshot.userReadingStatus);




    setPostShareDiscussion(snapshot.postShareDiscussion);
    setShareDrafts(snapshot.shareDrafts ?? []);
    setDMFlowCursor(snapshot.controls);

    setCurrentUserBooklet(snapshot.userBooklet);
    setPlayerPdfReading(snapshot.playerPdfReading);
    const pdf = snapshot.playerPdfReading;
    setSelectedReadingSectionId(previous => {
      if (pdf?.status !== "available") return null;
      const item = pdf.documents?.find(d => d.sectionId === previous);
      return item && !item.completed ? item.sectionId : pdf.sectionId;
    });
  }

  const showBoard = session.publicStoryBoardEnabled !== false;
  function handleSubmitGroupMatching(assignments: { roleId: string; optionId: string }[], requestId: string) {
    const matching = dmFlowCursor.groupMatching;
    if (matching) void postGameEvent({ type: "SUBMIT_GROUP_MATCHING", choiceId: matching.choiceId, nodeId: matching.nodeId,
      actId: matching.actId, round: matching.round, assignments, requestId }).catch(showRuntimeActionError);
  }
  const showRightPanel = showBoard || clues.length > 0 || developerMode || Boolean(dmFlowCursor.groupMatching);
  return (
    <div className="mx-auto flex h-[100dvh] w-full max-w-[1500px] flex-col gap-4 overflow-hidden p-4 lg:p-6">
      {developerAccess ? <div className="flex shrink-0 justify-end text-xs text-ink/65"><a className="text-brass underline"
        href={`/games/${session.gameId}${developerMode ? "?view=player" : ""}`}>
        {developerMode ? "预览玩家视角" : "返回开发者视角"}
      </a></div> : null}
      <div className={`grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-rows-1 ${showRightPanel ? "grid-rows-[80px_minmax(0,1fr)_auto] lg:grid-cols-[220px_minmax(0,1fr)_340px]" : "grid-rows-[80px_minmax(0,1fr)] lg:grid-cols-[280px_minmax(0,1fr)]"}`}>
        <FlowPanel
          game={currentGameView}
          currentCalledRoleName={currentShareRoleName}
          aiInternalReadingStatus={aiInternalReadingStatus}
        />
        {renderMainPanel()}
        {showRightPanel ? <div className="flex min-h-0 flex-col gap-4 overflow-y-auto max-lg:max-h-[35dvh] max-lg:[&>aside]:min-h-[240px] max-lg:[&>aside]:shrink-0">
          {dmFlowCursor.groupMatching ? <MatchingSidebar key={dmFlowCursor.groupMatching.nodeId} matching={dmFlowCursor.groupMatching} pending={pending}
            onSubmit={handleSubmitGroupMatching} /> : null}
          <StoryBoardPanel showBoard={showBoard} storyBoard={storyBoard} messages={messages} clues={clues} clueSharePending={pending || !["free_discussion", "dm_question"].includes(session.currentPhase)}
            onShareClue={clueId => {
              const requestId = clueRequests.current.get(clueId) ?? crypto.randomUUID(); clueRequests.current.set(clueId, requestId);
              void postGameEvent({ type: "SHARE_RUNTIME_CLUE", clueId, requestId, actId: session.currentActId }).catch(showRuntimeActionError);
            }} />
      {developerMode && developerSnapshot ? <DebugPanel
        shareDrafts={developerSnapshot.shareDrafts}
            runs={recentAgentRuns}
            reactionPlan={latestReactionPlan}
            reactionExecution={latestReactionExecution}
            autoDiscussion={latestAutoDiscussion}
            dmFlowCursor={developerSnapshot.dmFlowCursor}
            restoreWarnings={restoreWarnings}
            reactionExecutionPending={reactionExecutionPending || conversationActive || postShareDiscussionActive}
            onExecuteSelectedReactions={() => void handleExecuteSelectedReactions()}
            onDMFlowAction={(action, payload) => void handleDMFlowDebugAction(action, payload)}
          /> : null}
        </div> : null}
      </div>
      {["reading", "ai_internal_reading"].includes(session.currentPhase) ? (
        <div aria-live="polite" className="max-h-24 shrink-0 overflow-y-auto text-xs text-ink/70">
          {messages.filter((message) => message.speaker_type === "user").slice(-2).map((message) => <p key={message.message_id}>你：{message.content}</p>)}
          {outbox.map((item) => <p key={item.id}>你：{item.content}（正在发送）</p>)}
        </div>
      ) : null}
      <ControlPanel
        matchingInSidebar
        discussionSending={discussionSending}
        groupMatching={dmFlowCursor.groupMatching}
        groupMatchingPending={pending}
        onSubmitGroupMatching={handleSubmitGroupMatching}
        choice={dmFlowCursor.choice}
        onChooseOption={(optionId, reason) => {
          const choice = dmFlowCursor.choice;
          if (!choice) return;
          const key = `${session.gameId}:${choice.nodeId}`;
          let request = choiceRequests.current.get(key);
          if (!request) { request = { requestId: crypto.randomUUID(), optionId, reason }; choiceRequests.current.set(key, request); }
          void postGameEvent({ type: "SUBMIT_RUNTIME_CHOICE", choiceId: choice.choiceId, nodeId: choice.nodeId,
            actId: choice.actId, ...request, ...(reason ? { reason } : {}) }).catch(showRuntimeActionError);
        }}
        textConfirmation={dmFlowCursor.textConfirmation}
        discussionReadiness={dmFlowCursor.discussionReadiness}
        onConfirmText={() => { if (dmFlowCursor.textConfirmation) void postGameEvent({ type: "CONFIRM_DM_TEXT", token: dmFlowCursor.textConfirmation.token }).catch(showRuntimeActionError); }}
        replyToMessage={messages.find(m => m.message_id === replyToMessageId) ?? null}
        onCancelReply={() => setReplyToMessageId(null)}
        canEnterNextAct={session.runtimeDefinitionId ? dmFlowCursor.canEnterNextAct : session.currentPhase === "free_discussion"}
        phase={session.currentPhase}
        isCurrentShareUser={isCurrentShareUser}
        isAiInternalReadingCompleted={aiInternalReadingStatus.overallStatus === "completed"}
        isUserReadingCompleted={userReadingStatus.status === "completed"}
        aiInternalReadingStatusText={getAiReadingStatusText(aiInternalReadingStatus)}
        pending={pending || conversationActive}
        aiSharePending={aiSharePending}
        postShareDiscussionPending={postShareDiscussionActive}
        fsmActionsLocked={Boolean(modelAvailability) || conversationActive || outbox.length > 0}
        conversationStatus={conversation?.pending.length ? "你的消息将在当前角色说完后插入" : conversationActive ?
          conversation?.state?.roleId ? `${getRoleName(game, conversation.state.roleId)} 正在回应……` : "AI 正在回应最新消息……" : conversation?.state?.status === "failed" ? "AI 回应未完成，你可以继续发言" : ""}
        discussionText={discussionText}
        canSubmitShare={canSubmitShare}
        shareSendMode={shareSendMode}
        onShareSendModeChange={setShareSendMode}
        userShareText={userShareText}
        readingActionLabel={playerPdfReading?.status === "available" && (playerPdfReading.documents?.length ?? 0) > 1 ? "我已读完当前资料" : undefined}
        onReadingDone={() => void handleReadingDone()}
        onAiShare={() => void handleAiShare()}
        onUserShareTextChange={handleShareDraftChange}
        onDiscussionTextChange={setDiscussionText}
        onSubmitDiscussion={() => void handleSubmitDiscussion()}
        onNextAct={() => void handleNextAct()}
      />
      {pending ? (
        <p className="shrink-0 text-center text-xs font-medium text-ink/52">
          正在保存，并处理 AI 是否回应...
        </p>
      ) : null}
      {postShareDiscussionActive ? (
        <p className="shrink-0 text-center text-xs font-medium text-ink/52">
          AI 分享已显示，其他角色与 DM 正在继续处理…
        </p>
      ) : null}
      {errorText ? <p className="shrink-0 text-center text-xs font-medium text-ember">{errorText}</p> : null}
      {modelAvailability ? <div role="alert" className="shrink-0 text-center text-sm text-ember">
        <p>{modelAvailability.message} 游戏进度与已保存消息保留，模型任务已暂停。</p>
        {modelAvailability.canResume ? <button disabled={pending} onClick={() => {
          void postGameEvent({ type: "RESUME_MODEL_EXECUTION" }).catch(showRuntimeActionError);
        }}>问题已处理，恢复模型任务</button> : null}
      </div> : null}
      {session.userRoleId ? (
        <BookletFloatingButton gameId={session.gameId} />
      ) : null}
    </div>
  );

  function renderMainPanel() {
    if (session.currentPhase === "role_selection") {
      return (
        <RoleSelectionPanel
          roles={game.roles}
          selectedRoleId={selectedRoleId}
          onSelectRole={setSelectedRoleId}
          onConfirm={() => void handleConfirmRole()}
        />
      );
    }

    if (session.currentPhase === "reading" && currentUserBooklet) {
      if (playerPdfReading) {
        return <PlayerPdfBookletPanel gameId={session.gameId} reading={playerPdfReading} selectedSectionId={selectedReadingSectionId} onSelect={setSelectedReadingSectionId} />;
      }

      return <UserBookletPanel booklet={currentUserBooklet} />;
    }

    if (session.currentPhase === "finished") {
      return <StatusPanel title={session.testMode ? "测试范围已完成" : "游戏结束"}
        body={session.testMode ? `已完成本次绑定的 ${game.acts.length} 幕测试范围；未执行范围之外的剧情。` : "当前游戏流程已经结束。"} />;
    }

    const queued = new Map<string, {content: string; label: string; replyToMessageId?: string | null}>(outbox.map((item) => [item.id, { content: item.content, label: "正在发送", replyToMessageId: item.replyToMessageId }]));
    for (const item of conversation?.pending ?? []) queued.set(item.clientMessageId, { content: item.content, label: "已排队，等待当前角色说完后插入", replyToMessageId: item.replyToMessageId });
    const queuedMessages: Message[] = [...queued].map(([id, item]) => ({
      message_id: `queued:${id}`, speaker_type: "user", speaker_role_id: session.userRoleId,
      speaker_name: session.userRoleId ? getRoleName(game, session.userRoleId) : "你", phase: session.currentPhase,
      speech_act: "notice", reply_to_message_id: item.replyToMessageId, content: `${item.content}\n（${item.label}）`,
      metadata: { revealed_facts: [], emotional_points: [], questions_raised: [], mentioned_role_ids: [], event_tags: [], topic_tags: [] }
    }));
    const presentation = conversationPresentation(conversation, game.roles, messages, outbox.length,
      postShareDiscussionActive, !!latestAutoDiscussion);
    return <ChatPanel messages={messages} queuedMessages={queuedMessages} pendingReply={presentation.pendingReply}
      onReply={message => setReplyToMessageId(message.message_id)}
      replyDisabled={message => session.currentPhase === "finished" || session.currentPhase === "role_selection" ||
        (session.currentPhase === "dm_question" && dmFlowCursor.textConfirmation?.kind !== "start" && !dmFlowCursor.groupMatching && message.speaker_type !== "dm")}
      status={liveRefreshError ? "连接暂时中断，正在自动重连；已发送的消息不会重复发送。" : presentation.status} />;
  }
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();

  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      error: response.ok
        ? "服务器返回了无法解析的响应。"
        : `服务器返回了无法解析的错误响应，状态码 ${response.status}。`
    };
  }
}

function getErrorMessage(payload: Record<string, unknown>, fallback: string): string {
  return typeof payload.error === "string" ? payload.error : fallback;
}

function getAiReadingStatusText(status: AiInternalReadingStatusView): string {
  if (status.overallStatus === "completed") {
    return "AI 玩家已读完本幕角色本。";
  }

  if (status.overallStatus === "failed") {
    return "部分 AI 玩家读本失败，刷新页面或重新进入时会重试。";
  }

  if (status.overallStatus === "running") {
    return "AI 玩家正在阅读本幕角色本……";
  }

  return "AI 玩家还在读本。";
}

function getPhaseLabel(phase: GameSession["currentPhase"]): string {
  const labels: Record<GameSession["currentPhase"], string> = {
    role_selection: "选择角色",
    reading: "阅读当前幕",
    ai_internal_reading: "AI 玩家私下读本",
    share_round: "玩家依次分享",
    free_discussion: "自由追问",
    dm_question: "DM 提问",
    act_summary: "本幕总结",
    finished: "游戏结束"
  };

  return labels[phase];
}

function getCurrentShareRoleId(act: PublicActView, session: GameSession): string | null {
  const index = getNextShareIndex(act, session, session.currentShareIndex);
  return index === -1 ? null : act.share_order[index] ?? null;
}

function getNextShareIndex(act: PublicActView, session: GameSession, startIndex: number): number {
  for (let index = startIndex; index < act.share_order.length; index += 1) {
    const roleId = act.share_order[index];

    if (roleId === session.userRoleId || session.aiRoleIds.includes(roleId)) {
      return index;
    }
  }

  return -1;
}

function getRoleName(game: GameClientView, roleId: string): string {
  return game.roles.find((role) => role.role_id === roleId)?.name ?? roleId;
}

function getPlayerBookletHref(gameId: string, actIndex: number, roleName?: string | null): string {
  const params = new URLSearchParams();
  params.set("actIndex", String(actIndex));

  if (roleName) {
    params.set("roleName", roleName);
  }

  return `/games/${gameId}/player-booklet?${params.toString()}`;
}

function PlayerPdfBookletPanel({
  gameId,
  reading, selectedSectionId, onSelect
}: {
  gameId: string;
  reading: PlayerPdfReadingSnapshotView;
  selectedSectionId: string | null;
  onSelect: (sectionId: string) => void;
}) {
  if (reading.status === "not_configured") {
    return (
      <main className="flex min-h-0 flex-col rounded-lg border border-ember/20 bg-white/90 shadow-panel">
        <header className="border-b border-ink/10 px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">Reading</p>
          <h2 className="mt-1 text-xl font-semibold text-ink">
            {reading.roleName} · 第 {reading.actIndex} 幕
          </h2>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="rounded-md border border-ember/20 bg-ember/5 p-4">
            <p className="text-sm font-semibold text-ember">PDF 读本未配置</p>
            <p className="mt-2 text-sm leading-6 text-ink/72">{reading.message}</p>
          </div>
        </div>
      </main>
    );
  }

  const document = reading.documents?.find(d => d.sectionId === selectedSectionId);
  const displayed = { ...reading, ...(document ?? {}) };
  const iframeSrc = `${displayed.pdfUrl}#page=${displayed.pageStart}`;
  const pageRange =
    displayed.pageStart === displayed.pageEnd
      ? `第 ${displayed.pageStart} 页`
      : `第 ${displayed.pageStart}-${displayed.pageEnd} 页`;

  return (
    <main className="flex min-h-0 flex-col rounded-lg border border-ink/10 bg-white/90 shadow-panel">
      <header className="border-b border-ink/10 px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">Reading</p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-ink">
              {displayed.roleName} · 第 {displayed.actIndex} 幕
            </h2>
            <p className="mt-1 text-sm text-ink/60">{displayed.actTitle}</p>
          </div>
          <p className="rounded-md bg-paper px-3 py-2 text-sm font-semibold text-ink/72">
            请阅读 {pageRange}
          </p>
          <a
            href={`${getPlayerBookletHref(gameId, displayed.actIndex, displayed.roleName)}&sectionId=${encodeURIComponent(displayed.sectionId)}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-pine px-3 py-2 text-sm font-semibold text-white transition hover:bg-pine/90"
          >
            新窗口打开读本
          </a>
        </div>
      </header>
      {reading.documents && reading.documents.length > 1 ? <nav className="flex flex-wrap gap-2 border-b border-ink/10 p-3" aria-label="本幕阅读资料">
        {reading.documents.map((d, i) => <button key={d.sectionId} type="button" onClick={() => onSelect(d.sectionId)}
          disabled={reading.documents!.slice(0, i).some(previous => previous.required && !previous.completed)}
          aria-pressed={displayed.sectionId === d.sectionId} className={`rounded border px-3 py-2 text-sm ${displayed.sectionId === d.sectionId ? "bg-pine text-white" : "bg-white"}`}>
          {i + 1}. {d.originalName} {d.completed ? "（已读）" : d.required ? "（必读）" : "（选读）"}
        </button>)}
      </nav> : null}
      <div className="pdf-reading-surface min-h-0 flex-1 p-4">
        <iframe
          title={`${displayed.roleName} 第 ${displayed.actIndex} 幕 PDF 读本`}
          src={iframeSrc}
          className="pdf-page-frame h-full min-h-[520px] w-full rounded-md border"
        />
      </div>
      <footer className="pdf-reader-hint border-t border-ink/10 px-5 py-3 text-xs leading-5">
        浏览器内置 PDF 预览若无法显示，可点击上方「新窗口打开读本」继续阅读。
      </footer>
    </main>
  );
}

function UserBookletPanel({ booklet }: { booklet: UserBookletView }) {
  return (
    <main className="flex min-h-0 flex-col rounded-lg border border-ink/10 bg-white/90 shadow-panel">
      <header className="border-b border-ink/10 px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">Reading</p>
        <h2 className="mt-1 text-xl font-semibold text-ink">{booklet.title}</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <p className="whitespace-pre-line text-sm leading-8 text-ink/78">{booklet.private_text}</p>
      </div>
    </main>
  );
}

function StatusPanel({ title, body }: { title: string; body: string }) {
  return (
    <main className="flex min-h-0 flex-col justify-center rounded-lg border border-ink/10 bg-white/90 p-8 text-center shadow-panel">
      <h2 className="text-xl font-semibold text-ink">{title}</h2>
      <p className="mt-3 text-sm leading-6 text-ink/64">{body}</p>
    </main>
  );
}

function BookletFloatingButton({ gameId }: { gameId: string }) {
  return <DraggableBookletButton onClick={() => { window.open(`/games/${gameId}/player-booklet`, "_blank", "noopener,noreferrer"); }} />;
}

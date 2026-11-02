import type { GameRuntimeSnapshot } from "@/src/lib/services/gameRuntimeSnapshotService";

export function toPlayerSnapshot(s: GameRuntimeSnapshot) {
  const x = s.session;
  return {
    modelAvailability: s.modelAvailability ? { paused: true as const, code: s.modelAvailability.code,
      message: s.modelAvailability.message, canResume: s.modelAvailability.canResume, since: s.modelAvailability.since } : null,
    clues: (s.clues ?? []).map(c => ({ clueId: c.clueId, title: c.title, text: c.text, source: c.source, visibility: c.visibility, pdfUrl: c.pdfUrl,
      granted: c.granted, grantedAt: c.grantedAt, shareAllowed: c.shareAllowed, publiclyShared: c.publiclyShared, messageId: c.messageId })),
    game: { title: s.game.title, roles: s.game.roles.map(r => ({ role_id: r.role_id, name: r.name, personality: r.personality })),
      acts: s.game.acts.map((a, i) => ({ act_id: a.act_id, title: i <= x.currentActIndex ? a.title : "未解锁", bgm: i <= x.currentActIndex ? a.bgm : "未解锁", share_order: a.share_order })) },
    session: { publicStoryBoardEnabled: x.publicStoryBoardEnabled !== false, gameId: x.gameId, runtimeDefinitionId: x.runtimeDefinitionId, runtimeMode: x.runtimeMode, testMode: x.testMode,
      currentActIndex: x.currentActIndex, totalActs: x.totalActs, currentActId: x.currentActId, currentPhase: x.currentPhase,
      userRoleId: x.userRoleId, aiRoleIds: x.aiRoleIds, userReadActIds: x.userReadActIds,
      currentShareIndex: x.currentShareIndex, discussionTurnCount: x.discussionTurnCount, maxDiscussionTurns: x.maxDiscussionTurns },
    messages: s.messages.map(m => ({ message_id: m.message_id, speaker_type: m.speaker_type, speaker_role_id: m.speaker_role_id,
      speaker_name: m.speaker_name, phase: m.phase, speech_act: m.speech_act, content: m.content, target_role_ids: m.target_role_ids,
      reply_to_message_id: m.reply_to_message_id, created_at: m.created_at,
      metadata: { act_id: m.metadata.act_id, discussionAddressingMode: m.metadata.discussionAddressingMode, sourceNodeType: m.metadata.sourceNodeType, clueId: m.metadata.clueId, revealed_facts: m.metadata.revealed_facts.filter(f => m.content.includes(f)), emotional_points: [], questions_raised: [], mentioned_role_ids: [], event_tags: [], topic_tags: [] } })),
    storyBoard: { known_facts: s.storyBoard.known_facts, open_questions: s.storyBoard.open_questions, current_conflicts: s.storyBoard.current_conflicts,
      emotional_bonds: s.storyBoard.emotional_bonds, timeline: s.storyBoard.timeline, relationships: s.storyBoard.relationships, contradictions: s.storyBoard.contradictions, discussed_questions: s.storyBoard.discussed_questions },
    userBooklet: s.userBooklet ? { role_id: s.userBooklet.role_id, act_id: s.userBooklet.act_id, title: s.userBooklet.title, private_text: s.userBooklet.private_text } : null,
    playerPdfReading: s.playerPdfReading?.status === "available" ? { status: "available" as const,
      roleId: s.playerPdfReading.roleId, roleName: s.playerPdfReading.roleName, actIndex: s.playerPdfReading.actIndex,
      actTitle: s.playerPdfReading.actTitle, originalName: s.playerPdfReading.originalName, sectionId: s.playerPdfReading.sectionId, assetId: s.playerPdfReading.assetId,
      pdfUrl: s.playerPdfReading.pdfUrl, pageStart: 1, pageEnd: s.playerPdfReading.pageEnd - s.playerPdfReading.pageStart + 1,
      documents: s.playerPdfReading.documents?.map(d => ({ sectionId: d.sectionId, assetId: d.assetId, originalName: d.originalName,
        pdfUrl: d.pdfUrl, pageStart: 1, pageEnd: d.pageEnd - d.pageStart + 1, readingOrder: d.readingOrder,
        required: d.required, completed: d.completed })),
      rangeRestriction: "server_page_slice" as const } : s.playerPdfReading ? { status: "not_configured" as const,
      roleId: s.playerPdfReading.roleId, roleName: s.playerPdfReading.roleName, actIndex: s.playerPdfReading.actIndex,
      actTitle: s.playerPdfReading.actTitle, message: "本幕读本暂未配置，请向开发者反馈。" } : null,
    readBooklets: s.readBooklets.map(b => ({ role_id: b.role_id, act_id: b.act_id, title: b.title, private_text: b.private_text })),
    aiInternalReadingStatus: { actId: s.aiInternalReadingStatus.actId, overallStatus: s.aiInternalReadingStatus.overallStatus,
      completedCount: s.aiInternalReadingStatus.completedCount, failedCount: s.aiInternalReadingStatus.failedCount,
      runningCount: s.aiInternalReadingStatus.runningCount, idleCount: s.aiInternalReadingStatus.idleCount, roles: s.aiInternalReadingStatus.roles.map(r => ({ roleId: r.roleId, roleName: r.roleName,
      status: r.status, agentRunId: null, errorMessage: r.errorMessage ? "读本暂未完成，请稍后重试。" : null,
      startedAt: r.startedAt, completedAt: r.completedAt })) }, userReadingStatus: { actId: s.userReadingStatus.actId, status: s.userReadingStatus.status },
    conversation: { state: s.conversation.state ? { gameSessionId: x.gameId, revision: s.conversation.state.revision, status: s.conversation.state.status,
      stage: s.conversation.state.stage, roleId: s.conversation.state.roleId, seedMessageId: s.conversation.state.seedMessageId,
      actId: s.conversation.state.actId, updatedAt: s.conversation.state.updatedAt, errorMessage: null } : null,
      pending: s.conversation.pending.map(p => ({ clientMessageId: p.clientMessageId, content: p.content, replyToMessageId: p.replyToMessageId, addressingMode: p.addressingMode })),
      acknowledgements: s.conversation.acknowledgements.map(a => ({ clientMessageId: a.clientMessageId, status: a.status, messageId: a.messageId })) },
    controls: { discussionReadiness: s.dmFlowCursor.discussionReadiness ? {
      pendingRoleIds: s.dmFlowCursor.discussionReadiness.pendingRoleIds, sharedRoleIds: s.dmFlowCursor.discussionReadiness.sharedRoleIds,
      humanExpressed: s.dmFlowCursor.discussionReadiness.humanExpressed, pendingQuestions: s.dmFlowCursor.discussionReadiness.pendingQuestions,
      pendingQuestionDetails: s.dmFlowCursor.discussionReadiness.pendingQuestionDetails,
      skippedQuestions: s.dmFlowCursor.discussionReadiness.skippedQuestions,
      ready: s.dmFlowCursor.discussionReadiness.ready, reason: s.dmFlowCursor.discussionReadiness.reason } : null,
      textConfirmation: s.dmFlowCursor.textConfirmation ? { token: s.dmFlowCursor.textConfirmation.token, kind: s.dmFlowCursor.textConfirmation.kind,
      label: s.dmFlowCursor.textConfirmation.label, ready: s.dmFlowCursor.textConfirmation.ready } : null,
      choice: s.dmFlowCursor.choice ? { choiceId: s.dmFlowCursor.choice.choiceId, nodeId: s.dmFlowCursor.choice.nodeId,
        actId: s.dmFlowCursor.choice.actId, prompt: s.dmFlowCursor.choice.prompt,
        requiresReason: s.dmFlowCursor.choice.requiresReason, endsGame: s.dmFlowCursor.choice.endsGame,
        options: s.dmFlowCursor.choice.options.map(o => ({ optionId: o.optionId, label: o.label })),
        ownOptionId: s.dmFlowCursor.choice.ownOptionId, canSubmit: s.dmFlowCursor.choice.canSubmit,
        participants: s.dmFlowCursor.choice.participants.map(p => ({ roleId: p.roleId, completed: p.completed, attempts: p.attempts,
          error: p.error ? "选择暂未完成，请稍后重试。" : undefined })) } : null,
      groupMatching: s.dmFlowCursor.groupMatching ? { choiceId: s.dmFlowCursor.groupMatching.choiceId, nodeId: s.dmFlowCursor.groupMatching.nodeId,
        actId: s.dmFlowCursor.groupMatching.actId, round: s.dmFlowCursor.groupMatching.round, maxRounds: s.dmFlowCursor.groupMatching.maxRounds,
        prompt: s.dmFlowCursor.groupMatching.prompt, roleIds: s.dmFlowCursor.groupMatching.roleIds,
        options: s.dmFlowCursor.groupMatching.options.map(o => ({ optionId: o.optionId, label: o.label })),
        history: s.dmFlowCursor.groupMatching.history.map(h => ({ round: h.round, assignments: h.assignments.map(a => ({ roleId: a.roleId, optionId: a.optionId })), correctCount: h.resultStatus === "pending" ? undefined : h.correctCount })),
        hint: s.dmFlowCursor.groupMatching.hint, canSubmit: s.dmFlowCursor.groupMatching.canSubmit } : null,
      canEnterNextAct: x.currentPhase !== "finished" && s.dmFlowCursor.currentNode?.type === "transition" && !s.dmFlowCursor.cursor?.lifecycle?.recoveryNeedsAttention },
    postShareDiscussion: s.postShareDiscussion ? { id: s.postShareDiscussion.id, status: s.postShareDiscussion.status } : null,
    shareDrafts: s.shareDrafts.map(d => ({ roleId: d.roleId, actId: d.actId, status: d.status })),
    discussionHasResult: Boolean(s.latestAutoDiscussion)
  };
}
export type PlayerGameSnapshot = ReturnType<typeof toPlayerSnapshot>;

// Explicit response envelope: no recursive copying of arbitrary internal fields.
export function playerResponse(body: Record<string, unknown>, status: number) {
  const safe: Record<string, unknown> = {};
  if (body.session && body.game) Object.assign(safe, toPlayerSnapshot(body as unknown as GameRuntimeSnapshot));
  if (body.snapshot) safe.snapshot = toPlayerSnapshot(body.snapshot as GameRuntimeSnapshot);
  if (typeof body.error === "string") safe.error = status === 409 ? "状态已更新或正在处理，请稍候重试。" : status >= 500 ? "操作未完成，请稍后重试。" : "请求不合法或当前无权执行。";
  // Distinguish a rejected input from a temporary state conflict. A rejected
  // draft must not remain in the local retry outbox and lock DM controls.
  if (body.inputRejected === true) {
    safe.inputRejected = true;
    safe.error = "当前窗口不能发送这条消息，内容已退回编辑区。";
  }
  if (typeof body.status === "string") safe.status = body.status;
  // Receipts attest only this authenticated submission, never the internal cursor.
  const receipt = body.choiceReceipt as { duplicate?: boolean; receipt?: Record<string, unknown> } | undefined;
  if (receipt?.receipt) {
    const r = receipt.receipt;
    safe.choiceReceipt = { duplicate: receipt.duplicate, receipt: { choiceId: r.choiceId, nodeId: r.nodeId, actId: r.actId,
      roleId: r.roleId, optionId: r.optionId, requestId: r.requestId, reason: r.reason, round: r.round,
      assignments: Array.isArray(r.assignments) ? r.assignments.map(a => ({ roleId: a.roleId, optionId: a.optionId })) : undefined, correctCount: r.resultStatus === "pending" ? undefined : r.correctCount } };
  }
  return safe;
}

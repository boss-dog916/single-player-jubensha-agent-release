import type { GameSession } from "@/src/lib/session/gameSession";

export type GameAction =
  | {
      type: "SELECT_ROLE";
      userRoleId: string;
      aiRoleIds: string[];
    }
  | {
      type: "USER_FINISHED_READING";
    }
  | {
      type: "AI_INTERNAL_READING_DONE";
    }
  | {
      type: "AI_SHARE_PASSED_CHECKER";
      hasMoreAiToShare: boolean;
    }
  | {
      type: "ALL_AI_SHARED";
    }
  | {
      type: "USER_MESSAGE_ADDED";
    }
  | {
      type: "AI_DISCUSSION_TURN_DONE";
    }
  | {
      type: "DISCUSSION_LIMIT_REACHED";
    }
  | {
      type: "DM_QUESTION_DONE";
    }
  | {
      type: "ACT_SUMMARY_DONE";
      nextActId?: string;
    };

export function transition(session: GameSession, action: GameAction): GameSession {
  switch (session.currentPhase) {
    case "role_selection":
      return transitionFromRoleSelection(session, action);
    case "reading":
      return transitionFromReading(session, action);
    case "ai_internal_reading":
      return transitionFromAiInternalReading(session, action);
    case "share_round":
      return transitionFromShareRound(session, action);
    case "free_discussion":
      return transitionFromFreeDiscussion(session, action);
    case "dm_question":
      return transitionFromDmQuestion(session, action);
    case "act_summary":
      return transitionFromActSummary(session, action);
    case "finished":
      throwInvalidAction(session, action);
  }
}

function transitionFromRoleSelection(session: GameSession, action: GameAction): GameSession {
  if (action.type !== "SELECT_ROLE") {
    throwInvalidAction(session, action);
  }

  return {
    ...session,
    currentPhase: "reading",
    userRoleId: action.userRoleId,
    aiRoleIds: action.aiRoleIds,
    currentShareIndex: 0,
    discussionTurnCount: 0
  };
}

function transitionFromReading(session: GameSession, action: GameAction): GameSession {
  if (action.type !== "USER_FINISHED_READING") {
    throwInvalidAction(session, action);
  }

  return {
    ...session,
    currentPhase: "ai_internal_reading"
  };
}

function transitionFromAiInternalReading(session: GameSession, action: GameAction): GameSession {
  if (action.type !== "AI_INTERNAL_READING_DONE") {
    throwInvalidAction(session, action);
  }

  return {
    ...session,
    currentPhase: "share_round",
    currentShareIndex: 0
  };
}

function transitionFromShareRound(session: GameSession, action: GameAction): GameSession {
  if (action.type === "AI_SHARE_PASSED_CHECKER") {
    return {
      ...session,
      currentShareIndex: action.hasMoreAiToShare
        ? session.currentShareIndex + 1
        : session.currentShareIndex
    };
  }

  if (action.type === "ALL_AI_SHARED") {
    return {
      ...session,
      currentPhase: "free_discussion",
      discussionTurnCount: 0
    };
  }

  throwInvalidAction(session, action);
}

function transitionFromFreeDiscussion(session: GameSession, action: GameAction): GameSession {
  if (action.type === "USER_MESSAGE_ADDED" || action.type === "AI_DISCUSSION_TURN_DONE") {
    return {
      ...session,
      discussionTurnCount: session.discussionTurnCount + 1
    };
  }

  if (action.type === "DISCUSSION_LIMIT_REACHED") {
    return {
      ...session,
      currentPhase: "dm_question"
    };
  }

  throwInvalidAction(session, action);
}

function transitionFromDmQuestion(session: GameSession, action: GameAction): GameSession {
  if (action.type !== "DM_QUESTION_DONE") {
    throwInvalidAction(session, action);
  }

  return {
    ...session,
    currentPhase: "act_summary"
  };
}

function transitionFromActSummary(session: GameSession, action: GameAction): GameSession {
  if (action.type !== "ACT_SUMMARY_DONE") {
    throwInvalidAction(session, action);
  }

  const nextActIndex = session.currentActIndex + 1;

  if (nextActIndex >= session.totalActs) {
    return {
      ...session,
      currentPhase: "finished"
    };
  }

  if (!action.nextActId) {
    throw new Error("ACT_SUMMARY_DONE requires nextActId when another act remains.");
  }

  return {
    ...session,
    currentActIndex: nextActIndex,
    currentActId: action.nextActId,
    currentPhase: "reading",
    currentShareIndex: 0,
    discussionTurnCount: 0
  };
}

function throwInvalidAction(session: GameSession, action: GameAction): never {
  throw new Error(`Invalid action ${action.type} during phase ${session.currentPhase}`);
}

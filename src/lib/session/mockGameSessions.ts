import type { GameSession } from "@/src/lib/session/gameSession";

export const mockGameSessions: Record<string, GameSession> = {
  game_1: {
    gameId: "game_1",
    scriptPackageId: null,
    currentActIndex: 0,
    totalActs: 3,
    userRoleId: null,
    aiRoleIds: [],
    userReadActIds: [],
    currentActId: "act_1",
    currentPhase: "role_selection",
    currentShareIndex: 0,
    discussionTurnCount: 0,
    maxDiscussionTurns: 18
  },
  game_selected_role_a: {
    gameId: "game_selected_role_a",
    scriptPackageId: null,
    currentActIndex: 0,
    totalActs: 3,
    userRoleId: "role_a",
    aiRoleIds: ["role_b", "role_c", "role_d"],
    userReadActIds: [],
    currentActId: "act_1",
    currentPhase: "reading",
    currentShareIndex: 0,
    discussionTurnCount: 0,
    maxDiscussionTurns: 18
  }
};

export function getGameSession(gameId: string): GameSession {
  const session = mockGameSessions[gameId];

  if (!session) {
    throw new Error(`GameSession not found for gameId "${gameId}".`);
  }

  return session;
}

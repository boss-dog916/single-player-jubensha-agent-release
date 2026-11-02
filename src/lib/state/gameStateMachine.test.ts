import { describe, expect, it } from "vitest";
import type { GameSession } from "@/src/lib/session/gameSession";
import { transition } from "@/src/lib/state/gameStateMachine";

function createSession(overrides: Partial<GameSession> = {}): GameSession {
  return {
    gameId: "game_test",
    scriptPackageId: null,
    currentActIndex: 0,
    totalActs: 3,
    currentActId: "act_1",
    currentPhase: "role_selection",
    userRoleId: null,
    aiRoleIds: [],
    userReadActIds: [],
    currentShareIndex: 0,
    discussionTurnCount: 0,
    maxDiscussionTurns: 18,
    ...overrides
  };
}

describe("game state machine", () => {
  it("moves from role_selection to reading after SELECT_ROLE", () => {
    const next = transition(createSession(), {
      type: "SELECT_ROLE",
      userRoleId: "role_a",
      aiRoleIds: ["role_b", "role_c", "role_d"]
    });

    expect(next.currentPhase).toBe("reading");
    expect(next.userRoleId).toBe("role_a");
    expect(next.aiRoleIds).toEqual(["role_b", "role_c", "role_d"]);
    expect(next.currentShareIndex).toBe(0);
    expect(next.discussionTurnCount).toBe(0);
  });

  it("moves from reading to ai_internal_reading", () => {
    const next = transition(createSession({ currentPhase: "reading", userRoleId: "role_a" }), {
      type: "USER_FINISHED_READING"
    });

    expect(next.currentPhase).toBe("ai_internal_reading");
  });

  it("moves from ai_internal_reading to share_round", () => {
    const next = transition(
      createSession({
        currentPhase: "ai_internal_reading",
        currentShareIndex: 2
      }),
      { type: "AI_INTERNAL_READING_DONE" }
    );

    expect(next.currentPhase).toBe("share_round");
    expect(next.currentShareIndex).toBe(0);
  });

  it("advances currentShareIndex after an AI share passes Checker", () => {
    const next = transition(createSession({ currentPhase: "share_round" }), {
      type: "AI_SHARE_PASSED_CHECKER",
      hasMoreAiToShare: true
    });

    expect(next.currentPhase).toBe("share_round");
    expect(next.currentShareIndex).toBe(1);
  });

  it("does not leave share_round when the last AI share passes Checker until ALL_AI_SHARED", () => {
    const afterChecker = transition(createSession({ currentPhase: "share_round", currentShareIndex: 2 }), {
      type: "AI_SHARE_PASSED_CHECKER",
      hasMoreAiToShare: false
    });

    expect(afterChecker.currentPhase).toBe("share_round");
    expect(afterChecker.currentShareIndex).toBe(2);

    const afterAllShared = transition(afterChecker, { type: "ALL_AI_SHARED" });

    expect(afterAllShared.currentPhase).toBe("free_discussion");
    expect(afterAllShared.discussionTurnCount).toBe(0);
  });

  it("counts user and AI discussion turns while staying in free_discussion", () => {
    const afterUser = transition(createSession({ currentPhase: "free_discussion" }), {
      type: "USER_MESSAGE_ADDED"
    });
    const afterAi = transition(afterUser, { type: "AI_DISCUSSION_TURN_DONE" });

    expect(afterUser.currentPhase).toBe("free_discussion");
    expect(afterUser.discussionTurnCount).toBe(1);
    expect(afterAi.currentPhase).toBe("free_discussion");
    expect(afterAi.discussionTurnCount).toBe(2);
  });

  it("moves from free_discussion to dm_question when the discussion limit is reached", () => {
    const next = transition(createSession({ currentPhase: "free_discussion" }), {
      type: "DISCUSSION_LIMIT_REACHED"
    });

    expect(next.currentPhase).toBe("dm_question");
  });

  it("moves from dm_question to act_summary", () => {
    const next = transition(createSession({ currentPhase: "dm_question" }), {
      type: "DM_QUESTION_DONE"
    });

    expect(next.currentPhase).toBe("act_summary");
  });

  it("moves from act_summary to the next act reading phase when another act remains", () => {
    const next = transition(createSession({ currentPhase: "act_summary", currentShareIndex: 2 }), {
      type: "ACT_SUMMARY_DONE",
      nextActId: "act_2"
    });

    expect(next.currentPhase).toBe("reading");
    expect(next.currentActIndex).toBe(1);
    expect(next.currentActId).toBe("act_2");
    expect(next.currentShareIndex).toBe(0);
    expect(next.discussionTurnCount).toBe(0);
  });

  it("moves from act_summary to finished when the final act is complete", () => {
    const next = transition(
      createSession({
        currentPhase: "act_summary",
        currentActIndex: 2,
        currentActId: "act_3"
      }),
      { type: "ACT_SUMMARY_DONE" }
    );

    expect(next.currentPhase).toBe("finished");
  });

  it("covers a complete three-act flow", () => {
    let session = createSession();

    session = transition(session, {
      type: "SELECT_ROLE",
      userRoleId: "role_a",
      aiRoleIds: ["role_b", "role_c", "role_d"]
    });

    for (const nextActId of ["act_2", "act_3", undefined]) {
      session = transition(session, { type: "USER_FINISHED_READING" });
      session = transition(session, { type: "AI_INTERNAL_READING_DONE" });
      session = transition(session, { type: "AI_SHARE_PASSED_CHECKER", hasMoreAiToShare: true });
      session = transition(session, { type: "AI_SHARE_PASSED_CHECKER", hasMoreAiToShare: true });
      session = transition(session, { type: "AI_SHARE_PASSED_CHECKER", hasMoreAiToShare: false });
      session = transition(session, { type: "ALL_AI_SHARED" });
      session = transition(session, { type: "USER_MESSAGE_ADDED" });
      session = transition(session, { type: "AI_DISCUSSION_TURN_DONE" });
      session = transition(session, { type: "DISCUSSION_LIMIT_REACHED" });
      session = transition(session, { type: "DM_QUESTION_DONE" });
      session = transition(session, {
        type: "ACT_SUMMARY_DONE",
        nextActId
      });
    }

    expect(session.currentPhase).toBe("finished");
    expect(session.currentActIndex).toBe(2);
    expect(session.currentActId).toBe("act_3");
  });

  it("throws on illegal transitions", () => {
    expect(() =>
      transition(createSession({ currentPhase: "reading" }), {
        type: "AI_SHARE_PASSED_CHECKER",
        hasMoreAiToShare: true
      })
    ).toThrow("Invalid action AI_SHARE_PASSED_CHECKER during phase reading");

    expect(() =>
      transition(createSession({ currentPhase: "share_round" }), {
        type: "DISCUSSION_LIMIT_REACHED"
      })
    ).toThrow("Invalid action DISCUSSION_LIMIT_REACHED during phase share_round");

    expect(() =>
      transition(createSession({ currentPhase: "finished" }), {
        type: "USER_MESSAGE_ADDED"
      })
    ).toThrow("Invalid action USER_MESSAGE_ADDED during phase finished");
  });

  it("requires nextActId when another act remains", () => {
    expect(() =>
      transition(createSession({ currentPhase: "act_summary", currentActIndex: 0 }), {
        type: "ACT_SUMMARY_DONE"
      })
    ).toThrow("ACT_SUMMARY_DONE requires nextActId when another act remains.");
  });
});

import type { PublicStoryBoard } from "../types/game";

/** Missing settings mean an existing game, preserving its original behavior.
 * New games explicitly persist false (or the user's opt-in) in GameSession. */
export function publicStoryBoardEnabled(session: { runtimeScope?: unknown; runtimeScopeJson?: string | null; publicStoryBoardEnabled?: boolean }) {
  if (typeof session.publicStoryBoardEnabled === "boolean") return session.publicStoryBoardEnabled;
  let scope = session.runtimeScope;
  if (scope == null && session.runtimeScopeJson) {
    try { scope = JSON.parse(session.runtimeScopeJson); } catch { scope = null; }
  }
  return (scope as { publicStoryBoardEnabled?: boolean } | null)?.publicStoryBoardEnabled !== false;
}

/** Only for callers that previously serialized the entire auxiliary board.
 * Existing role-specific discussion briefs and their retrieval remain intact. */
export function boardPromptView(board: PublicStoryBoard, enabled = true): PublicStoryBoard {
  if (enabled) return board;
  return { ...board, known_facts: board.known_facts.slice(-8), timeline: board.timeline.slice(-5),
    relationships: board.relationships.slice(-5), open_questions: board.open_questions.slice(-5),
    contradictions: board.contradictions.slice(-5), emotional_bonds: board.emotional_bonds.slice(-5),
    discussed_questions: board.discussed_questions.slice(-5), current_conflicts: board.current_conflicts.slice(-5) };
}

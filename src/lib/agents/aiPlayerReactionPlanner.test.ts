import { expect, it, vi } from "vitest";
import { generateStructured } from "@/src/lib/llm/llmClient";
import { planAiPlayerReaction } from "./aiPlayerReactionPlanner";
import type { CompactReactionContext } from "@/src/lib/orchestration/discussionOrchestrator";
import type { ReactionIntent } from "@/src/lib/schemas/reactionIntentSchema";
vi.mock("@/src/lib/llm/llmClient", () => ({ generateStructured: vi.fn() }));
const actualCandidate: ReactionIntent = {
  role_id: "role_a", wants_to_speak: true, trigger_type: "direct_question_to_self", relevance_score: 5,
  urgency_score: 4, emotional_intensity_score: 2, boundary_risk: "low", target_role_ids: ["role_d"], speech_act: "answer",
  reason: "夏月声明自己是林安的女朋友，希望确认关系。", brief_intent: "确认身份关系。",
  addressing: { addressingMode: "direct", directTargets: ["role_d"], referencedRoles: [], excludedTargets: [], topic: "身份关系确认" }
};
function context() {
  return { role: { role_id: "role_a", name: "林安" }, latest_message: { id: "demo-introduction", speaker_role_id: "role_d",
    target_role_ids: [], speech_act: "statement", content: "我是林安女朋友", metadata: {} },
    addressing_context: { preAnalysis: { addressingMode: "none", directTargets: [], referencedRoles: ["role_a"], excludedTargets: [],
      topic: "身份关系", source: "heuristic", needsPlanner: true, controlMessage: false, reason: "普通陈述中的角色引用" },
      publicRoster: [{ role_id: "role_a", name: "林安" }, { role_id: "role_d", name: "夏月" }], recentPublicMessages: [] }
  } as unknown as CompactReactionContext;
}
async function plan(c: CompactReactionContext, candidate = actualCandidate) {
  vi.mocked(generateStructured).mockResolvedValue({ data: candidate, agentRunId: "stored-original-candidate" } as never);
  return (await planAiPlayerReaction({ gameSessionId: "offline", roleId: "role_a", actId: "act_1", phase: "share_round", context: c, mockOutput: candidate })).intent;
}
it("repairs the witnessed reply-recipient confusion without inventing a question or mandatory response", async () => {
  const result = await plan(context());
  expect(result.trigger_type).toBe("minor_relevance"); expect(result.addressing?.addressingMode).toBe("none");
  expect(result.addressing?.directTargets).toEqual([]); expect(result.target_role_ids).toEqual(["role_d"]);
  expect(actualCandidate.addressing?.directTargets).toEqual(["role_d"]);
});
it("preserves actual direct questions and their reply recipient", async () => {
  const c = context(); c.latest_message.speech_act = "question"; c.latest_message.content = "林安，你记得什么？";
  Object.assign(c.addressing_context!.preAnalysis, { addressingMode: "direct", directTargets: ["role_a"], needsPlanner: false });
  const candidate = { ...actualCandidate, addressing: { ...actualCandidate.addressing!, directTargets: ["role_a"] } };
  expect(await plan(c, candidate)).toEqual(candidate);
});
it("does not normalize excluded roles or group invitations", async () => {
  const c = context(); c.addressing_context!.preAnalysis.excludedTargets = ["role_a"];
  expect((await plan(c)).trigger_type).toBe("direct_question_to_self");
  c.addressing_context!.preAnalysis.excludedTargets = []; c.addressing_context!.preAnalysis.addressingMode = "group";
  expect((await plan(c)).addressing?.addressingMode).toBe("direct");
});

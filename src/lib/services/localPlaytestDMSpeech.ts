import "server-only";
import { realizeDMNodeSpeech } from "./dmNodeRealizerService";
import { checkDmOutput } from "@/src/lib/agents/dmOutputChecker";
import { createAgentRun, completeAgentRun } from "./agentRunService";
import type { DMFlowNode } from "@/src/lib/schemas/dmFlowSchema";
import type { GamePhase } from "@/src/lib/types/game";

// Standard runtime. Reuse the existing realizer/checker for REFERENCE wording.
// No model controls a wait, condition, completion or transition here.
export async function localPlaytestDMSpeech(gameId: string, actId: string, phase: GamePhase, node: DMFlowNode) {
  const reviewed = node.fixedLine!;
  // The realizer's compact node view is 220 chars and its checker caps speech at
  // 240. Long approved narratives must not pass through that paraphrase path.
  if (reviewed.length > 220) return reviewed;
  if (process.env.DM_REFERENCE_WORDING_ENABLED === "false" || node.textExecution?.fidelity !== "reference") return reviewed;
  try {
    // The sourceEvidence remains in the published definition. Only approved
    // speakable reference text reaches this model, never raw manual instructions.
    const allowed = { ...node, text: reviewed, sourceQuote: reviewed, conditionalRules: [], requiredPublicPoints: [], ifMissingPoints: [],
      guidance: { discussionGoal: reviewed, requiredPublicPoints: [], ifMissingPoints: [], forbiddenReveals: node.forbiddenReveals,
        toneGuidance: null, fallbackHint: reviewed } };
    const speech = await realizeDMNodeSpeech({ gameId, currentNode: allowed, mode: "guided_speech", phase, trigger: "reference_wording_only",
      analysis: { publicSummary: [], mentionedPoints: [], missingPoints: [], speakerCoverage: [], openQuestions: [], contradictions: [],
        suggestedDmAction: "wait_for_user", suggestedCueTargets: [], safetyWarnings: [] } });
    const checked = await checkDmOutput({ gameSessionId: gameId, actId, phase, trigger: "reference_wording_only", nodeKey: node.nodeId,
      source: "script_guided", output: speech.text, forbiddenReveals: node.forbiddenReveals, forbiddenTopics: [], requiredPublicPoints: [] });
    if (checked.passed && !speech.safetyWarnings.length) return speech.text;
  } catch { /* SDK failures retain their ordinary Trace; fallback adds a receipt. */ }
  const run = await createAgentRun({ gameSessionId: gameId, agentType: "dm_reference_fallback", actId, phase, runKind: "span",
    inputJson: { nodeId: node.nodeId, reason: "reference_generation_unavailable_or_blocked" } });
  await completeAgentRun({ agentRunId: run.id, outputJson: { source: "reviewed_reference_text", nodeId: node.nodeId }, latencyMs: 0 });
  return reviewed;
}

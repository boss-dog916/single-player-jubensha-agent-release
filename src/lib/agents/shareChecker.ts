import "server-only";

import { generateStructured } from "@/src/lib/llm/llmClient";
import { buildShareCheckerPrompt } from "@/src/lib/prompts/shareCheckerPrompt";
import type { AiPlayerPublicShareOutput } from "@/src/lib/schemas/aiPlayerPublicShareSchema";
import { ShareCheckerSchema, type ShareCheckerOutput } from "@/src/lib/schemas/shareCheckerSchema";
import type { RoleId } from "@/src/lib/script/scriptTypes";
import { failAgentRun } from "@/src/lib/services/agentRunService";
import { buildAiPlayerContext, getGameSession } from "@/src/lib/services/gameService";

export class ShareCheckerBlockedError extends Error {
  readonly checkerResult: ShareCheckerOutput;
  readonly agentRunId: string;

  constructor(checkerResult: ShareCheckerOutput, agentRunId: string) {
    super("AI public share was blocked by shareChecker.");
    this.name = "ShareCheckerBlockedError";
    this.checkerResult = checkerResult;
    this.agentRunId = agentRunId;
  }
}

export type CheckAiPublicShareInput = {
  gameSessionId: string;
  roleId: RoleId;
  candidate: AiPlayerPublicShareOutput;
  mockOutput?: unknown;
  throwOnBlock?: boolean;
};

export type CheckAiPublicShareResult = {
  roleId: RoleId;
  output: ShareCheckerOutput;
  agentRunId: string;
};

export async function checkAiPublicShare({
  gameSessionId,
  roleId,
  candidate,
  mockOutput,
  throwOnBlock = true
}: CheckAiPublicShareInput): Promise<CheckAiPublicShareResult> {
  const [session, context] = await Promise.all([
    getGameSession(gameSessionId),
    buildAiPlayerContext(gameSessionId, roleId)
  ]);
  const result = await generateStructured<ShareCheckerOutput>({
    gameSessionId,
    agentType: "share_checker",
    roleId,
    actId: context.act_id,
    phase: "share_round",
    schemaName: "share_checker",
    zodSchema: ShareCheckerSchema,
    messages: buildShareCheckerPrompt(session, context, candidate),
    mockOutput: mockOutput ?? createPassingCheckerOutput()
  });

  if (!result.data.passed || !result.data.safe_to_publish) {
    await failAgentRun({
      agentRunId: result.agentRunId,
      error: "checker_blocked",
      errorMessage: result.data.reasons.join("; ") || "shareChecker blocked the candidate.",
      outputJson: result.data,
      checkerResultJson: result.data,
      latencyMs: result.latencyMs
    });

    if (throwOnBlock) {
      throw new ShareCheckerBlockedError(result.data, result.agentRunId);
    }
  }

  return {
    roleId,
    output: result.data,
    agentRunId: result.agentRunId
  };
}

function createPassingCheckerOutput(): ShareCheckerOutput {
  return {
    passed: true,
    safe_to_publish: true,
    reasons: ["候选发言只使用允许上下文，适合公开分享。"],
    violations: [],
    covered_must_share: true,
    decision: "pass",
    rewrite_advice: null,
    missing_must_share: [],
    quality_issues: [],
    leakage_issues: []
  };
}

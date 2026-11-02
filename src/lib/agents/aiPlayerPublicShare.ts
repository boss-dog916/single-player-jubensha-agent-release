import "server-only";

import { generateStructured } from "@/src/lib/llm/llmClient";
import { buildAiPlayerPublicSharePrompt } from "@/src/lib/prompts/aiPlayerPublicSharePrompt";
import { AiPlayerPublicShareSchema, type AiPlayerPublicShareOutput } from "@/src/lib/schemas/aiPlayerPublicShareSchema";
import type { RoleId } from "@/src/lib/script/scriptTypes";
import { buildAiPlayerContext, getGameSession } from "@/src/lib/services/gameService";

export type GenerateAiPlayerPublicShareInput = {
  gameSessionId: string;
  roleId: RoleId;
  mockOutput?: unknown;
  repairInstructions?: unknown;
  preGeneration?: boolean;
};

export type GenerateAiPlayerPublicShareResult = {
  roleId: RoleId;
  output: AiPlayerPublicShareOutput;
  agentRunId: string;
};

export async function generateAiPlayerPublicShare({
  gameSessionId,
  roleId,
  mockOutput,
  repairInstructions = null,
  preGeneration = false
}: GenerateAiPlayerPublicShareInput): Promise<GenerateAiPlayerPublicShareResult> {
  const [session, context] = await Promise.all([
    getGameSession(gameSessionId),
    buildAiPlayerContext(gameSessionId, roleId)
  ]);
  const result = await generateStructured<AiPlayerPublicShareOutput>({
    gameSessionId,
    agentType: "ai_player_public_share",
    roleId,
    actId: context.act_id,
    phase: "share_round",
    schemaName: "ai_player_public_share",
    zodSchema: AiPlayerPublicShareSchema,
    messages: buildAiPlayerPublicSharePrompt(preGeneration ? { ...session, currentPhase: "share_round" } : session, context, repairInstructions),
    mockOutput: mockOutput ?? createMockPublicShareOutput(context)
  });

  return {
    roleId,
    output: result.data,
    agentRunId: result.agentRunId
  };
}

function createMockPublicShareOutput(
  context: Awaited<ReturnType<typeof buildAiPlayerContext>>
): AiPlayerPublicShareOutput {
  const mustShareText = context.must_share.join("；");
  const mayShareText = context.may_share.slice(0, 2).join("；");
  const content = [
    "我先按我这一幕经历的顺序说一下。刚开始我能确认的情况是，" +
      (mustShareText || "我还没有特别明确的公共发现") +
      "。",
    mayShareText
      ? `另外有些细节我现在也不太确定能不能完全判断，我的感觉是：${mayShareText}。`
      : "如果后面大家的信息能对上，我再补充我不太确定的部分。"
  ].join("\n\n");

  return {
    content: removeFieldLikePhrases(content),
    metadata: {
      revealed_facts: context.must_share,
      emotional_points: context.may_share,
      questions_raised: extractQuestions(context.may_share),
      mentioned_role_ids: [],
      event_tags: extractTags(context.must_share),
      topic_tags: extractTags([...context.must_share, ...context.may_share])
    },
    self_check: {
      covered_must_share: true,
      avoided_must_not_share: true,
      used_only_allowed_context: true
    }
  };
}

function removeFieldLikePhrases(content: string): string {
  return content
    .replaceAll("必须公开的信息", "能确认的情况")
    .replaceAll("mustShare", "这一幕经历")
    .replaceAll("本幕信息包括", "我先说一下");
}

function extractTags(items: string[]): string[] {
  return Array.from(
    new Set(
      items
        .flatMap((item) => item.split(/[，。；、\s]+/))
        .map((item) => item.trim())
        .filter((item) => item.length >= 2)
        .slice(0, 8)
    )
  );
}

function extractQuestions(items: string[]): string[] {
  return items.filter((item) => item.includes("?") || item.includes("？"));
}

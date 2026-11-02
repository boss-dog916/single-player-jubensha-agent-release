import "server-only";

import { completeAgentRun, createAgentRun, failAgentRun } from "@/src/lib/services/agentRunService";
import type { DmOutputCheckerOutput } from "@/src/lib/schemas/dmOutputCheckerSchema";
import type { GamePhase } from "@/src/lib/types/game";

export type CheckDmOutputInput = {
  gameSessionId: string;
  actId: string;
  phase: GamePhase;
  trigger: string;
  nodeKey: string;
  source: string;
  output: string;
  forbiddenReveals: string[];
  forbiddenTopics: string[];
  requiredPublicPoints: string[];
};

export async function checkDmOutput(input: CheckDmOutputInput): Promise<DmOutputCheckerOutput> {
  const startedAt = Date.now();
  const agentRun = await createAgentRun({
    gameSessionId: input.gameSessionId,
    agentType: "dm_output_checker",
    actId: input.actId,
    phase: input.phase,
    inputJson: {
      trigger: input.trigger,
      nodeKey: input.nodeKey,
      source: input.source,
      output: input.output,
      forbiddenReveals: input.forbiddenReveals,
      forbiddenTopics: input.forbiddenTopics,
      requiredPublicPoints: input.requiredPublicPoints
    }
  });

  try {
    const result = runRuleBasedChecks(input);

    await completeAgentRun({
      agentRunId: agentRun.id,
      outputJson: result,
      latencyMs: Date.now() - startedAt
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "DM Output Checker failed.";

    await failAgentRun({
      agentRunId: agentRun.id,
      error: "dm_output_checker_failed",
      errorMessage: message,
      latencyMs: Date.now() - startedAt
    });

    throw error;
  }
}

function runRuleBasedChecks(input: CheckDmOutputInput): DmOutputCheckerOutput {
  const issues: string[] = [];
  const checkedItems = [
    "forbidden_reveals",
    "forbidden_topics",
    "required_public_points_not_directly_revealed",
    "generic_future_truth_terms",
    "length"
  ];

  collectIncludedItems(input.output, input.forbiddenReveals).forEach((item) => {
    issues.push(`包含 forbidden_reveals：${item}`);
  });
  collectIncludedItems(input.output, input.forbiddenTopics).forEach((item) => {
    issues.push(`包含 forbidden_topics：${item}`);
  });
  collectIncludedItems(input.output, input.requiredPublicPoints).forEach((item) => {
    issues.push(`直接说出了 required_public_points：${item}`);
  });

  if (!input.output.trim()) {
    issues.push("DM 发言为空。");
  }

  if (/真相是|最终真相|凶手是|其实你们不知道的是/.test(input.output)) {
    issues.push("疑似使用最终真相或全知视角话术。");
  }

  if (input.output.trim().length > 240) {
    issues.push("DM 发言过长。");
  }

  return {
    passed: issues.length === 0,
    decision: issues.length === 0 ? "pass" : "block",
    issues,
    blocked_reason: issues[0] ?? null,
    checked_items: checkedItems
  };
}

function collectIncludedItems(output: string, items: string[]): string[] {
  const compactOutput = normalizeForContainment(output);

  return items.filter((item) => {
    const compactItem = normalizeForContainment(item);

    return compactItem.length >= 4 && compactOutput.includes(compactItem);
  });
}

function normalizeForContainment(value: string): string {
  return value.replace(/\s+/g, "").replace(/[，。！？、：；,.!?:;]/g, "").trim();
}

import { boardPromptView } from "@/src/lib/services/storyBoardSettings";
import "server-only";

import { generateText } from "@/src/lib/llm/llmClient";
import { buildDmGuidedPrompt } from "@/src/lib/prompts/dmGuidedPrompt";
import type { RoleId } from "@/src/lib/script/scriptTypes";
import { getDmFallbackContent, type DmFallbackTrigger } from "@/src/lib/agents/dmFallbackTemplates";
import { checkDmOutput } from "@/src/lib/agents/dmOutputChecker";
import {
  getActLevelForbiddenRevealsFromScript,
  getDmFlowNodeFromScript,
  resolveDmNodeSource,
  type DmFlowNode,
  type DmOutputSource
} from "@/src/lib/services/dmManualService";
import { completeAgentRun, createAgentRun, failAgentRun } from "@/src/lib/services/agentRunService";
import { getGameSession } from "@/src/lib/services/gameService";
import { listRecentPublicMessages, createMessage } from "@/src/lib/services/messageService";
import { getOrCreatePublicStoryBoard } from "@/src/lib/services/storyBoardService";
import { getScriptForGameSession } from "@/src/lib/services/scriptPackageService";
import { executeDMFlowCursorNode } from "@/src/lib/services/dmFlowCursorService";
import type { GamePhase, Message } from "@/src/lib/types/game";

export type DmFlowTrigger = DmFallbackTrigger;

export type RunDmFlowStepInput = {
  gameSessionId: string;
  trigger: DmFlowTrigger;
  targetRoleId?: RoleId | null;
  nextAction?: "advance_phase" | "wait_for_user" | "none";
};

export type RunDmFlowStepResult = {
  trigger: DmFlowTrigger;
  nodeKey: string;
  source: DmOutputSource;
  dmOutput: string;
  checkerResult: Awaited<ReturnType<typeof checkDmOutput>> | null;
  message: Message | null;
  autoExecutedMessage?: Message | null;
  nextAction: "advance_phase" | "wait_for_user" | "none";
};

export async function runDmFlowStep(input: RunDmFlowStepInput): Promise<RunDmFlowStepResult> {
  const startedAt = Date.now();
  const session = await getGameSession(input.gameSessionId);

  if (session.runtimeDefinitionId) {
    const cursorResult = await executeDMFlowCursorNode(input);

    if (cursorResult.handled) {
      const runnerRun = await createAgentRun({
        gameSessionId: input.gameSessionId,
        agentType: "dm_flow_runner",
        actId: session.currentActId,
        phase: session.currentPhase,
        inputJson: {
          trigger: input.trigger,
          targetRoleId: input.targetRoleId ?? null,
          nextAction: input.nextAction ?? null,
          runtimeCursor: true
        }
      });
      const result: RunDmFlowStepResult = {
        trigger: input.trigger,
        nodeKey: cursorResult.nodeKey,
        source: cursorResult.source === "conditional_rule" ? "script_guided" : cursorResult.source,
        dmOutput: cursorResult.dmOutput,
        checkerResult: null,
        message: cursorResult.message,
        autoExecutedMessage: cursorResult.autoExecutedMessage ?? null,
        nextAction: cursorResult.nextAction
      };

      await completeAgentRun({
        agentRunId: runnerRun.id,
        outputJson: {
          ...result,
          messageCreated: Boolean(result.message),
          runtimeCursor: cursorResult.cursor
        },
        latencyMs: Date.now() - startedAt
      });

      return result;
    }
  }

  const script = await getScriptForGameSession(input.gameSessionId);
  const nodeKey = getNodeKeyForTrigger(input.trigger);
  const node = getDmFlowNodeFromScript(script, script.script_id, session.currentActId, nodeKey);
  const source = resolveDmNodeSource(node);
  const targetRoleName = input.targetRoleId ? getRoleName(script, input.targetRoleId) : null;
  const nextAction = input.nextAction ?? inferNextAction(input.trigger);
  const runnerRun = await createAgentRun({
    gameSessionId: input.gameSessionId,
    agentType: "dm_flow_runner",
    actId: session.currentActId,
    phase: session.currentPhase,
    inputJson: {
      trigger: input.trigger,
      nodeKey,
      resolvedSource: source,
      targetRoleId: input.targetRoleId ?? null,
      nextAction,
      nodeSummary: summarizeNode(node)
    }
  });

  try {
    const dmOutput = await resolveDmOutput({
      gameSessionId: input.gameSessionId,
      trigger: input.trigger,
      nodeKey,
      node,
      source,
      targetRoleId: input.targetRoleId ?? null,
      targetRoleName,
      nextAction
    });
    const checkerResult =
      source === "system_fallback"
        ? null
        : await checkDmOutput({
            gameSessionId: input.gameSessionId,
            actId: session.currentActId,
            phase: session.currentPhase,
            trigger: input.trigger,
            nodeKey,
            source,
            output: dmOutput,
            forbiddenReveals: [
              ...getActLevelForbiddenRevealsFromScript(script, script.script_id, session.currentActId),
              ...(node?.forbidden_reveals ?? [])
            ],
            forbiddenTopics: source === "script_guided" ? node?.forbidden_topics ?? [] : [],
            requiredPublicPoints: source === "script_guided" ? node?.required_public_points ?? [] : []
          });

    if (checkerResult && !checkerResult.passed) {
      const result = {
        trigger: input.trigger,
        nodeKey,
        source,
        dmOutput,
        checkerResult,
        message: null,
        nextAction
      };

      await completeAgentRun({
        agentRunId: runnerRun.id,
        outputJson: {
          ...result,
          messageCreated: false
        },
        checkerResultJson: checkerResult,
        latencyMs: Date.now() - startedAt
      });

      return result;
    }

    const message = await createMessage({
      gameSessionId: input.gameSessionId,
      speakerType: "dm",
      speakerRoleId: "dm",
      speakerName: "DM",
      targetRoleIds: input.targetRoleId ? [input.targetRoleId] : [],
      phase: session.currentPhase,
      speechAct: getSpeechActForNode(nodeKey),
      content: dmOutput,
      metadata: {
        revealed_facts: [],
        emotional_points: [],
        questions_raised: nodeKey === "dm_question" ? [dmOutput] : [],
        mentioned_role_ids: input.targetRoleId ? [input.targetRoleId] : [],
        event_tags: [],
        topic_tags: [],
        source,
        dm_flow_node: nodeKey,
        trigger: input.trigger,
        storyBoardEligible: isStoryBoardEligible(node, source, nodeKey),
        next_action: nextAction
      }
    });
    const result = {
      trigger: input.trigger,
      nodeKey,
      source,
      dmOutput,
      checkerResult,
      message,
      nextAction
    };

    await completeAgentRun({
      agentRunId: runnerRun.id,
      outputJson: {
        ...result,
        messageCreated: true
      },
      checkerResultJson: checkerResult,
      latencyMs: Date.now() - startedAt
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "DM flow runner failed.";

    await failAgentRun({
      agentRunId: runnerRun.id,
      error: "dm_flow_runner_failed",
      errorMessage: message,
      latencyMs: Date.now() - startedAt
    });

    throw error;
  }
}

async function resolveDmOutput(input: {
  gameSessionId: string;
  trigger: DmFlowTrigger;
  nodeKey: string;
  node: DmFlowNode | null;
  source: DmOutputSource;
  targetRoleId: RoleId | null;
  targetRoleName: string | null;
  nextAction: "advance_phase" | "wait_for_user" | "none";
}): Promise<string> {
  if (input.source === "script_fixed") {
    return renderTemplate(input.node?.content ?? input.node?.content_template ?? "", {
      roleName: input.targetRoleName ?? input.targetRoleId ?? "下一位角色"
    });
  }

  if (input.source === "script_guided") {
    return generateGuidedDmOutput(input);
  }

  return getDmFallbackContent({
    trigger: input.trigger,
    roleName: input.targetRoleName,
    roleId: input.targetRoleId
  });
}

async function generateGuidedDmOutput(input: {
  gameSessionId: string;
  trigger: DmFlowTrigger;
  nodeKey: string;
  node: DmFlowNode | null;
  targetRoleId: RoleId | null;
  targetRoleName: string | null;
  nextAction: "advance_phase" | "wait_for_user" | "none";
}): Promise<string> {
  const [session, publicStoryBoard, recentPublicMessages] = await Promise.all([
    getGameSession(input.gameSessionId),
    getOrCreatePublicStoryBoard(input.gameSessionId),
    listRecentPublicMessages(input.gameSessionId, 8)
  ]);
  const result = await generateText({
    gameSessionId: input.gameSessionId,
    agentType: "dm_agent_guided",
    actId: session.currentActId,
    phase: session.currentPhase,
    temperature: 0.2,
    maxOutputTokens: 220,
    messages: buildDmGuidedPrompt({
      actId: session.currentActId,
      phase: session.currentPhase,
      trigger: input.trigger,
      dm_flow_node: {
        nodeKey: input.nodeKey,
        guidance: input.node?.guidance ?? null,
        question_goal: input.node?.question_goal ?? null,
        required_public_points: input.node?.required_public_points ?? [],
        focus_points: input.node?.focus_points ?? [],
        emotion_prompts: input.node?.emotion_prompts ?? [],
        forbidden_topics: input.node?.forbidden_topics ?? [],
        forbidden_reveals: input.node?.forbidden_reveals ?? [],
        if_missing_points: input.node?.if_missing_points ?? [],
        summary_guidance: input.node?.summary_guidance ?? [],
        target_role_id: input.node?.target_role_id ?? input.targetRoleId ?? null,
        target_role_name: input.targetRoleName
      },
      publicStoryBoard: boardPromptView(publicStoryBoard, session.publicStoryBoardEnabled),
      recentPublicMessages,
      discussionTurnCount: session.discussionTurnCount,
      next_action: input.nextAction
    })
  });

  return cleanupGeneratedText(result.text);
}

function getNodeKeyForTrigger(trigger: DmFlowTrigger): string {
  const map: Record<DmFlowTrigger, string> = {
    game_started: "opening",
    role_selected: "opening",
    enter_reading: "reading_instruction",
    enter_share_round: "share_intro",
    before_next_share: "share_prompt",
    all_shares_completed: "free_discussion",
    enter_free_discussion: "free_discussion",
    discussion_turn_limit_reached: "discussion_guidance",
    enter_dm_question: "dm_question",
    enter_act_summary: "act_summary",
    advance_to_next_act: "advance_to_next_act",
    finished: "finished"
  };

  return map[trigger];
}

function getSpeechActForNode(nodeKey: string) {
  return nodeKey === "dm_question" ? "question" : "notice";
}

function inferNextAction(trigger: DmFlowTrigger): "advance_phase" | "wait_for_user" | "none" {
  if (
    trigger === "game_started" ||
    trigger === "enter_reading" ||
    trigger === "enter_share_round" ||
    trigger === "all_shares_completed" ||
    trigger === "discussion_turn_limit_reached" ||
    trigger === "enter_act_summary" ||
    trigger === "advance_to_next_act" ||
    trigger === "finished"
  ) {
    return "advance_phase";
  }

  if (trigger === "before_next_share" || trigger === "enter_dm_question") {
    return "wait_for_user";
  }

  return "none";
}

function isStoryBoardEligible(
  node: DmFlowNode | null,
  source: DmOutputSource,
  nodeKey: string
): boolean {
  if (source === "system_fallback") {
    return false;
  }

  if (typeof node?.storyBoardEligible === "boolean") {
    return node.storyBoardEligible;
  }

  return nodeKey === "act_summary" || nodeKey === "performance_node";
}

function summarizeNode(node: DmFlowNode | null) {
  if (!node) {
    return null;
  }

  return {
    mode: node.mode ?? null,
    hasContent: Boolean(node.content || node.content_template),
    hasGuidance: Boolean(
      node.guidance ||
        node.question_goal ||
        node.required_public_points?.length ||
        node.focus_points?.length ||
        node.emotion_prompts?.length ||
        node.summary_guidance?.length
    ),
    forbiddenRevealCount: node.forbidden_reveals?.length ?? 0
  };
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (current, [key, value]) => current.replaceAll(`{{${key}}}`, value),
    template
  );
}

function cleanupGeneratedText(text: string): string {
  return text.trim().replace(/^["“”]+|["“”]+$/g, "").trim();
}

function getRoleName(
  script: Awaited<ReturnType<typeof getScriptForGameSession>>,
  roleId: RoleId
): string {
  return script.roles.find((role) => role.role_id === roleId)?.name ?? roleId;
}

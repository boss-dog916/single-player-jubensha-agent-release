import { boardPromptView } from "@/src/lib/services/storyBoardSettings";
import { roleMemoryPromptView } from "@/src/lib/services/rolePrivateKnowledge";
import type { AiPlayerPublicShareOutput } from "@/src/lib/schemas/aiPlayerPublicShareSchema";
import type { AiPlayerContext } from "@/src/lib/services/gameService";
import type { GameSession } from "@/src/lib/types/game";
import type { LlmMessage } from "@/src/lib/llm/llmTypes";

export function buildShareCheckerPrompt(
  session: GameSession,
  context: AiPlayerContext,
  candidate: AiPlayerPublicShareOutput
): LlmMessage[] {
  return [
    {
      role: "system",
      content:
        "你是剧本杀 AI 轮流分享 Checker。核对本人当前与合法已读历史原文、公共说法和有效限制。must_share 决定本轮应覆盖的重点，may_share 是建议，都不是知识白名单；未分类普通经历有原文依据即可分享。只因明确泄露 must_not_share/历史restrictions、宣告未读未来信息、严重无依据的客观事实、关键流程违规或漏掉必须分享的重点才拒绝，并指出候选原句与原始依据。公共猜测不能覆盖本人记忆；允许有依据且保留不确定的推理。风格、情绪、篇幅或字段化措辞只能给改进建议，不能单独阻止发布。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task:
          "审查 candidate_public_share 是否可以正式写入公开桌面 Message。只有 passed=true 且 safe_to_publish=true 时才允许发布。",
        current_game_session: {
          gameId: session.gameId,
          currentActId: session.currentActId,
          currentPhase: session.currentPhase,
          currentShareIndex: session.currentShareIndex
        },
        allowed_inputs: {
          own_current_act_booklet: {
            role_id: context.role_id,
            act_id: context.act_id,
            private_text: context.private_text,
            must_share: context.must_share,
            may_share: context.may_share,
            must_not_share: context.must_not_share
          },
          own_role_memory: roleMemoryPromptView(context.roleMemory),
          historical_private_knowledge: context.historical_private_knowledge,
          public_story_board: boardPromptView(context.publicStoryBoard, context.publicStoryBoardEnabled),
          recent_public_messages: context.recentPublicMessages
        },
        candidate_public_share: candidate,
        checklist: [
          "是否违反具体 must_not_share 或仍有效的历史restrictions；unclassified不是禁令，may_share不是白名单",
          "是否提前透露后续幕或最终真相",
          "是否编造当前角色不知道的信息",
          "是否解释其他角色未公开动机",
          "是否使用作者 / DM / 旁白 / 全知视角",
          "是否覆盖 must_share",
          "是否符合角色认知和情绪",
          "是否适合真实桌面发言",
          "是否像情感本玩家在分享经历和关系牵动，而不是机械案件报告",
          "是否出现“必须公开的信息”“mustShare”“本幕信息包括”等字段化表达",
          "是否明显诗化、散文化、抽象化，需要改成玩家口语分享"
        ]
      })
    }
  ];
}

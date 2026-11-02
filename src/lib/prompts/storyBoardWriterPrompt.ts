import type { LlmMessage } from "@/src/lib/llm/llmTypes";
import type { GameSession, Message } from "@/src/lib/types/game";

export type StoryBoardWriterPromptInput = {
  session: GameSession;
  latestMessage: Message;
};

export function buildStoryBoardWriterPrompt({
  session,
  latestMessage
}: StoryBoardWriterPromptInput): LlmMessage[] {
  return [
    {
      role: "system",
      content:
        "你是剧本杀公共故事板记录员。你只能记录已经公开给全桌的信息。严禁写入 RoleMemory、私人剧本、private_text、must_share、may_share、must_not_share、后续幕、DM 手册、最终真相、未通过 Checker 的 candidate 发言，或任何未在公开消息中出现的信息。只输出 patch，不输出完整 PublicStoryBoard。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task:
          "只根据 latest_public_message 生成增量公共记忆 patch。不要总结历史，不要输出完整 StoryBoard。所有新增条目的 evidenceMessageId 必须等于 latest_public_message.message_id。没有新增内容的字段返回空数组。公共记忆记录公开发言中的主张，不代表主张已经验证；未验证陈述必须使用“某角色公开称/表示/声称”等归因表达。role_ids_involved/event_tags_added/topic_tags_added 只记录本条消息的公开索引信号。",
        extraction_rules: [
          "对玩家公开发言和 AI 公开发言一视同仁。",
          "如果 latest_public_message 明确说出某人在某时间做了某事，应加入 known_facts_to_add，必要时用“某角色公开称/表示/声称”来避免把未验证主张写成绝对事实。",
          "如果发言包含时间点或顺序，应加入 timeline_events_to_add。",
          "如果发言主要表达歉意、委屈、失落、释怀、共情或关系牵动，应优先加入 emotional_bonds_to_add 或 relationships_to_add，不要硬转成推理疑点。",
          "如果发言留下未说明的内容、目的、对象或结果，可以加入 open_questions_to_add，而不是直接忽略整条消息。",
          "只有纯寒暄、猜测、情绪噪声、重复内容、私密或越界内容才放入 ignored_items。"
        ],
        current_game_session: {
          gameId: session.gameId,
          currentActId: session.currentActId,
          currentPhase: session.currentPhase
        },
        allowed_inputs: {
          latest_public_message: latestMessage
        },
        required_output_shape: {
          known_facts_to_add: [{ text: "string", evidenceMessageId: latestMessage.message_id }],
          timeline_events_to_add: [{ text: "string", evidenceMessageId: latestMessage.message_id }],
          relationships_to_add: [{ text: "string", evidenceMessageId: latestMessage.message_id }],
          open_questions_to_add: [{ text: "string", evidenceMessageId: latestMessage.message_id }],
          contradictions_to_add: [{ text: "string", evidenceMessageId: latestMessage.message_id }],
          emotional_bonds_to_add: [{ text: "string", evidenceMessageId: latestMessage.message_id }],
          discussed_questions_to_add: [{ text: "string", evidenceMessageId: latestMessage.message_id }],
          current_conflicts_to_add: [{ text: "string", evidenceMessageId: latestMessage.message_id }],
          ignored_items: [
            {
              text: "string",
              reason: "string，为什么不应写入故事板，例如推测、重复、私密或不够明确",
              evidenceMessageId: latestMessage.message_id
            }
          ],
          role_ids_involved: "string[]，这条公开消息或新增 patch 中涉及的角色 id",
          event_tags_added: "string[]，这条公开消息或新增 patch 涉及的公开事件标签",
          topic_tags_added: "string[]，这条公开消息或新增 patch 涉及的公开话题标签"
        }
      })
    }
  ];
}

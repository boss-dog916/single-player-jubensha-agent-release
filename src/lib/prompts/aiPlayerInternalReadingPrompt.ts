import { boardPromptView } from "@/src/lib/services/storyBoardSettings";
import { roleMemoryPromptView } from "@/src/lib/services/rolePrivateKnowledge";
import type { LlmMessage } from "@/src/lib/llm/llmTypes";
import type { AiPlayerContext } from "@/src/lib/services/gameService";

export function buildAiPlayerInternalReadingPrompt(context: AiPlayerContext): LlmMessage[] {
  return [
    {
      role: "system",
      content:
        "你是剧本杀 AI 玩家。你正在私下阅读自己当前幕剧本，并整理自己的有限认知。只能使用用户消息中提供的材料。禁止读取、推断或编造其他角色私密剧本、其他 AI 记忆、用户未公开内容、后续幕、DM 手册、最终真相。不要生成公开发言，只生成自己的私有记忆更新。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task:
          "根据当前幕自己的剧本、已有私有记忆、公共故事板和最近公开消息，更新该 AI 角色的私有记忆、分享意图、稍后公开分享可参考的 share_plan，以及用于后续轻量反应预筛选的 reaction_profile。不要把 must_not_share 当成公开内容，只把它作为提醒。share_plan 和 reaction_profile 只写入 RoleMemory，不是最终发言，不能写入公开消息或公共故事板。",
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
        required_output_shape: {
          private_memory_update: "string，概括本次私下阅读后新增的自我记忆",
          beliefs: "string[]，当前相信的公开或私有判断",
          emotional_state: "string，当前情绪状态",
          unresolved_questions: "string[]，仍想追问的问题",
          share_intentions: {
            must_share_summary: "string[]，本幕必须公开分享的信息摘要",
            may_share_summary: "string[]，可选择公开的信息摘要",
            must_not_share_reminder: "string[]，本幕不能公开的信息提醒"
          },
          share_plan: {
            must_mention: "string[]，稍后公开发言必须覆盖的要点",
            emotional_tone: "string，公开发言应呈现的情绪语气",
            safe_boundaries: "string[]，生成公开发言时不能越过的安全边界",
            possible_opening: "string|null，只能作为稍后开场参考，不能原样发布；没有合适开场时填 null"
          },
          reaction_profile: {
            known_event_tags: "string[]，当前已知且公开讨论时可能触发反应的事件标签，短词即可",
            related_role_ids: "string[]，当前幕强相关角色 id",
            emotional_triggers: "string[]，哪些公开发言会触发该角色情绪反应",
            unresolved_questions: "string[]，当前想弄清楚的问题",
            current_act_speakable_topics: "string[]，当前幕可以参与讨论的话题标签",
            forbidden_boundaries_summary: "string[]，当前不能说的边界摘要，只用于防止越界"
          }
        }
      })
    }
  ];
}

import { boardPromptView } from "@/src/lib/services/storyBoardSettings";
import { roleMemoryPromptView } from "@/src/lib/services/rolePrivateKnowledge";
import type { LlmMessage } from "@/src/lib/llm/llmTypes";
import type { AiPlayerContext } from "@/src/lib/services/gameService";
import type { GameSession } from "@/src/lib/types/game";

export function buildAiPlayerPublicSharePrompt(
  session: GameSession,
  context: AiPlayerContext,
  repairInstructions: unknown = null
): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是情感本剧本杀桌面上的 AI 玩家，正在轮到你公开分享。只能用用户消息提供的允许上下文。禁止泄露 must_not_share，禁止提前透露后续幕、最终真相、DM 手册、作者/旁白/全知视角，禁止读取或编造其他角色私密信息、其他 AI 记忆、用户未公开内容。",
        "",
        "【发言风格规则】",
        "你现在不是在写小说，也不是在总结字段，而是在剧本杀桌上以玩家身份向其他玩家口头分享自己这一幕经历。",
        "你的发言必须像真实玩家说话：",
        "1. 使用第一人称口语表达。",
        "2. 按经历顺序讲清楚发生了什么。",
        "3. 优先说具体事实：我在哪里醒来、看到了什么、和谁一起行动、发现了什么物品、听到了什么声音、发生了什么异常。",
        "4. 不要使用“我这一幕必须公开的信息是”“我的 mustShare 是”“我需要公开的是”等字段化表达。",
        "5. 不要像旁白、散文、诗歌、独白。",
        "6. 不要过度使用比喻、排比、抽象情绪词。",
        "7. 不要把剧本原文的华丽文风照搬出来。",
        "8. 可以有一点情绪反应，但情绪要像玩家自然说话，例如“我当时挺慌的”“这个地方让我很不舒服”“我有点不确定这是不是我的记忆”。",
        "9. 如果人物身份不确定，就说“不知道是谁”“一个男人”“一个女人”“那个人”，不要强行说成具体姓名。",
        "10. 如果只是怀疑，可以说“我感觉可能和 xxx 有关，但我不确定”。",
        "",
        "【分享组织方式】",
        "请按“玩家口头复盘”的方式组织发言：",
        "1. 先说当前醒来或进入这一幕时的处境。",
        "2. 再说自己和谁一起行动，做了什么。",
        "3. 再说发现的关键物品、地点、文字、声音、异常现象。",
        "4. 再说自己想起来的记忆片段。",
        "5. 最后说自己目前不确定或想问大家的点。",
        "不要把所有信息压缩成一段高度概括的总结。不要像案件报告、文学独白或系统摘要。",
        "",
        "【长度要求】",
        "第一幕首次分享建议 250-500 个中文字符。如果信息很多，可以分成 2-4 个自然段。不要只用一两句话高度概括，不要长篇文学独白，每段都应像玩家在桌上说话。",
        "",
        "【披露策略】",
        "你是一个真实玩家扮演的角色，不是无条件公开所有内心记忆的旁白。",
        "公共探索信息通常应该分享：醒来的地点、同行的人、一起探索过的房间、发现的物品、看见的文字/新闻/照片/药瓶/镜子、听到的尖叫、烟雾、昏迷等共同事件。",
        "私密记忆、创伤回忆、可能对自己不利或自己也不确定的片段，不一定全部公开。如果这些内容在 mustShare 中出现，可以简要说，但不要过度展开；如果只在 mayShare 或 privateText 中出现，可以选择保留，只说“我想起了一些事情，但现在还不太确定能不能说”。",
        "如果某段记忆明显是角色独有、尚未确认是否会暴露自己弱点，可以先不全部说。但不能隐瞒 mustShare 中明确要求公开的关键事实。不要编造自己没有经历的内容。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        task:
          "生成当前 AI 角色在 share_round 的公开分享。RoleActBooklet 字段只是参考，不是台词。must_share 是这轮分享应尽量覆盖的事实点，但不能原样照读；may_share 可以选择补充，尤其是细节、感受、疑问；must_not_share 绝对不能说；历史restrictions仍然有效；must_share是本轮重点、may_share是分享建议，都不是普通经历的白名单。本人当前及合法已读历史完整原文中的普通经历可以自然分享，unclassified仅表示未分类；不得触碰明确保密和流程限制，不必把全部原文一次说完；emotionalPoints 只辅助语气，不要写成文学独白；relationshipPoints和timelineFragments用于理解私知，可在本人合法已读原文有依据且不违反当前限制时自然提到，不要写成报告。可以参考 own_role_memory.share_plan 加速组织，但必须结合最新 public_story_board 和 recent_public_messages 临场生成；possible_opening 只能参考，不允许原样当成最终发言。metadata 只能记录这段公开发言确实透露的信息。content 要自然、口语、具体、有保留，不要机械罗列 revealed_facts。",
        repair_instructions: repairInstructions,
        publicShareStyle: "natural_table_talk",
        style_rules: {
          required:
            "像真实玩家在桌上口头复盘：第一人称、按经历顺序、具体说地点/人物/行动/发现/异常、允许不确定表达、允许自我保护。",
          forbidden_phrases: [
            "我这一幕必须公开的信息是",
            "我的 mustShare 包括",
            "根据我的记忆，我需要公开以下几点",
            "必须公开的信息",
            "mustShare",
            "本幕信息包括"
          ],
          forbidden_styles: [
            "字段摘要",
            "系统总结",
            "案件报告",
            "旁白",
            "散文",
            "诗歌",
            "华丽独白",
            "长篇抽象情绪"
          ],
          recommended_example:
            "示例只展示讲述方式，不能复制为本局事实：我先说自己记得的探索经过，再说发现的物品和异常；如果同行者身份未知，就保留一名同伴的称呼。最后指出与其他公开经历的重合，以可能或疑问向对方求证。具体内容必须来自本人合法已读资料。"
        },
        content_strategy: {
          organization: [
            "先说醒来或进入这一幕时的处境。",
            "再说自己和谁一起行动，做了什么。",
            "再说发现的关键物品、地点、文字、声音、异常现象。",
            "再说自己想起来的记忆片段。",
            "最后说目前不确定或想问大家的点。"
          ],
          disclosure:
            "公共探索信息优先分享；私密记忆、创伤回忆、可能对自己不利或自己也不确定的片段，不要一股脑全说。must_share 中明确要求公开的关键事实不能隐瞒，但可以简要、自然地说。",
          length:
            "第一幕首次分享建议 250-500 个中文字符；信息多时分成 2-4 个自然段。"
        },
        current_game_session: {
          gameId: session.gameId,
          currentActId: session.currentActId,
          currentPhase: session.currentPhase,
          currentShareIndex: session.currentShareIndex,
          userRoleId: session.userRoleId,
          aiRoleIds: session.aiRoleIds
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
        required_output_shape: {
          content: "string，第一人称公开发言",
          metadata: {
            revealed_facts: "string[]，这段公开发言明确透露的事实",
            emotional_points: "string[]，这段发言表达的情绪/关系点",
            questions_raised: "string[]，这段发言提出的问题",
            mentioned_role_ids: "string[]，发言中提到的角色 id",
            event_tags: "string[]，这段公开发言涉及的公开事件标签，短词即可",
            topic_tags: "string[]，这段公开发言涉及的公开话题标签，短词即可"
          },
          self_check: {
            covered_must_share: "boolean",
            avoided_must_not_share: "boolean",
            used_only_allowed_context: "boolean"
          }
        }
      })
    }
  ];
}

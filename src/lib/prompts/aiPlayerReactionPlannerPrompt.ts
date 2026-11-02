import { disclosureSemantics } from "@/src/lib/services/publicDiscussionContext";
import type { LlmMessage } from "@/src/lib/llm/llmTypes";
import type { CompactReactionContext } from "@/src/lib/orchestration/discussionOrchestrator";

export function buildAiPlayerReactionPlannerPrompt(context: CompactReactionContext): LlmMessage[] {
  return [
    { role: "system", content:
      "你是情感本剧本杀的单角色反应规划器，不生成正式台词。仅使用该角色 compact context 和公开信息，不推断其他角色私密信息、后续幕、DM手册或真相。角色名出现不等于被提问：区分 addressee（真正询问对象）、referenced（被谈论者）、responder（有信息或情绪价值的回应者）。预分析不是命令，歧义由你同时判断，不另调分类器。" },
    { role: "user", content: JSON.stringify({
      task: "输出该角色的 ReactionIntent 和 addressing。角色ID仅用公开名单，role_id必须是当前角色。target_role_ids是本次回复接收者，不是用户问题的directTargets。",
      addressing_rules: "玩家metadata.discussionAddressingMode=reply时，target_role_ids是点击回复明确选择的发言对象；public只表示没有引用回复，仍按原有语义判断点名、群体邀请、引用和相关性，不降低回应优先级、不取消候选角色。公开发言可以明确点名，也可以请大家分别回答；普通陈述仍按原有内容价值决定是否接话。direct明确点名；group群体问题；open无明确对象的问题；none普通陈述。引用不是点名。其他人/除了通常排除所引用者；大家不自动排除引用者。topic用简短话题。例：蝴蝶你记得坠楼吗→direct蝴蝶；蝴蝶说的坠楼其他人记得吗→group，引用并排除蝴蝶；蝴蝶说坠楼，伤寒你知道吗→direct伤寒，引用蝴蝶。",
      reaction_rules: "有具体信息价值时主动发言，不必等真人点名。比较 knowledge 中本人已读经历与对方公开说法的地点、人物特征、物品、行动及先后顺序。memory_connections 是轻量匹配给出的待核实线索，不是身份事实；重要重合、互补或矛盾用 memory_connection/contradiction_with_own_knowledge，relevance>=4，主动向公开发言者求证一个区分性细节。多个共同细节可以怀疑彼此当时同行，但不得直接认定；本人记忆不被公共猜测覆盖。已经核对过、只重复醒来/房间等泛泛内容则不接话。仍考虑直接提问、负面片面描述、强情绪；只被引用不算点名。明确排除自己或点名别人时不抢答。不知道就说明no_known_information，不编造。",
      scoring: "relevance 1无关/2轻微/3弱关联/4有信息或强情绪价值/5明确点名或重大关联；urgency 1不急至5马上；emotional_intensity 1至5。brief_intent为短内部意图，不是台词。reason简短说明依据。",
      disclosure_semantics: disclosureSemantics,
      public_choice_rules: "knowledge.public_choice_context提供正式公开的选项ID和原始文字、规则、历史团队猜测分配和已公布得分。只使用真实选项，不编造纸条。历史分配不是正确答案，允许围绕归属推理、质疑。",
      safety: "mustShare是分享重点、mayShare是建议，普通已读经历不以这两项为白名单；有效restrictions与流程限制优先，不靠提问泄露秘密。本人原文、公共声称与自己的假设分开看。用具体根据和可能/是否表达关联假设，温和交叉验证，不默认对方撒谎，不重复提问；保留有界discussion budget。",
      disclosure: "knowledge.disclosure_preferences 是角色倾向隐瞒的个人经历或内心防御，不是必须主动抖出的信息，也不单独成为硬禁令。保底分享优先其他重要经历；直接追问/证据/压力触及时可选择承认本人有依据的动机。若本人已公开承认，不要又规划为无人知晓，更不要把内部否认、诬陷策略规划成公开台词。有效restrictions和真正阶段秘密始终优先。",
      pacing: "回答现有问题优先，回答之后可以自然结束，不需要再问一个问题。只有新的、具体且重要的关联才主动求证；各自经历不同可能是互补或不同醒来批次，不自动表示矛盾。不要在已经互相确认无法确定后继续追问同一时间线。重复旧经历、重复同伴假设或仅说记忆有偏差都不值得再次争取发言。",
      compact_reaction_context: context
    }) }
  ];
}

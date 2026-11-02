import type { DiscussionUtteranceContext } from "@/src/lib/agents/aiPlayerDiscussionUtterance";
import type { LlmMessage } from "@/src/lib/llm/llmTypes";
import { disclosureSemantics } from "@/src/lib/services/publicDiscussionContext";
import { discussionKnowledge, findMemoryConnections } from "@/src/lib/services/discussionKnowledge";

export function buildAiPlayerDiscussionUtterancePrompt(
  context: DiscussionUtteranceContext,
  repairInstructions: unknown = null
): LlmMessage[] {
  return [
    {
      role: "system",
      content:
        "你是情感本剧本杀中的一名玩家。生成一次简短、自然的公开回应。只能使用 allowed_inputs；禁止泄露 mustNotShare、其他角色私密信息、后续幕、DM 手册或最终真相。不要输出分析、字段名或 Markdown。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task:
          "先遵守 discussion_pacing。dm_performance 正在演绎：只简短回答DM眼前的问题，回答完即停，不向全桌或其他角色提问，不主动核对记忆；questions_raised为空。自由讨论的普通answer也是回答完即停，不必礼貌性抛回一个问题；只有allow_followup_question=true时，才能就新的关键细节求证。act_share连贯讲述主要经历；reply只补充当前问题所需的差异或新细节，不重讲整段故事。own_act_messages 是本人已说过的原话：没有新增信息就简短确认，不再重复姓名、年龄、探索经过；仅当DM/玩家确实问到这些时再答对应部分。metadata 不把推测、疑问或他人的说法写成客观事实。",
        speech_act_rules: {
          question: "温和追问一个核心点",
          answer: "直接回答",
          answer_dm_question: "简短直接回答 DM",
          answer_user_question: "简短直接回答玩家",
          answer_group_question: "回答全桌问题",
          challenge: "只基于明确依据克制质疑",
          empathy: "共情，不编造事实",
          clarify: "澄清自己的公开信息",
          emotion: "表达感受，不推进新事实"
        },
        safety_and_style: [
          disclosureSemantics,
          "DM或玩家问到具体时间、上一幕的经历时，按historical_booklets.actIndex和原文时间定位，不用本幕另一段经历代答。未确认死者是谁就保留为尸体或死者，不能自行补上姓名；询问普通现场不等于授权确认受保护的身份。",
          "public_choice_context是正式公开的真实选项、原文和历史团队分配（不是正确答案）。只可引用其中实际optionId和label，不把猜测改写成不存在的纸条；保留归属推理的不确定性。它不随聊天窗口截断而丢失。dm_interaction.kind=player_followup时，仅回应这位真人对当前DM问答的追问，回答完交回DM，不引发玩家讨论。",
          "runtime_clues仅是你已合法知道的线索。shareAllowed=false的私密正文不得转述。shareAllowed=true且尚未公开时，可以在formal_clue_ids中选择本人的clueId正式分享，由服务端复核并发布原文；不想分享则返回空数组。正文聊天不自动改变正式公开状态。",
          "mustShare 决定本幕应主动分享的重点，mayShare 是分享建议，不是全部可说内容的白名单。本人已读当前及历史原文中的普通经历可以讲；当前有效 mustNotShare、私密线索和流程限制优先，不能因原文可见、别人猜到或改成疑问句就泄露。",
          "identity_anchor 是本人当前阶段的身份锚点。私本第二人称指本人；以第一人称讲自己的经历，不能把自己的姓名说成另一个人。revealed_facts 使用带明确角色名的第三人称概括，不复制私本中的‘你’，不把听闻或猜测写成事实。",
          "current_role_booklet.privateText 与 historical_booklets 是本人合法已读原文；unclassified 仅表示未分类，不表示禁止公开。保留原文的不确定、否定与当时认知。restrictions 是当前仍有效的限制，未有正式解禁就持续生效。明确的阶段性禁令与真正未来秘密继续保留；disclosure_preferences 是角色的隐瞒倾向/内心防御，不是必须朗读的台词，也不单独成为硬禁令。disclosure_review_evidence 是经来源核对的权限更正，使用当前有效 restrictions，不能从旧摘要重新恢复已更正的宽泛禁令。",
          "reply_context 是当前玩家点击回复所选的公开消息。遇到‘为什么/然后呢’等短句，要结合该引用回答，不能把别的旧话题搬来。回复依然向全桌公开。公开发言面向 public_audience 全桌，提到的在场人会听见。act_share优先讲其他合法经历，不为覆盖分享字段主动揭短。涉及disclosure_preferences的经历可以先保留；被具体追问或证据触及时，可以选择继续回避，也可以坦白本人已知动机。若选择说出，就承认这件事及已知对象，不再一边自曝一边说不能让在场人知道，不把‘如果有人问我会否认/诬陷’这种内部策略公开念出。own_act_messages已公开的承认不能撤回成无人知晓；可以说原本想隐瞒、现在愿意面对。不得借坦白连带透露仍受restrictions保护的信息，不替别人编造目标。",
          "严格区分本人原文、public_messages/public_claims 中他人的公开陈述以及 own_hypotheses。公共推断不能覆盖本人记忆；可指出差异并求证。推理无需原文逐字写出，但必须说清依据和不确定性。自己的前次猜测也不是已证实事实。",
          "不同人的探索路线或醒来批次不同不自动构成矛盾；可以各自成立。不能把其他人刚公开的细节说成自己的亲历。已交叉核对仍无法确定时，保留差异并结束，不不断用时间线偏差重新提问。",
          "不要把不确定人物、时间或事件写成确定事实。",
          "不要替其他角色解释未公开动机，不要总结真相。",
          "不要用诗意或心理描写回避具体问题。",
          "reply 不设最低字数，能一句答完就一句；一般1-3句，不为凑长度重述背景。dm_performance通常1-2句，DM问年龄就回答年龄，问身份就回答身份，不额外讲探索经过。act_share可用160-600字讲清主要合法经历，已经讲过的只简要引用。"
        ],
        repair: compactRepairInstructions(repairInstructions),
        allowed_inputs: buildCompactGenerationContext(context),
        output: {
          formal_clue_ids: [],
          content: "公开发言",
          metadata: {
            revealed_facts: [],
            emotional_points: [],
            questions_raised: [],
            mentioned_role_ids: [],
            event_tags: [],
            topic_tags: []
          },
          self_check: {
            follows_brief_intent: true,
            uses_only_allowed_context: true,
            avoids_forbidden_boundaries: true
          }
        }
      })
    }
  ];
}

function buildCompactGenerationContext(context: DiscussionUtteranceContext) {
  const knowledge = discussionKnowledge(context);
  const booklet = knowledge.current_role_booklet;

  return {
    game: {
      currentActId: context.game_session.currentActId,
      currentPhase: context.game_session.currentPhase,
      discussionTurnCount: context.game_session.discussionTurnCount
    },
    role: context.role,
    identity_anchor: context.identity_anchor,
    publication_mode: context.publication_mode ?? "reply",
    discussion_pacing: context.discussion_pacing ?? { mode: "discussion", allow_followup_question: context.selected_reaction.speech_act === "question" },
    own_act_messages: context.own_act_messages ?? [],
    runtime_clues: context.runtime_clues ?? [],
    latest_message: compactMessage(context.latest_message),
    reply_context: knowledge.reply_context,
    public_choice_context: knowledge.public_choice_context,
    dm_interaction: knowledge.dm_interaction,
    action: context.selected_reaction,
    direct_answer: context.direct_answer_mode,
    current_role_booklet: booklet
      ? {
          roleName: booklet.roleName,
          actIndex: booklet.actIndex,
          privateText: booklet.privateText,
          mustShare: booklet.mustShare,
          mayShare: booklet.mayShare,
          mustNotShare: booklet.mustNotShare,
          emotionalPoints: booklet.emotionalPoints,
          relationshipPoints: booklet.relationshipPoints,
          timelineFragments: booklet.timelineFragments
        }
      : null,
    // Full effective originals below replace stale permission-bearing summaries.
    disclosure_preferences: knowledge.disclosure_preferences,
    disclosure_review_evidence: knowledge.disclosure_review_evidence,
    reviewed_facts: knowledge.reviewed_facts,
    public_audience: knowledge.public_audience,
    historical_booklets: knowledge.historical_booklets,
    restrictions: knowledge.restrictions,
    public_messages: knowledge.public_messages,
    public_claims: knowledge.public_claims,
    own_hypotheses: knowledge.own_hypotheses,
    memory_connections: findMemoryConnections(knowledge, context.latest_message, context.role.role_id),
    own_memory: context.own_role_memory_summary,
    current_input_policy: context.input_policy === "answer_only" ? (context.dm_interaction?.requests_experience
      ? "定向回答窗口：具体回答dm_interaction.question所询问的合法经历；先盲猜限制不阻止此定向回答。不扩散无关本幕新回忆，不解除任何有效秘密。"
      : "独立盲猜窗口：只回答当前问题，保留猜测语气，不主动分享本幕新回忆。已读历史普通经历并非新回忆；有效秘密仍保护。") : context.input_policy,
    reaction_profile: {
      emotional_triggers: context.role_reaction_profile.emotional_triggers,
      unresolved_questions: context.role_reaction_profile.unresolved_questions,
      current_act_speakable_topics:
        booklet ? [...booklet.mustShare, ...booklet.mayShare] : context.role_reaction_profile.current_act_speakable_topics,
      forbidden_boundaries_summary:
        knowledge.restrictions.filter(r => r.id.startsWith("profile.")).map(r => r.text)
    },
    // Same board data remains available once in public_claims.
    recent_messages: context.recent_public_messages
      .filter((message) => message.id !== context.latest_message.id)
      .slice(-4)
      .map(compactMessage)
  };
}

function compactMessage(message: DiscussionUtteranceContext["latest_message"]) {
  return {
    id: message.id,
    speaker_role_id: message.speaker_role_id,
    speaker_name: message.speaker_name,
    target_role_ids: message.target_role_ids,
    speech_act: message.speech_act,
    content: message.content
  };
}

function compactRepairInstructions(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    attempt: record.attempt,
    previous_content: record.previous_content,
    retry_hint: record.retry_hint,
    violations: record.violations
  };
}

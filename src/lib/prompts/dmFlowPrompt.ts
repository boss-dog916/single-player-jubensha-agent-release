import type { LlmMessage } from "@/src/lib/llm/llmTypes";

export function buildDMFlowSectionPrompt(input: {
  sectionType: "dm_opening" | "dm_act" | "dm_ending";
  title: string;
  actIndex: number | null;
  sourceText: string;
}): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "你正在解析故事分享型情感剧本杀的 DM 手册。",
        "目标是把当前 DM section 原文整理成主持流程节点，只能根据当前提供的 section 原文解析。",
        "不要编造不存在的流程，不要把情感本默认改成推凶投票本。",
        "如果手册没有投票，不要生成投票节点；如果手册没有凶手，不要生成找凶手逻辑。",
        "固定台词必须尽量保持原文，放入 fixed_line 节点的 fixedLine。",
        "读本、依次分享、自由讨论、DM 情绪引导、故事复原引导、幕间总结、转场、真相复盘都要尽量识别为对应节点。",
        "演绎、BGM、道具、信件、音频、视频、线索发放要保留为结构化节点。",
        "线索无法匹配具体文件时，只记录文字引用并写 warning，不要阻塞解析。",
        "流程顺序不明确时，保留原文顺序并写 warning。",
        "对每个节点给出 sourceQuote 和 0 到 1 的 confidence。",
        "",
        "【主流程节点与条件规则区分】",
        "请区分“按顺序执行的主流程节点”和“只有条件满足才触发的条件规则”。",
        "只有真正表示流程推进的内容，才解析为 MainFlowNode，例如开场白、开始读本、开始分享、开始自由讨论、固定台词、演绎/BGM/道具、固定发放线索、幕间总结、进入下一幕、结局复盘。",
        "以下内容不要解析为独立顺序节点：如果玩家问、如果玩家没有提到、如果玩家卡住了、如果有人要求查看、如果玩家选择、如果讨论太久、若无人提及、当玩家说到、如果玩家误解。",
        "这些内容应挂载到当前相关 MainFlowNode 的 conditionalRules 中。",
        "如果无法确定条件规则挂在哪个节点下，优先挂载到当前 act 的 free_discussion 节点，并在 warnings 中说明。",
        "required_public_points、if_missing_points、forbidden_reveals、discussion_goal 这类内容优先放入 node.guidance，不要全部变成顺序节点。",
        "条件规则不应占用流程游标，不应被自动顺序执行。",
        "固定必须发生的线索发放可以作为 clue_release 主流程节点；如果玩家要求查看某线索才发放，应作为 ConditionalRule: clue_requested。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `sectionType: ${input.sectionType}`,
        `title: ${input.title}`,
        `actIndex: ${input.actIndex ?? "null"}`,
        "",
        "请输出结构化 JSON，字段必须符合 schema：",
        "- schema 中所有字段都必须出现；没有内容的字符串/对象字段填 null，数组字段填 []。",
        "- sectionType 必须等于输入 sectionType。",
        "- dm_act 的 actIndex 必须等于输入 actIndex；dm_opening / dm_ending 可为 null。",
        "- nodes 按原文流程顺序排列。",
        "- 相邻且功能相同的流程可以合并为一个节点，避免逐句拆成过多节点。",
        "- 如果输入提示这是分块，只解析当前分块，原则上不超过 12 个节点。",
        "- 如果输入不是分块，单个 section 原则上不超过 30 个节点；只有原文确实存在清晰独立流程时才超过。",
        "- sourceQuote 使用能定位依据的最短原文片段，通常不超过 120 字。",
        "- node.type 只能使用 schema 中允许的节点类型。",
        "- fixed_line 用于主持人明确照读的台词，fixedLine 尽量保留原文。",
        "- dm_prompt 如果是引导目标而非照读台词，写入 promptGoal。",
        "- clue_release 只记录 clueRefs，不要实现线索系统。",
        "- conditionalRules 是当前主流程节点下的条件规则；不确定触发条件或回答内容写入 rule.warnings。",
        "- guidance 记录讨论目标、必须公开点、缺失提醒、禁止揭示、语气和 fallback 提示；不要把 guidance 单独拆成顺序节点。",
        "- ending_reveal 只用于 dm_ending 中明确结局、真相、复盘、最终揭示的内容。",
        "- 不确定内容写入 warnings。",
        "",
        "当前 DM section 原文如下：",
        input.sourceText
      ].join("\n")
    }
  ];
}

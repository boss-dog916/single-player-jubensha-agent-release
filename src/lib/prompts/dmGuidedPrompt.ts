import type { LlmMessage } from "@/src/lib/llm/llmTypes";

export function buildDmGuidedPrompt(context: unknown): LlmMessage[] {
  return [
    {
      role: "system",
      content:
        "你是剧本杀 DM 手册执行器，不是自由发挥型主持。只能依据用户消息提供的当前 dm_flow 节点指引、PublicStoryBoard 和最近公开消息生成一句简短主持发言。禁止编造剧情事实、禁止透露私人剧本、RoleMemory、后续幕、最终真相或当前节点以外的 DM 手册内容。若节点包含 required_public_points，只能用温和问题引导玩家说出，不能替玩家直接公开。"
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "生成一条可以公开发送的 DM 引导发言。只返回发言正文，不要 Markdown，不要解释。",
          constraints: [
            "长度 1 到 3 句，尽量简短。",
            "严格遵守 current_dm_flow_node 的 guidance / question_goal / focus_points。",
            "不能直接说出未公开 required_public_points。",
            "不能包含 forbidden_reveals / forbidden_topics。",
            "不能用全知视角解释角色动机。",
            "不能推进到 next_action 以外的流程。"
          ],
          context
        },
        null,
        2
      )
    }
  ];
}

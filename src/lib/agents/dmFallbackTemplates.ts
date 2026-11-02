import type { RoleId } from "@/src/lib/script/scriptTypes";

export type DmFallbackTrigger =
  | "game_started"
  | "role_selected"
  | "enter_reading"
  | "enter_share_round"
  | "before_next_share"
  | "all_shares_completed"
  | "enter_free_discussion"
  | "discussion_turn_limit_reached"
  | "enter_dm_question"
  | "enter_act_summary"
  | "advance_to_next_act"
  | "finished";

export type DmFallbackInput = {
  trigger: DmFallbackTrigger;
  roleName?: string | null;
  roleId?: RoleId | null;
};

const FALLBACK_TEMPLATES: Record<DmFallbackTrigger, string> = {
  game_started: "游戏开始。请选择角色，随后你将阅读自己角色当前幕的剧本。",
  role_selected: "角色已选择。接下来进入读本阶段。",
  enter_reading: "现在进入读本阶段。请阅读你的当前幕角色本，也可以先整理稍后想分享的内容。",
  enter_share_round: "大家已经读完本幕内容，现在进入分享阶段。请按照顺序分享本幕你愿意公开的内容。",
  before_next_share: "接下来请 {{roleName}} 分享。",
  all_shares_completed: "本轮分享结束。你可以根据刚才听到的内容，向其他角色提问、回应或表达你的感受。",
  enter_free_discussion: "本轮分享结束。你可以根据刚才听到的内容，向其他角色提问、回应或表达你的感受。",
  discussion_turn_limit_reached: "这一轮讨论先到这里，我们准备进入下一阶段。",
  enter_dm_question: "听完这一轮分享，你现在最想回应谁？",
  enter_act_summary: "这一幕先到这里。我们准备进入下一幕。",
  advance_to_next_act: "接下来将进入下一幕，请继续阅读新的角色本。",
  finished: "故事到此结束，感谢参与。"
};

export function getDmFallbackContent(input: DmFallbackInput): string {
  const roleName = input.roleName ?? input.roleId ?? "下一位角色";

  return FALLBACK_TEMPLATES[input.trigger].replaceAll("{{roleName}}", roleName);
}

import demoScript from "@/data/demo-script.json";
import type { Message, PublicStoryBoard } from "@/src/lib/types/game";
import { createEmptyPublicStoryBoard } from "@/src/lib/services/publicStoryBoardService";

export type Role = {
  role_id: string;
  name: string;
  personality: string;
};

export type Booklet = {
  role_id: string;
  private_text: string;
  must_share: string[];
  may_share: string[];
  must_not_share: string[];
};

export type Act = {
  act_id: string;
  title: string;
  bgm: string;
  share_order: string[];
  dm_flow: string[];
  booklets: Booklet[];
};

export type Script = {
  script_id: string;
  title: string;
  summary: string;
  roles: Role[];
  acts: Act[];
};

export type GamePhase =
  | "role_selection"
  | "reading"
  | "ai_internal_reading"
  | "share_round"
  | "free_discussion"
  | "dm_question"
  | "act_summary"
  | "finished";

export type MockGameView = {
  title: string;
  roles: Role[];
  acts: Act[];
  currentAct: {
    id: string;
    index: number;
    total: number;
    title: string;
    bgm: string;
  };
  currentPhase: {
    id: GamePhase;
    label: string;
  };
  currentShareIndex: number;
  shareOrderRoleIds: string[];
  shareOrder: string[];
  messages: Message[];
  storyBoard: PublicStoryBoard;
};

const phaseLabels: Record<GamePhase, string> = {
  role_selection: "选择角色",
  reading: "阅读当前幕",
  ai_internal_reading: "AI 玩家私下读本",
  share_round: "玩家依次分享",
  free_discussion: "自由追问",
  dm_question: "DM 提问",
  act_summary: "本幕总结",
  finished: "游戏结束"
};

const script = demoScript as Script;

export function getRoleName(roleId: string): string {
  return script.roles.find((role) => role.role_id === roleId)?.name ?? roleId;
}

function buildMessages(): Message[] {
  return [
    {
      message_id: "msg_opening",
      speaker_type: "dm",
      speaker_role_id: "dm",
      speaker_name: "DM",
      phase: "role_selection",
      speech_act: "system",
      content: "欢迎来到本局剧本杀。请先选择你要扮演的角色。",
      metadata: {
        revealed_facts: [],
        emotional_points: [],
        questions_raised: [],
        mentioned_role_ids: [],
        event_tags: [],
        topic_tags: []
      }
    }
  ];
}

export function getMockGameView(): MockGameView {
  const currentAct = script.acts[0];

  return {
    title: script.title,
    roles: script.roles,
    acts: script.acts,
    currentAct: {
      id: currentAct.act_id,
      index: 1,
      total: script.acts.length,
      title: currentAct.title,
      bgm: currentAct.bgm
    },
    currentPhase: {
      id: "role_selection",
      label: phaseLabels.role_selection
    },
    currentShareIndex: 0,
    shareOrderRoleIds: currentAct.share_order,
    shareOrder: currentAct.share_order.map(getRoleName),
    messages: buildMessages(),
    storyBoard: createEmptyPublicStoryBoard()
  };
}

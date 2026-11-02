import demoScript from "@/data/demo-script.json";
import type { Act, Booklet, Role, RoleId, Script } from "@/src/lib/script/scriptTypes";
import type { GamePhase, Message } from "@/src/lib/types/game";

const script = demoScript as Script;

export type UserBookletView = {
  role_id: RoleId;
  act_id: string;
  title: string;
  private_text: string;
};

export function getMockUserBookletView(
  userRoleId: RoleId,
  actId: string
): UserBookletView {
  const act = findAct(actId);
  const booklet = findBooklet(act, userRoleId);

  return {
    role_id: userRoleId,
    act_id: actId,
    title: act.title,
    private_text: booklet.private_text
  };
}

export function mockShare(roleId: RoleId, actId: string, phase: GamePhase = "share_round"): Message {
  const act = findAct(actId);
  const booklet = findBooklet(act, roleId);
  const role = findRole(roleId);

  return {
    message_id: `mock_share_${actId}_${roleId}_${Date.now()}`,
    speaker_type: "ai_player",
    speaker_role_id: roleId,
    speaker_name: role.name,
    phase,
    speech_act: "share",
    content: toFirstPersonShare(booklet.must_share, role.name),
    metadata: {
      revealed_facts: booklet.must_share,
      emotional_points: booklet.may_share,
      questions_raised: extractQuestions(booklet.may_share),
      mentioned_role_ids: [],
      event_tags: extractTags(booklet.must_share),
      topic_tags: extractTags([...booklet.must_share, ...booklet.may_share])
    }
  };
}

export function mockUserShare(
  roleId: RoleId,
  actId: string,
  content: string,
  phase: GamePhase = "share_round"
): Message {
  const act = findAct(actId);
  const booklet = findBooklet(act, roleId);
  const role = findRole(roleId);

  return {
    message_id: `user_share_${actId}_${roleId}_${Date.now()}`,
    speaker_type: "user",
    speaker_role_id: roleId,
    speaker_name: role.name,
    phase,
    speech_act: "share",
    content,
    metadata: {
      revealed_facts: booklet.must_share,
      emotional_points: [],
      questions_raised: [],
      mentioned_role_ids: [],
      event_tags: extractTags(booklet.must_share),
      topic_tags: extractTags(booklet.must_share)
    }
  };
}

function findAct(actId: string): Act {
  const act = script.acts.find((candidate) => candidate.act_id === actId);

  if (!act) {
    throw new Error(`Act "${actId}" was not found in demo script.`);
  }

  return act;
}

function findBooklet(act: Act, roleId: RoleId): Booklet {
  const booklet = act.booklets.find((candidate) => candidate.role_id === roleId);

  if (!booklet) {
    throw new Error(`Booklet for role "${roleId}" was not found in act "${act.act_id}".`);
  }

  return booklet;
}

function findRole(roleId: RoleId): Role {
  const role = script.roles.find((candidate) => candidate.role_id === roleId);

  if (!role) {
    throw new Error(`Role "${roleId}" was not found in demo script.`);
  }

  return role;
}

function toFirstPersonShare(facts: string[], roleName: string): string {
  const selfPronoun = roleName === "乔晚" || roleName === "夏月" ? "她" : "他";

  return facts
    .map((fact) =>
      fact
        .replaceAll(roleName, "我")
        .replaceAll(`${roleName}的`, "我的")
        .replaceAll(`${roleName}在`, "我在")
        .replaceAll(`给${selfPronoun}`, "给我")
        .replaceAll(`${selfPronoun}的`, "我的")
    )
    .join("\n");
}

function extractQuestions(items: string[]): string[] {
  return items.filter((item) => item.includes("？") || item.includes("?"));
}

function extractTags(items: string[]): string[] {
  return Array.from(
    new Set(
      items
        .flatMap((item) => item.split(/[，。；、\s]+/))
        .map((item) => item.trim())
        .filter((item) => item.length >= 2)
        .slice(0, 8)
    )
  );
}

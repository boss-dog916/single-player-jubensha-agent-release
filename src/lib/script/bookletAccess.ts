import { loadScript } from "@/src/lib/script/loadScript";
import type { Act, ActId, Booklet, RoleId } from "@/src/lib/script/scriptTypes";
import { getGameSession } from "@/src/lib/session/mockGameSessions";
import { getGameRuntimeContext } from "@/src/lib/session/mockGameRuntimeContext";
import type { PublicMessage, PublicStoryBoard, RoleMemory } from "@/src/lib/types/game";

export type UserBookletView = {
  role_id: RoleId;
  act_id: ActId;
  title: string;
  private_text: string;
};

export type AiPlayerContext = {
  role_id: RoleId;
  act_id: ActId;
  private_text: string;
  must_share: string[];
  may_share: string[];
  must_not_share: string[];
  roleMemory: RoleMemory;
  publicStoryBoard: PublicStoryBoard;
  recentPublicMessages: PublicMessage[];
};

export function getUserBookletView(gameId: string, actId: ActId): UserBookletView {
  const script = loadScript();
  const session = getGameSession(gameId);

  if (!session.userRoleId) {
    throw new Error(`User role has not been selected for game "${gameId}".`);
  }

  const act = findAct(script.acts, actId);
  const booklet = findBookletInAct(act, session.userRoleId);

  return {
    role_id: booklet.role_id,
    act_id: actId,
    title: act.title,
    private_text: booklet.private_text
  };
}

export function buildAiPlayerContext(
  gameId: string,
  roleId: RoleId,
  actId: ActId
): AiPlayerContext {
  const script = loadScript();
  const session = getGameSession(gameId);
  const runtimeContext = getGameRuntimeContext(gameId);

  if (roleId === session.userRoleId) {
    throw new Error(`Role "${roleId}" is the user role and cannot be read as an AI player.`);
  }

  const booklet = findBooklet(script.acts, actId, roleId);
  const roleMemory = runtimeContext.roleMemories[roleId];

  if (!roleMemory) {
    throw new Error(`RoleMemory not found for AI role "${roleId}" in game "${gameId}".`);
  }

  return {
    role_id: booklet.role_id,
    act_id: actId,
    private_text: booklet.private_text,
    must_share: booklet.must_share,
    may_share: booklet.may_share,
    must_not_share: booklet.must_not_share,
    roleMemory,
    publicStoryBoard: runtimeContext.publicStoryBoard,
    recentPublicMessages: runtimeContext.recentPublicMessages
  };
}

function findBooklet(acts: Act[], actId: ActId, roleId: RoleId): Booklet {
  return findBookletInAct(findAct(acts, actId), roleId);
}

function findAct(acts: Act[], actId: ActId): Act {
  const act = acts.find((candidate) => candidate.act_id === actId);

  if (!act) {
    throw new Error(`Act "${actId}" was not found in script.`);
  }

  return act;
}

function findBookletInAct(act: Act, roleId: RoleId): Booklet {
  const booklet = act.booklets.find((candidate) => candidate.role_id === roleId);

  if (!booklet) {
    throw new Error(`Booklet for role "${roleId}" was not found in act "${act.act_id}".`);
  }

  return booklet;
}

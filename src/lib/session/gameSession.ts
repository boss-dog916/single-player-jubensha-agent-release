import type { RoleId } from "@/src/lib/script/scriptTypes";
export type { GamePhase, GameSession } from "@/src/lib/types/game";

export function getAiRoleIds(allRoleIds: RoleId[], userRoleId: RoleId): RoleId[] {
  return allRoleIds.filter((roleId) => roleId !== userRoleId);
}

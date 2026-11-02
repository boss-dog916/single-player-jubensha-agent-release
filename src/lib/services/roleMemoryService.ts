import type { RoleMemory as PrismaRoleMemory } from "@prisma/client";
import { prisma } from "@/src/lib/db/prisma";
import type { RoleId } from "@/src/lib/script/scriptTypes";
import type { InternalReadingRecord, RoleMemory } from "@/src/lib/types/game";
import { fromJsonValue, toJsonInput } from "@/src/lib/services/jsonFields";

export type UpsertRoleMemoryInput = {
  gameSessionId: string;
  roleId: RoleId;
  memory: RoleMemory;
};

export function createEmptyRoleMemory(): RoleMemory {
  return {
    private_memory_so_far: [],
    beliefs: [],
    emotional_state: "",
    unresolved_questions: [],
    share_intentions: {
      must_share_summary: [],
      may_share_summary: [],
      must_not_share_reminder: []
    },
    share_plan: {
      must_mention: [],
      emotional_tone: "",
      safe_boundaries: [],
      possible_opening: null
    },
    reaction_profile: {
      known_event_tags: [],
      related_role_ids: [],
      emotional_triggers: [],
      unresolved_questions: [],
      current_act_speakable_topics: [],
      forbidden_boundaries_summary: []
    },
    internal_readings: {},
    style_seed: ""
  };
}

export async function initializeRoleMemories(
  gameSessionId: string,
  roleIds: RoleId[]
): Promise<RoleMemory[]> {
  const memories: RoleMemory[] = [];

  for (const roleId of roleIds) {
    memories.push(
      await upsertRoleMemory({
        gameSessionId,
        roleId,
        memory: createEmptyRoleMemory()
      })
    );
  }

  return memories;
}

export async function getRoleMemory(
  gameSessionId: string,
  roleId: RoleId
): Promise<RoleMemory> {
  await assertAiRole(gameSessionId, roleId);

  const record = await prisma.roleMemory.findUnique({
    where: {
      gameSessionId_roleId: {
        gameSessionId,
        roleId
      }
    }
  });

  if (!record) {
    throw new Error(`RoleMemory not found for AI role "${roleId}" in game "${gameSessionId}".`);
  }

  return toRoleMemory(record);
}

export async function upsertRoleMemory({
  gameSessionId,
  roleId,
  memory
}: UpsertRoleMemoryInput): Promise<RoleMemory> {
  await assertAiRole(gameSessionId, roleId);

  const record = await prisma.roleMemory.upsert({
    where: {
      gameSessionId_roleId: {
        gameSessionId,
        roleId
      }
    },
    create: {
      gameSessionId,
      roleId,
      memory: toJsonInput(memory)
    },
    update: {
      memory: toJsonInput(memory)
    }
  });

  return toRoleMemory(record);
}

export async function updateInternalReadingRecord(
  gameSessionId: string,
  roleId: RoleId,
  actId: string,
  record: InternalReadingRecord
): Promise<RoleMemory> {
  const current = await getRoleMemory(gameSessionId, roleId);

  return upsertRoleMemory({
    gameSessionId,
    roleId,
    memory: {
      ...current,
      internal_readings: {
        ...(current.internal_readings ?? {}),
        [actId]: record
      }
    }
  });
}

async function assertAiRole(gameSessionId: string, roleId: RoleId): Promise<void> {
  const session = await prisma.gameSession.findUnique({
    where: { id: gameSessionId }
  });

  if (!session) {
    throw new Error(`GameSession not found for gameSessionId "${gameSessionId}".`);
  }

  const aiRoleIds = fromJsonValue<RoleId[]>(session.aiRoleIds, []);

  if (session.userRoleId === roleId || !aiRoleIds.includes(roleId)) {
    throw new Error(`Role "${roleId}" is not an AI role in game "${gameSessionId}".`);
  }
}

function toRoleMemory(record: PrismaRoleMemory): RoleMemory {
  return {
    ...createEmptyRoleMemory(),
    ...fromJsonValue<RoleMemory>(record.memory, createEmptyRoleMemory())
  };
}

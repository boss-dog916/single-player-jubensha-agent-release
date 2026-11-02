import type { GameRuntimeContext } from "@/src/lib/types/game";

export const mockGameRuntimeContexts: Record<string, GameRuntimeContext> = {
  game_1: {
    roleMemories: {
      role_b: {
        private_memory_so_far: ["沈牧记得自己和乔晚在二楼走廊发生争吵。"],
        beliefs: ["乔晚可能故意约他去仓库试探他。"],
        emotional_state: "防备、愤怒，同时试图保持体面。",
        style_seed: "克制但带有控制欲"
      },
      role_c: {
        private_memory_so_far: ["乔晚记得自己约林安去露台，并看见后门没有关紧。"],
        beliefs: ["夏月可能去过后院，但动机尚不明确。"],
        emotional_state: "紧张、压抑、害怕事情失控。",
        style_seed: "冷静、锋利、谨慎"
      },
      role_d: {
        private_memory_so_far: ["夏月记得自己拿着钥匙去过后门附近。"],
        beliefs: ["林安和乔晚的见面可能隐瞒了重要事情。"],
        emotional_state: "委屈、不安、恐惧。",
        style_seed: "明亮外表下带着颤抖"
      }
    },
    publicStoryBoard: {
      known_facts: [
        "陆青死在后院仓库。",
        "死亡时间初步在昨晚 22:30 到 23:30 之间。"
      ],
      timeline: [
        "22:10 陆青抱着旧灯泡往后院仓库方向走。",
        "22:25 林安收到乔晚信息并去了露台。"
      ],
      relationships: ["林安和夏月是情侣。", "沈牧和乔晚是情侣。"],
      open_questions: ["陆青为何会在深夜进入仓库？", "后门钥匙昨晚被谁使用过？"],
      contradictions: [],
      emotional_bonds: ["夏月对林安和乔晚的关系感到不安。"],
      discussed_questions: [],
      current_conflicts: []
    },
    recentPublicMessages: [
      {
        id: "public_1",
        speakerRoleId: "dm",
        content: "陆青被发现死在后院仓库，所有人需要回忆昨晚行动。"
      },
      {
        id: "public_2",
        speakerRoleId: "role_a",
        content: "林安说自己昨晚去过露台，并听见后院方向有金属落地声。"
      }
    ]
  },
  game_selected_role_a: {
    roleMemories: {
      role_b: {
        private_memory_so_far: ["沈牧记得自己和乔晚在二楼走廊发生争吵。"],
        beliefs: ["乔晚可能故意约他去仓库试探他。"],
        emotional_state: "防备、愤怒，同时试图保持体面。",
        style_seed: "克制但带有控制欲"
      },
      role_c: {
        private_memory_so_far: ["乔晚记得自己约林安去露台，并看见后门没有关紧。"],
        beliefs: ["夏月可能去过后院，但动机尚不明确。"],
        emotional_state: "紧张、压抑、害怕事情失控。",
        style_seed: "冷静、锋利、谨慎"
      },
      role_d: {
        private_memory_so_far: ["夏月记得自己拿着钥匙去过后门附近。"],
        beliefs: ["林安和乔晚的见面可能隐瞒了重要事情。"],
        emotional_state: "委屈、不安、恐惧。",
        style_seed: "明亮外表下带着颤抖"
      }
    },
    publicStoryBoard: {
      known_facts: [],
      timeline: [],
      relationships: [],
      open_questions: [],
      contradictions: [],
      emotional_bonds: [],
      discussed_questions: [],
      current_conflicts: []
    },
    recentPublicMessages: []
  }
};

export function getGameRuntimeContext(gameId: string): GameRuntimeContext {
  const context = mockGameRuntimeContexts[gameId];

  if (!context) {
    throw new Error(`GameRuntimeContext not found for gameId "${gameId}".`);
  }

  return context;
}

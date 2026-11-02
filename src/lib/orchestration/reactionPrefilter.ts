import type { StoryBoardPatch } from "@/src/lib/schemas/storyBoardPatchSchema";
import type { Role, RoleId } from "@/src/lib/script/scriptTypes";
import type { GamePhase, Message, PublicStoryBoard, ReactionProfile } from "@/src/lib/types/game";
import { resolveAddressing, type AddressingResolution } from "./addressingResolution";

export type ReactionCandidate = {
  roleId: RoleId;
  roughScore: number;
  matchedSignals: string[];
};

export type BuildReactionCandidatesInput = {
  latestMessage: Message;
  publicStoryBoard?: PublicStoryBoard;
  latestStoryBoardPatch?: StoryBoardPatch | null;
  aiRoleIds: RoleId[];
  reactionProfiles: Partial<Record<RoleId, ReactionProfile>>;
  userRoleId: RoleId | null;
  currentPhase: GamePhase;
  roles?: Role[];
  addressing?: AddressingResolution;
};

export function buildReactionCandidates({
  latestMessage,
  latestStoryBoardPatch,
  aiRoleIds,
  reactionProfiles,
  roles = [],
  addressing = resolveAddressing(latestMessage.content, roles)
}: BuildReactionCandidatesInput): ReactionCandidate[] {
  const targetRoleIds = latestMessage.speaker_type === "user" ? addressing.directTargets : latestMessage.target_role_ids ?? [];
  const metadata = latestMessage.metadata;
  const textMentionedRoleIds = inferMentionedRoleIdsFromText(latestMessage, roles);

  return aiRoleIds
    .filter((roleId) => roleId !== latestMessage.speaker_role_id)
    .filter((roleId) => !addressing.excludedTargets.includes(roleId))
    .map((roleId) => {
      const profile = reactionProfiles[roleId];
      const matchedSignals: string[] = [];
      let roughScore = 0;
      const isTextMentioned = textMentionedRoleIds.includes(roleId);
      const questionLike = isQuestionLike(latestMessage);
      const isTargeted = targetRoleIds.includes(roleId);
      const isMentioned = metadata.mentioned_role_ids.includes(roleId) || isTextMentioned;
      const isAsked =
        ["question", "challenge", "clarify"].includes(latestMessage.speech_act) ||
        (targetRoleIds.length > 0 && questionLike);
      const negativeSignal = hasNegativeOrPartialSignal(latestMessage);
      const contradictionSignal = hasContradictionSignal(latestMessage);
      const strongEmotionSignal = hasStrongEmotionSignal(latestMessage, profile, roleId);

      if (isTargeted && isAsked) {
        roughScore += 5;
        matchedSignals.push("trigger:direct_question_to_self");
        matchedSignals.push(isTextMentioned ? "原文点名且抛出疑问" : "被点名且被提问");
      }

      if (isMentioned && negativeSignal) {
        roughScore += 4;
        matchedSignals.push("trigger:negative_or_partial_portrayal_of_self");
        matchedSignals.push("被提到且可能受到负面/片面描述");
      } else if (isMentioned && !addressing.referencedRoles.includes(roleId)) {
        roughScore += isTextMentioned ? 2 : 1;
        matchedSignals.push(isTextMentioned ? "公开发言原文提到该角色名" : "公开发言提到该角色");
      }

      if (
        contradictionSignal &&
        (hasOverlap(metadata.event_tags, profile?.known_event_tags ?? []) ||
          hasOverlap(metadata.topic_tags, profile?.current_act_speakable_topics ?? []))
      ) {
        roughScore += 4;
        matchedSignals.push("trigger:contradiction_with_own_knowledge");
        matchedSignals.push("公开信息与角色已知信息可能明显冲突");
      }

      if (strongEmotionSignal) {
        roughScore += 3;
        matchedSignals.push("trigger:strong_emotional_trigger");
        matchedSignals.push("触发强情绪/关系牵动");
      }

      if (hasOverlap(metadata.event_tags, profile?.known_event_tags ?? [])) {
        roughScore += 1;
        matchedSignals.push("事件标签轻微命中角色已知事件");
      }

      if (hasOverlap(metadata.topic_tags, profile?.current_act_speakable_topics ?? [])) {
        roughScore += 1;
        matchedSignals.push("话题标签轻微命中角色可讨论话题");
      }

      if (
        latestMessage.speaker_role_id &&
        latestMessage.speaker_role_id !== "dm" &&
        latestMessage.speaker_role_id !== "system" &&
        (profile?.related_role_ids ?? []).includes(latestMessage.speaker_role_id)
      ) {
        roughScore += 1;
        matchedSignals.push("发言者是该角色相关人物");
      }

      if (isTargeted && hasOverlap(metadata.questions_raised, profile?.unresolved_questions ?? [])) {
        roughScore += 2;
        matchedSignals.push("被问到的问题命中角色未解问题");
      }

      if ((latestStoryBoardPatch?.role_ids_involved ?? []).includes(roleId) && negativeSignal) {
        roughScore += 2;
        matchedSignals.push("故事板 patch 涉及该角色且带负面/片面信号");
      }

      if (
        contradictionSignal &&
        hasOverlap(latestStoryBoardPatch?.event_tags_added ?? [], profile?.known_event_tags ?? [])
      ) {
        roughScore += 2;
        matchedSignals.push("故事板新增事件与角色已知事件存在冲突信号");
      }

      return {
        roleId,
        roughScore,
        matchedSignals
      };
    })
    .filter((candidate) => candidate.roughScore >= 4)
    .sort((left, right) => right.roughScore - left.roughScore)
    .slice(0, 3);
}

function inferMentionedRoleIdsFromText(message: Message, roles: Role[]): RoleId[] {
  const text = collectSignalText(message);

  if (!text.trim()) {
    return [];
  }

  return roles
    .filter((role) => role.role_id !== message.speaker_role_id)
    .filter((role) => roleNameAppearsInText(text, role))
    .map((role) => role.role_id);
}

function roleNameAppearsInText(text: string, role: Role): boolean {
  return [role.role_id, role.name]
    .map((value) => value.trim())
    .filter(Boolean)
    .some((value) => containsRoleAlias(text, value));
}

function containsRoleAlias(text: string, alias: string): boolean {
  if (!alias) {
    return false;
  }

  if (/^[A-Za-z0-9_-]+$/.test(alias)) {
    return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(alias)}($|[^A-Za-z0-9_-])`, "i").test(text);
  }

  return text.includes(alias);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasNegativeOrPartialSignal(message: Message): boolean {
  const text = collectSignalText(message);

  return /怪|怨|骗|瞒|控制|逼|责任|害|错|不是这样|不是你说的|只看到|误会|不公平|辜负|背叛|撒谎|可疑|指责|质疑|负担/.test(text);
}

function hasContradictionSignal(message: Message): boolean {
  const text = collectSignalText(message);

  return /矛盾|不对|对不上|不一样|不是|没有|没收到|没去|时间|地点|记得|否认|不同|冲突|说法|可我|可是|但/.test(text);
}

function hasStrongEmotionSignal(
  message: Message,
  profile: ReactionProfile | undefined,
  roleId: RoleId
): boolean {
  const text = collectSignalText(message);
  const strongEmotion = /难受|委屈|愧疚|心软|失落|可怜|害怕|生气|愤怒|悲伤|不甘心|被抛下|对不起|舍不得|疼|哭/.test(text);
  const triggerHit = hasOverlap([message.content, ...message.metadata.emotional_points], profile?.emotional_triggers ?? []);
  const relatedRoleEmotion =
    (profile?.related_role_ids ?? []).includes(String(message.speaker_role_id)) &&
    message.metadata.emotional_points.length > 0;
  const selfMentionedEmotion =
    message.metadata.mentioned_role_ids.includes(roleId) && message.metadata.emotional_points.length > 0;

  return strongEmotion || triggerHit || relatedRoleEmotion || selfMentionedEmotion;
}

function collectSignalText(message: Message): string {
  return [
    message.content,
    ...message.metadata.revealed_facts,
    ...message.metadata.emotional_points,
    ...message.metadata.questions_raised,
    ...message.metadata.event_tags,
    ...message.metadata.topic_tags
  ].join(" ");
}

function isQuestionLike(message: Message): boolean {
  return (
    message.metadata.questions_raised.length > 0 ||
    message.speech_act === "question" ||
    message.speech_act === "clarify" ||
    message.speech_act === "dm_directed_question" ||
    message.speech_act === "group_question" ||
    /[?？]|吗|呢|有没有|怎么看|觉得|谁|哪位|有人/.test(message.content)
  );
}

export function hasOverlap(left: string[], right: string[]): boolean {
  return left.some((leftItem) =>
    right.some((rightItem) => areRelatedTerms(leftItem, rightItem))
  );
}

function areRelatedTerms(left: string, right: string): boolean {
  const normalizedLeft = normalizeTerm(left);
  const normalizedRight = normalizeTerm(right);

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  );
}

function normalizeTerm(value: string): string {
  return value.trim().toLowerCase();
}

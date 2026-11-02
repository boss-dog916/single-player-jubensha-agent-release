import { loadScript } from "@/src/lib/script/loadScript";
import type { ActId, RoleId, Script } from "@/src/lib/script/scriptTypes";

export type DmOutputSource = "script_fixed" | "script_guided" | "system_fallback";

export type DmFlowNode = {
  id?: string;
  mode?: "fixed" | "guided" | "fallback";
  content?: string;
  content_template?: string;
  guidance?: string;
  question_goal?: string;
  target?: string;
  target_role_id?: RoleId;
  condition?: string;
  trigger?: string;
  bgm?: string;
  required_public_points?: string[];
  focus_points?: string[];
  emotion_prompts?: string[];
  forbidden_topics?: string[];
  if_missing_points?: string[];
  forbidden_reveals?: string[];
  summary_guidance?: string[];
  storyBoardEligible?: boolean;
  [key: string]: unknown;
};

export type DmFlow = string[] | Record<string, unknown>;

export function getDmFlow(scriptId: string, actId: ActId): DmFlow {
  const script = loadScript();

  return getDmFlowFromScript(script, scriptId, actId);
}

export function getDmFlowFromScript(script: Script, scriptId: string, actId: ActId): DmFlow {
  if (script.script_id !== scriptId) {
    throw new Error(`Script "${scriptId}" was not found.`);
  }

  const act = script.acts.find((candidate) => candidate.act_id === actId);

  if (!act) {
    throw new Error(`Act "${actId}" was not found in script "${scriptId}".`);
  }

  return act.dm_flow ?? [];
}

export function getDmFlowNode(
  scriptId: string,
  actId: ActId,
  nodeKey: string
): DmFlowNode | null {
  const dmFlow = getDmFlow(scriptId, actId);

  return getDmFlowNodeFromDmFlow(dmFlow, nodeKey);
}

export function getDmFlowNodeFromScript(
  script: Script,
  scriptId: string,
  actId: ActId,
  nodeKey: string
): DmFlowNode | null {
  return getDmFlowNodeFromDmFlow(getDmFlowFromScript(script, scriptId, actId), nodeKey);
}

function getDmFlowNodeFromDmFlow(dmFlow: DmFlow, nodeKey: string): DmFlowNode | null {

  if (Array.isArray(dmFlow)) {
    return null;
  }

  if (nodeKey === "dm_question") {
    const questions = dmFlow.dm_questions;

    if (Array.isArray(questions)) {
      return normalizeNode(questions.find(isRecord));
    }

    return null;
  }

  if (nodeKey === "performance_node") {
    const performanceNodes = dmFlow.performance_nodes;

    if (Array.isArray(performanceNodes)) {
      return normalizeNode(performanceNodes.find(isRecord));
    }

    return null;
  }

  return normalizeNode(dmFlow[nodeKey]);
}

export function resolveDmNodeSource(node: DmFlowNode | null): DmOutputSource {
  if (!node || node.mode === "fallback") {
    return "system_fallback";
  }

  if (node.mode === "fixed" && hasFixedContent(node)) {
    return "script_fixed";
  }

  if (hasGuidance(node)) {
    return "script_guided";
  }

  return "system_fallback";
}

export function getActLevelForbiddenReveals(scriptId: string, actId: ActId): string[] {
  const dmFlow = getDmFlow(scriptId, actId);

  return getForbiddenRevealsFromDmFlow(dmFlow);
}

export function getActLevelForbiddenRevealsFromScript(
  script: Script,
  scriptId: string,
  actId: ActId
): string[] {
  return getForbiddenRevealsFromDmFlow(getDmFlowFromScript(script, scriptId, actId));
}

function getForbiddenRevealsFromDmFlow(dmFlow: DmFlow): string[] {

  if (Array.isArray(dmFlow)) {
    return [];
  }

  return cleanStringArray(dmFlow.forbidden_reveals);
}

function normalizeNode(value: unknown): DmFlowNode | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    ...value,
    mode: normalizeMode(value.mode),
    content: cleanString(value.content),
    content_template: cleanString(value.content_template),
    guidance: cleanString(value.guidance),
    question_goal: cleanString(value.question_goal),
    target: cleanString(value.target),
    target_role_id: cleanString(value.target_role_id) as RoleId | undefined,
    condition: cleanString(value.condition),
    trigger: cleanString(value.trigger),
    bgm: cleanString(value.bgm),
    required_public_points: cleanStringArray(value.required_public_points),
    focus_points: cleanStringArray(value.focus_points),
    emotion_prompts: cleanStringArray(value.emotion_prompts),
    forbidden_topics: cleanStringArray(value.forbidden_topics),
    if_missing_points: cleanStringArray(value.if_missing_points),
    forbidden_reveals: cleanStringArray(value.forbidden_reveals),
    summary_guidance: cleanStringArray(value.summary_guidance),
    storyBoardEligible:
      typeof value.storyBoardEligible === "boolean" ? value.storyBoardEligible : undefined
  };
}

function hasFixedContent(node: DmFlowNode): boolean {
  return Boolean(node.content?.trim() || node.content_template?.trim());
}

function hasGuidance(node: DmFlowNode): boolean {
  return Boolean(
    node.guidance?.trim() ||
      node.question_goal?.trim() ||
      node.required_public_points?.length ||
      node.focus_points?.length ||
      node.emotion_prompts?.length ||
      node.forbidden_topics?.length ||
      node.if_missing_points?.length ||
      node.summary_guidance?.length ||
      node.target_role_id
  );
}

function normalizeMode(value: unknown): DmFlowNode["mode"] {
  return value === "fixed" || value === "guided" || value === "fallback" ? value : undefined;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

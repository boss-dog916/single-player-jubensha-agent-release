import "server-only";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/src/lib/db/prisma";
import type { DMFlowNode } from "@/src/lib/schemas/dmFlowSchema";
import { MatchingAssignmentSchema } from "@/src/lib/schemas/runtimeChoiceSchema";
import { getScriptRuntimeDefinition } from "./scriptRuntimeDefinitionService";
import type { DMLifecycleScope } from "./dmLifecycleValidation";

export function validateMatchingAssignments(node: DMFlowNode, raw: unknown) {
  const parsed = z.array(MatchingAssignmentSchema).safeParse(raw);
  if (!parsed.success || !node.choice || parsed.data.length !== node.targetRoleNames.length ||
    new Set(parsed.data.map(a => a.roleId)).size !== parsed.data.length ||
    new Set(parsed.data.map(a => a.optionId)).size !== parsed.data.length ||
    parsed.data.some(a => !node.targetRoleNames.includes(a.roleId) || !node.choice!.options.some(o => o.optionId === a.optionId)))
    throw new Error("分配必须完整、一一对应，且只包含当前角色和合法选项。");
  return node.targetRoleNames.map(roleId => parsed.data.find(a => a.roleId === roleId)!);
}
const Hints = z.array(z.object({ round: z.number().int().min(2), text: z.string().trim().min(1).max(500) }).strict());

// Authoring-only API with no HTTP route. Keys are immutable and never part of
// RuntimeDefinition, Cursor, AgentRun inputs/outputs or model contexts.
export async function registerGroupMatchingKey(input: { definitionId: string; choiceId: string;
  assignments: unknown; hints?: { round: number; text: string }[] }) {
  const view = await getScriptRuntimeDefinition(input.definitionId);
  const node = view.definition.dmFlow?.actFlows.flatMap(f => f.nodes)
    .find(n => n.choice?.type === "group_matching" && n.choice.choiceId === input.choiceId);
  if (!node || node.choice?.type !== "group_matching") throw new Error("团队匹配节点不存在。");
  const maxRounds = node.choice.maxRounds;
  let assignments: ReturnType<typeof validateMatchingAssignments>, hints: z.infer<typeof Hints>;
  try {
    assignments = validateMatchingAssignments(node, input.assignments);
    hints = Hints.parse(input.hints ?? []);
    if (new Set(hints.map(h => h.round)).size !== hints.length || hints.some(h => h.round > maxRounds)) throw new Error();
  } catch { throw new Error("服务端团队匹配答案或提示配置无效。"); }
  return prisma.$transaction(async tx => {
    const old = await tx.groupMatchingKey.findUnique({ where: { runtimeDefinitionId_choiceId: { runtimeDefinitionId: view.id, choiceId: input.choiceId } } });
    const assignmentsJson = JSON.stringify(assignments), hintsJson = JSON.stringify(hints);
    if (old) {
      if (old.assignmentsJson === assignmentsJson && old.hintsJson === hintsJson) return { id: old.id };
      throw new Error("已登记答案不可修改，请发布新的定义版本。");
    }
    if (await tx.gameSession.count({ where: { runtimeDefinitionId: view.id } })) throw new Error("已有游戏绑定，不能补写答案。");
    const saved = await tx.groupMatchingKey.create({ data: { runtimeDefinitionId: view.id, choiceId: input.choiceId, assignmentsJson, hintsJson } });
    return { id: saved.id };
  });
}

export async function assertGroupMatchingKeysForScope(definitionId: string, scope: DMLifecycleScope) {
  const view = await getScriptRuntimeDefinition(definitionId);
  const nodes = view.definition.dmFlow?.actFlows.filter(f => f.actIndex >= scope.actRange.start && f.actIndex <= scope.actRange.end)
    .flatMap(f => f.nodes).filter(n => n.choice?.type === "group_matching") ?? [];
  // No queries to the new table for existing games without matching nodes.
  for (const node of nodes) {
    const key = await prisma.groupMatchingKey.findUnique({ where: { runtimeDefinitionId_choiceId: { runtimeDefinitionId: definitionId, choiceId: node.choice!.choiceId } } });
    try {
      if (!key) throw new Error();
      validateMatchingAssignments(node, JSON.parse(key.assignmentsJson));
      Hints.parse(JSON.parse(key.hintsJson));
    } catch { throw new Error("团队匹配缺少有效的服务端答案，不能启动该运行范围。"); }
  }
}

export async function authorizedMatchingHint(definitionId: string, choiceId: string, round: number) {
  if (round === 1) return null;
  const key = await prisma.groupMatchingKey.findUnique({ where: { runtimeDefinitionId_choiceId: { runtimeDefinitionId: definitionId, choiceId } }, select: { hintsJson: true } });
  if (!key) throw new Error("团队匹配服务端配置不可用。");
  return Hints.parse(JSON.parse(key.hintsJson)).find(h => h.round === round)?.text ?? null;
}

export async function scoreMatching(tx: Prisma.TransactionClient, definitionId: string, node: DMFlowNode,
  assignments: ReturnType<typeof validateMatchingAssignments>): Promise<number> {
  const key = await tx.groupMatchingKey.findUnique({ where: { runtimeDefinitionId_choiceId: { runtimeDefinitionId: definitionId, choiceId: node.choice!.choiceId } }, select: { assignmentsJson: true } });
  if (!key) throw new Error("团队匹配服务端配置不可用。");
  let answer: ReturnType<typeof validateMatchingAssignments>;
  try { answer = validateMatchingAssignments(node, JSON.parse(key.assignmentsJson)); }
  catch { throw new Error("团队匹配服务端配置无效。"); }
  return assignments.filter(a => answer.some(correct => correct.roleId === a.roleId && correct.optionId === a.optionId)).length;
}

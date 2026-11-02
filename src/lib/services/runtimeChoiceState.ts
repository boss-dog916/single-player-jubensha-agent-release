import type { DMFlowNode } from "@/src/lib/schemas/dmFlowSchema";
import type { DMFlowCursor, GameSession } from "@/src/lib/types/game";

export function choiceRoleIds(node: DMFlowNode, session: Pick<GameSession, "userRoleId" | "aiRoleIds">) {
  const active = [session.userRoleId, ...session.aiRoleIds].filter((s): s is string => Boolean(s));
  return node.choice?.participants === "human" ? active.filter(r => r === session.userRoleId)
    : node.choice?.participants === "targets" ? active.filter(r => node.targetRoleNames.includes(r)) : active;
}
export function choiceReceipts(cursor: DMFlowCursor, node: DMFlowNode) {
  return (cursor.choiceReceipts ?? []).filter(r => r.choiceId === node.choice?.choiceId && r.nodeId === node.nodeId &&
    r.definitionId === cursor.lifecycle?.definitionId && r.definitionVersion === cursor.lifecycle?.definitionVersion &&
    r.actId === `runtime_act_${node.actIndex}` && node.choice?.options.some(o => o.optionId === r.optionId));
}
export function matchingReceipt(cursor: DMFlowCursor, node: DMFlowNode) {
  const choice = node.choice;
  return choice?.type === "group_matching" ? cursor.groupMatchingReceipts?.find(r => r.choiceId === choice.choiceId && r.round === choice.round &&
    r.nodeId === node.nodeId && r.actId === `runtime_act_${node.actIndex}` && r.definitionId === cursor.lifecycle?.definitionId &&
    r.definitionVersion === cursor.lifecycle?.definitionVersion) : undefined;
}
export function earlierChoiceNode(nodes: DMFlowNode[], current: DMFlowNode, ref: { choiceId: string; round?: number }) {
  return nodes.slice(0, nodes.indexOf(current)).filter(n => n.choice?.choiceId === ref.choiceId &&
    (ref.round === undefined || n.choice.type === "group_matching" && n.choice.round === ref.round)).at(-1);
}
export function choiceComplete(cursor: DMFlowCursor, node: DMFlowNode, session: Pick<GameSession, "userRoleId" | "aiRoleIds">) {
  const roles = choiceRoleIds(node, session);
  if (node.choice?.type === "group_matching") return Boolean(matchingReceipt(cursor, node));
  const receipts = choiceReceipts(cursor, node);
  return roles.length > 0 && roles.every(role => receipts.some(r => r.roleId === role));
}
export function choiceEquals(cursor: DMFlowCursor, node: DMFlowNode, choiceNode: DMFlowNode, session: Pick<GameSession, "userRoleId">) {
  const condition = node.whenChoice!;
  if (!cursor.completedNodeIds.includes(choiceNode.nodeId)) return false;
  if ("correctCount" in condition) {
    const receipt = matchingReceipt(cursor, choiceNode);
    return receipt !== undefined && receipt.resultStatus !== "pending" && receipt.correctCount === condition.correctCount;
  }
  if ("participant" in condition) return choiceReceipts(cursor, choiceNode).some(r => r.roleId === session.userRoleId && r.optionId === condition.optionId);
  if (choiceNode.choice?.type === "group_matching") return matchingReceipt(cursor, choiceNode)?.assignments
    .some(r => r.roleId === condition.roleName && r.optionId === condition.optionId) === true;
  return choiceReceipts(cursor, choiceNode).some(r => r.roleId === condition.roleName && r.optionId === condition.optionId);
}

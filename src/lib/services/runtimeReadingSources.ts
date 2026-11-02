import { z } from "zod";
import type { DMFlowCursor } from "@/src/lib/types/game";
import type { ScriptRuntimeDefinitionJson, RuntimeRoleBooklet } from "./scriptRuntimeDefinitionService";
import { choiceReceipts } from "./runtimeChoiceState";

// Authored metadata shared by a book's PDF and text source. It is not inferred
// from filenames, parsed prose, act numbers or model output.
export const ReadingMetadataSchema = z.object({
  bookKey: z.string().trim().min(1).max(128),
  readingOrder: z.number().int().min(0).max(10000),
  required: z.boolean().optional(),
  pdfOnly: z.literal(true).optional(),
  requiresClueId: z.string().trim().min(1).optional(),
  whenChoice: z.object({ choiceId: z.string().trim().min(1), roleName: z.string().trim().min(1),
    optionId: z.string().trim().min(1) }).strict().optional()
}).strict();
export type ReadingMetadata = Partial<z.infer<typeof ReadingMetadataSchema>>;

export function readingMetadata(json: string | null | undefined, fallback?: string | null): ReadingMetadata {
  const first = json ? JSON.parse(json) ?? {} : {};
  const metadata = first.reading === undefined && fallback ? JSON.parse(fallback) ?? {} : first;
  return metadata.reading === undefined ? {} : ReadingMetadataSchema.parse(metadata.reading);
}

export type ReadingAccess = {
  definition: ScriptRuntimeDefinitionJson; definitionId: string; definitionVersion: number;
  cursor: DMFlowCursor | null; currentActIndex: number; roleName: string; minActIndex?: number; maxActIndex?: number;
};

export function isReadingAuthorized(source: ReadingMetadata & { roleName: string; actIndex: number }, access: ReadingAccess): boolean {
  if (source.roleName !== access.roleName || source.actIndex > access.currentActIndex ||
    source.actIndex < (access.minActIndex ?? 1) || source.actIndex > (access.maxActIndex ?? Infinity)) return false;
  if (source.requiresClueId && (access.cursor?.lifecycle?.definitionId !== access.definitionId || access.cursor.lifecycle.definitionVersion !== access.definitionVersion)) return false;
  if (source.requiresClueId && !access.cursor?.clueGrants?.some(g => {
    const node = access.definition.dmFlow?.actFlows.flatMap(f => f.nodes).find(n => n.nodeId === g.nodeId);
    return g.clueId === source.requiresClueId && g.roleId === access.roleName && g.definitionId === access.definitionId &&
      g.definitionVersion === access.definitionVersion && g.actId === `runtime_act_${source.actIndex}` &&
      node?.clueAction?.action === "grant" && node.clueAction.clueIds.includes(g.clueId) &&
      (access.cursor?.completedNodeIds.includes(g.nodeId) || node.type === "reading_start");
  })) return false;
  if (!source.whenChoice) return true;
  const cursor = access.cursor, condition = source.whenChoice;
  if (cursor?.lifecycle?.definitionId !== access.definitionId || cursor.lifecycle.definitionVersion !== access.definitionVersion) return false;
  const nodes = access.definition.dmFlow?.actFlows.flatMap(f => f.nodes) ?? [];
  const node = nodes.find(n => n.choice?.choiceId === condition.choiceId && n.choice.type !== "group_matching");
  if (!node || !cursor.completedNodeIds.includes(node.nodeId) || !node.actIndex || node.actIndex >= source.actIndex) return false;
  return choiceReceipts(cursor, node).some(r => r.roleId === condition.roleName && r.optionId === condition.optionId);
}

export function authorizedReadingSources(access: ReadingAccess, actIndex?: number) {
  const select = <T extends ReadingMetadata & { roleName: string; actIndex: number }>(sources: T[]) => sources
    .filter(b => (actIndex === undefined || b.actIndex === actIndex) && isReadingAuthorized(b, access))
    .sort((a, b) => a.actIndex - b.actIndex || (a.readingOrder ?? 0) - (b.readingOrder ?? 0) ||
      (a.bookKey ?? "").localeCompare(b.bookKey ?? ""));
  return { booklets: select(access.definition.roleBooklets).map(b => effectiveBooklet(b, access)), displays: select(access.definition.playerDisplay) };
}

export function combineReadingBooklets(booklets: RuntimeRoleBooklet[]): RuntimeRoleBooklet | null {
  if (!booklets.length) return null;
  const arrays = (key: "mustShare" | "mayShare" | "mustNotShare" | "emotionalPoints" | "relationshipPoints" | "timelineFragments") =>
    [...new Set(booklets.flatMap(b => b[key]))];
  return { ...booklets[0], privateText: booklets.map(b => b.privateText).join("\n\n"),
    mustShare: arrays("mustShare"), mayShare: arrays("mayShare"), mustNotShare: arrays("mustNotShare"),
    emotionalPoints: arrays("emotionalPoints"), relationshipPoints: arrays("relationshipPoints"), timelineFragments: arrays("timelineFragments") };
}

// All consumers (current text, history and Checker) use this same effective view.
// The immutable definition and RoleMemory archive are never rewritten.
function effectiveBooklet(booklet: RuntimeRoleBooklet, access: ReadingAccess): RuntimeRoleBooklet {
  const cursor = access.cursor;
  if (!cursor || cursor.lifecycle?.definitionId !== access.definitionId || cursor.lifecycle.definitionVersion !== access.definitionVersion) return booklet;
  const released = (access.definition.dmFlow?.actFlows.flatMap(f => f.nodes) ?? []).filter(n =>
    n.actIndex! <= access.currentActIndex && cursor.completedNodeIds.includes(n.nodeId) &&
    cursor.knowledgeReleaseReceipts?.some(r => r.definitionId === access.definitionId && r.definitionVersion === access.definitionVersion &&
      r.nodeId === n.nodeId && r.actId === `runtime_act_${n.actIndex}`)).flatMap(n => n.knowledgeRelease ?? [])
    .filter(r => r.sourceBookletId === booklet.sourceRoleActBookletId);
  return { ...booklet, mustNotShare: booklet.mustNotShare.filter(t => !released.some(r => r.restriction === t)),
    mayShare: [...new Set([...booklet.mayShare, ...released.flatMap(r => r.allowedFacts)])] };
}

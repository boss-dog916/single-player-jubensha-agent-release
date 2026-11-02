import type { ActivitySourcePack } from "./manualActivitySourcePreparation";
import { activityTextHash } from "./manualActivityValidation";
import { buildSourceSemanticsRequest } from "@/src/lib/prompts/manualSourceSemanticsPrompt";

export const SOURCE_WINDOW_VERSION = "source-semantic-windows-1";
export const WINDOW_OWNERSHIP_INSTRUCTION = "Window ownership: owned blocks may supply facts. Context blocks are for understanding only. Every item and unresolved entry must cite at least one owned block; never extract context-only facts. No cross-window graph or continuation.";
type Block = ActivitySourcePack["blocks"][number];
export type SourceWindowHints = Record<string, { style?: string | null; headingLevel?: number | null }>;
export type SourceSemanticWindow = {
  id: string; version: string; sourceFingerprint: string; fingerprint: string; heading: string | null;
  ownedBlocks: Block[]; contextBefore: Block[]; contextAfter: Block[];
  ownedChars: number; contextChars: number; totalChars: number; oversized: boolean;
};
const chars = (blocks: Block[]) => blocks.map(b => b.text).join("\n").length;
function headingDepth(block: Block, hints: SourceWindowHints) {
  const h = hints[block.id];
  if (h?.headingLevel != null) return h.headingLevel + 1;
  const style = h?.style?.match(/(?:heading|标题)\s*([1-9])/i);
  if (style) return Number(style[1]);
  const ordinal = block.text.match(/^【([^】]+)】/);
  if (ordinal && block.text.length <= 100) return ordinal[1].split("-").length;
  return block.text.length <= 70 && /^(?:第[一二三四五六七八九十百\d]+[幕章节部]|(?:chapter|act|section)\s+[\divx]+\b|#{1,6}\s)/i.test(block.text) ? 1 : null;
}
function advisoryHeading(block: Block) {
  if (block.text.length > 70 || !/^\*\s*【[^】]+】/.test(block.text)) return null;
  return block.text.replace(/^\*\s*【[^】]+】\s*/, "").replace(/\s/g, "");
}

// Source slices only: no semantic-kind inference, branch state, global plan, model or database.
export function sourceSemanticWindows(pack: ActivitySourcePack, options: { targetChars?: number; maxChars?: number; contextBudget?: number; adjacentBlocks?: number; hints?: SourceWindowHints } = {}) {
  const { targetChars = 2000, maxChars = 2500, contextBudget = 800, adjacentBlocks = 2, hints = {} } = options;
  if (targetChars < 500 || maxChars < targetChars || contextBudget < 0 || !Number.isInteger(adjacentBlocks) || adjacentBlocks < 0) throw new Error("Invalid source window budget");
  const blocks = pack.blocks;
  if (!blocks.length || new Set(blocks.map(b => b.id)).size !== blocks.length) throw new Error("Empty/duplicate source blocks");
  const headings = blocks.flatMap((b, i) => headingDepth(b, hints) == null ? [] : [{ index: i, depth: headingDepth(b, hints)! }]);
  const starts = [...new Set([0, ...headings.map(h => h.index)])].sort((a, b) => a - b);
  const sections = starts.map((start, i) => ({ start, end: (starts[i + 1] ?? blocks.length) - 1 }));
  // A title-only parent belongs with its following text, never at the previous window's tail.
  for (let i = sections.length - 2; i >= 0; i--) if (sections[i].start === sections[i].end && headingDepth(blocks[sections[i].start], hints) != null) {
    sections[i + 1].start = sections[i].start; sections.splice(i, 1);
  }
  const ranges: Array<{ start: number; end: number }> = [];
  for (const section of sections) {
    let start = section.start;
    while (start <= section.end) {
      if (chars(blocks.slice(start, section.end + 1)) <= maxChars) { ranges.push({ start, end: section.end }); break; }
      let end = start;
      while (end < section.end && chars(blocks.slice(start, end + 2)) <= targetChars) end++;
      // Avoid cutting a wrapped sentence where possible. Oversized paragraphs remain intact and flagged.
      const safe = Array.from({ length: end - start + 1 }, (_, i) => end - i).find(i =>
        chars(blocks.slice(start, i + 1)) >= targetChars * .65 && /[。！？!?）)」』]$/.test(blocks[i].text));
      end = safe ?? end;
      ranges.push({ start, end }); start = end + 1;
    }
  }
  const advisoryGroups = blocks.flatMap((b, start) => {
    const key = advisoryHeading(b); if (!key) return [];
    let end = start;
    while (end + 1 < blocks.length && headingDepth(blocks[end + 1], hints) == null && !/^\*/.test(blocks[end + 1].text)) end++;
    return [{ key, start, end }];
  });
  return ranges.map(({ start, end }) => {
    const ownedBlocks = blocks.slice(start, end + 1), owned = new Set(ownedBlocks.map(b => b.id));
    const selected = new Set<number>();
    const addGroup = (indices: number[]) => {
      const fresh = indices.filter(i => !owned.has(blocks[i].id) && !selected.has(i));
      if (chars([...selected, ...fresh].sort((a, b) => a - b).map(i => blocks[i])) <= contextBudget) fresh.forEach(i => selected.add(i));
    };
    const ancestors: typeof headings = [];
    for (const h of headings.filter(h => h.index <= start)) {
      while (ancestors.length && ancestors.at(-1)!.depth >= h.depth) ancestors.pop();
      ancestors.push(h);
    }
    addGroup(ancestors.map(h => h.index));
    addGroup(Array.from({ length: Math.min(start, adjacentBlocks) }, (_, i) => start - 1 - i));
    addGroup(Array.from({ length: Math.min(blocks.length - end - 1, adjacentBlocks) }, (_, i) => end + 1 + i));
    // Same literal advisory-list headings can provide distant evidence without owning or merging it.
    const keys = new Set(advisoryGroups.filter(g => g.start >= start && g.start <= end).map(g => g.key));
    for (const g of advisoryGroups.filter(g => keys.has(g.key)).sort((a, b) => Math.abs(a.start - start) - Math.abs(b.start - start))) {
      addGroup(Array.from({ length: g.end - g.start + 1 }, (_, i) => g.start + i));
    }
    const contextBefore = [...selected].filter(i => i < start).sort((a, b) => a - b).map(i => blocks[i]);
    const contextAfter = [...selected].filter(i => i > end).sort((a, b) => a - b).map(i => blocks[i]);
    const ownedChars = chars(ownedBlocks), contextChars = chars([...contextBefore, ...contextAfter]);
    const definition = { version: SOURCE_WINDOW_VERSION, sourceFingerprint: pack.sourceFingerprint, options: { targetChars, maxChars, contextBudget, adjacentBlocks },
      ownedBlocks, contextBefore, contextAfter };
    return { ...definition, id: `source_window_${ownedBlocks[0].id}_${ownedBlocks.at(-1)!.id}`, heading: headings.find(h => h.index >= start && h.index <= end) ? blocks[headings.find(h => h.index >= start && h.index <= end)!.index].text : null,
      fingerprint: activityTextHash(JSON.stringify(definition)), ownedChars, contextChars,
      totalChars: chars([...contextBefore, ...ownedBlocks, ...contextAfter]), oversized: ownedChars > maxChars } satisfies SourceSemanticWindow;
  });
}

export function sourceWindowPack(parent: ActivitySourcePack, window: SourceSemanticWindow): ActivitySourcePack {
  if (window.sourceFingerprint !== parent.sourceFingerprint) throw new Error("Stale source window");
  const ids = new Set([...window.contextBefore, ...window.ownedBlocks, ...window.contextAfter].map(b => b.id));
  const blocks = parent.blocks.filter(b => ids.has(b.id));
  if (blocks.length !== ids.size) throw new Error("Window outside source fence");
  for (const b of [...window.contextBefore, ...window.ownedBlocks, ...window.contextAfter]) if (parent.blocks.find(p => p.id === b.id)?.text !== b.text) throw new Error("Window source changed");
  let text = "";
  const corpusBlocks = blocks.map(b => {
    const original = parent.corpus[0].blocks.find(p => p.id === b.id)!;
    if (text) text += "\n"; const start = text.length; text += b.text;
    return { ...original, start, end: text.length };
  });
  return { ...parent, blocks, corpus: [{ ...parent.corpus[0], text, blocks: corpusBlocks }], normalizedTextHash: activityTextHash(text),
    sourceFingerprint: activityTextHash(`${parent.sourceFingerprint}:${window.fingerprint}`),
    range: `window owned ${window.ownedBlocks[0].id}-${window.ownedBlocks.at(-1)!.id}; context is not owned` };
}

export function buildSourceWindowRequest(parent: ActivitySourcePack, window: SourceSemanticWindow) {
  const source = sourceWindowPack(parent, window), frozen = buildSourceSemanticsRequest(source);
  const owned = new Set(window.ownedBlocks.map(b => b.id)), before = new Set(window.contextBefore.map(b => b.id));
  const user = WINDOW_OWNERSHIP_INSTRUCTION + "\n" + frozen.messages[1].content.replace(/^\[(\S+) main\]/gm, (_, id: string) =>
    `[${id} ${owned.has(id) ? "owned" : before.has(id) ? "context_before" : "context_after"}]`);
  const messages = [frozen.messages[0], { role: "user" as const, content: user }];
  return { ...frozen, transmissionEnabled: false, source, parentSourceFingerprint: parent.sourceFingerprint, window,
    windowVersion: SOURCE_WINDOW_VERSION, messages, promptChars: messages.reduce((n, m) => n + m.content.length, 0),
    estimatedInputTokens: { low: Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4), high: Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 1.5), method: "heuristic only" },
    fingerprint: activityTextHash(JSON.stringify({ sourceFingerprint: parent.sourceFingerprint, windowFingerprint: window.fingerprint, profile: frozen.profile, messages, schemaVersion: frozen.schemaVersion, promptVersion: frozen.promptVersion })) };
}

export function windowOwnershipErrors(data: { items: Array<{ localId: string; sourceBlockIds: string[] }>; unresolved: Array<{ sourceBlockIds: string[] }> }, window: SourceSemanticWindow) {
  const owned = new Set(window.ownedBlocks.map(b => b.id));
  return [...data.items.flatMap(i => i.sourceBlockIds.some(b => owned.has(b)) ? [] : [`CONTEXT_ONLY_ITEM:${i.localId}`]),
    ...data.unresolved.flatMap((u, n) => u.sourceBlockIds.some(b => owned.has(b)) ? [] : [`CONTEXT_ONLY_UNRESOLVED:${n}`])];
}

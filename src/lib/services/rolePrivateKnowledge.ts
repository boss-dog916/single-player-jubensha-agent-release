import type { RuntimeRoleBooklet } from "./scriptRuntimeDefinitionService";
import type { RoleMemory } from "../types/game";

export type PrivateBookletSource = RuntimeRoleBooklet & { actId: string; definitionId: string | null };
export type PrivateMemoryPermission = "mustShare" | "mayShare" | "mustNotShare" | "unclassified";
export type PrivateMemoryQuote = {
  text: string;
  permission: PrivateMemoryPermission;
  source: {
    definitionId: string | null;
    bookletId: string;
    actId: string;
    actIndex: number;
    field: string;
    // Null offsets mean an authored structured annotation, not a verbatim
    // passage. Never invent a location or turn that annotation into a quote.
    start: number | null;
    end: number | null;
  };
};

export type HistoricalPrivateKnowledge = {
  // Authorized, completed readings only. Generator, Planner and Checker share
  // these originals; summary budgets are presentation aids, not permissions.
  original_booklets?: PrivateBookletSource[];
  summary: PrivateMemoryQuote[];
  relevant_original_passages: PrivateMemoryQuote[];
  // Safety rules must survive summary/retrieval budgets. A later act does not
  // automatically revoke an earlier prohibition.
  restrictions: Array<{ actId: string; bookletId: string; mustNotShare: string[] }>;
};

const SUMMARY_CHARS = 4000;
const PASSAGE_CHARS = 2400;

/** A deterministic view over immutable booklets and existing reading receipts.
 * No generated summary, extra memory store, model request or permission inference.
 */
export function buildHistoricalPrivateKnowledge(input: {
  booklets: PrivateBookletSource[];
  roleNames: string[];
  currentActIndex: number;
  memory: RoleMemory;
  query: string;
  passageBudget?: { chars: number; count: number };
}): HistoricalPrivateKnowledge {
  const history = input.booklets.filter(b => input.roleNames.includes(b.roleName) && b.actIndex < input.currentActIndex &&
    hasCompletedPrivateReading(b, input.memory));
  const entries: PrivateMemoryQuote[] = [];
  for (const b of history) {
    for (const field of ["mustShare", "mayShare", "mustNotShare", "relationshipPoints", "timelineFragments", "emotionalPoints"] as const) {
      for (const text of b[field]) {
        const start = b.privateText.indexOf(text);
        entries.push(quote(b, text, field, start < 0 ? null : start, start < 0 ? null : start + text.length,
          field === "mustNotShare" ? field : b.mustNotShare.includes(text) ? "mustNotShare" :
            field === "mustShare" || field === "mayShare" ? field : "unclassified"));
      }
    }
  }
  // Keep complete entries only: cutting a sentence may remove a negation or
  // qualification. Interleave acts so a long first booklet cannot consume all
  // of the bounded summary. The full originals remain in RuntimeDefinition.
  const summary: PrivateMemoryQuote[] = [];
  const perAct = history.map(b => entries.filter(e => e.source.bookletId === b.sourceRoleActBookletId));
  let remaining = SUMMARY_CHARS;
  for (let i = 0; i < Math.max(0, ...perAct.map(items => items.length)); i++) {
    for (const items of perAct) {
      const e = items[i];
      if (e && e.text.length <= remaining && summary.length < 36) { summary.push(e); remaining -= e.text.length; }
    }
  }
  const queryGrams = grams(input.query);
  const ranked = history.flatMap(b => paragraphs(b.privateText).map(p => {
    const overlap = [...grams(p.text)].filter(g => queryGrams.has(g)).length;
    const permission: PrivateMemoryPermission = b.mustNotShare.some(t => p.text.includes(t)) ? "mustNotShare" :
      b.mustShare.includes(p.text) ? "mustShare" : b.mayShare.includes(p.text) ? "mayShare" : "unclassified";
    return { entry: quote(b, p.text, "privateText", p.start, p.end, permission), overlap };
  })).filter(p => p.overlap >= 2).sort((a, b) => b.overlap - a.overlap || b.entry.source.actIndex - a.entry.source.actIndex || a.entry.source.start! - b.entry.source.start!);
  const passages: PrivateMemoryQuote[] = [];
  remaining = input.passageBudget?.chars ?? PASSAGE_CHARS;
  for (const { entry } of ranked) {
    if (passages.length >= (input.passageBudget?.count ?? 3)) break;
    if (entry.text.length <= remaining) { passages.push(entry); remaining -= entry.text.length; }
  }
  return { original_booklets: history, summary, relevant_original_passages: passages,
    restrictions: history.map(b => ({ actId: b.actId, bookletId: b.sourceRoleActBookletId, mustNotShare: b.mustNotShare })) };
}

export function hasCompletedPrivateReading(b: PrivateBookletSource, memory: RoleMemory) {
  const reading = memory.internal_readings?.[b.actId];
  return reading?.status === "completed" && (!reading.sourceReadings ? !b.bookKey :
    reading.sourceReadings.some(r => r.sourceId === b.sourceRoleActBookletId));
}

function quote(b: PrivateBookletSource, text: string, field: string, start: number | null, end: number | null, permission: PrivateMemoryPermission): PrivateMemoryQuote {
  return { text, permission, source: { definitionId: b.definitionId, bookletId: b.sourceRoleActBookletId,
    actId: b.actId, actIndex: b.actIndex, field, start, end } };
}

function paragraphs(text: string) {
  return [...text.matchAll(/[^\r\n]+/g)].map(m => {
    const start = m.index! + m[0].indexOf(m[0].trim());
    return { text: m[0].trim(), start, end: start + m[0].trim().length };
  }).filter(p => p.text);
}

function grams(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).flatMap(word =>
    word.length < 2 ? [] : Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))));
}

/** Do not serialize the accumulated full-text archive into model requests. */
export function roleMemoryPromptView(memory: RoleMemory) {
  return { beliefs: memory.beliefs.slice(-5), emotional_state: memory.emotional_state,
    unresolved_questions: (memory.unresolved_questions ?? []).slice(-5),
    share_intentions: memory.share_intentions, share_plan: memory.share_plan, reaction_profile: memory.reaction_profile };
}

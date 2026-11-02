import type { ActivityEvidence } from "@/src/lib/schemas/manualActivityIRSchema";
import { activitySourceEvidence, type ActivitySourcePack } from "./manualActivitySourcePreparation";

// Only an explicit leading region header is hydrated. No search for inferred song names in prose.
export function hydrateRegionMediaHeader(pack: ActivitySourcePack, blockId: string): { label: string; evidence: ActivityEvidence } | null {
  const source = activitySourceEvidence(pack, blockId);
  const match = source.sourceQuote.match(/^(?:本(?:趴|段|场)\s*)?BGM\s*[:：]?\s*《([^》\n]+)》/);
  if (!match) return null;
  const start = source.sourceQuote.indexOf(match[1]);
  return { label: match[1], evidence: { ...source, sourceQuote: match[1], sourceSpan: { start: source.sourceSpan.start + start, end: source.sourceSpan.start + start + match[1].length } } };
}

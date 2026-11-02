import type { ManualActivityIR, ActivityContent } from "@/src/lib/schemas/manualActivityIRSchema";
import type { ProjectedActivityPlan } from "./manualActivityProjection";
import { activityDisplayContentRefs, contentClosure } from "./manualActivityValidation";
import type { AssemblyIssue } from "@/src/lib/schemas/manualAssemblyCoordinationSchema";

// Independent oracle accepts any reference graph. It never fills the candidate using reference answers.
export function auditProjectedEquivalence(candidate: ManualActivityIR, plan: ProjectedActivityPlan, reference: ManualActivityIR, referencePlan: ProjectedActivityPlan) {
  const issues: AssemblyIssue[] = [];
  const add = (key: string, content?: ActivityContent) => issues.push({ id: `equivalence:${key}`, kind: "source_layout_ambiguity", sourceRefs: [], relatedSemanticItemIds: [],
    reason: key + (content ? `; evidence ${JSON.stringify(content.sourceEvidence.map(e => e.locator))}` : ""), requiredResolution: "Review missing source facts; do not copy a reference answer graph or relax the gate", severity: "assembly_blocker" });
  const phases = (ir: ManualActivityIR, p: ProjectedActivityPlan) => p.phases.map(ph => ({ label: ph.sourceLabel, type: ph.phaseType, act: ph.actNumber,
    reads: ph.activities.filter(a => a.kind === "READ" && a.activation === "sequence").map(a => a.kind === "READ" ? [a.payload.readingMode, a.audience.kind] : []),
    transitions: ph.activities.filter(a => a.kind === "TRANSITION").map(a => a.kind === "TRANSITION" ? ir.phases.find(p => p.id === a.payload.targetPhaseRef)?.sourceLabel ?? null : null) }));
  if (JSON.stringify(phases(candidate, plan)) !== JSON.stringify(phases(reference, referencePlan))) add("PHASE_READ_TRANSITION_MISMATCH");
  const scripts = (ir: ManualActivityIR, p: ProjectedActivityPlan) => p.phases.flatMap(ph => ph.activities.filter(a => a.activation === "sequence").flatMap(a => contentClosure(ir, activityDisplayContentRefs(a)).filter(c => c.kind === "performance")));
  const expected = scripts(reference, referencePlan), actual = scripts(candidate, plan);
  const mediaTexts = (ir: ManualActivityIR, scripts: ActivityContent[]) => scripts.flatMap(c => c.kind === "performance" ? c.script.beats.flatMap(b => b.cues.filter(c => c.kind === "Media").flatMap(c =>
    c.kind === "Media" ? ir.content.filter(t => t.id === c.mediaRef && t.kind === "text") : [])) : []);
  const actualMedia = mediaTexts(candidate, actual);
  for (const c of mediaTexts(reference, expected)) if (c.kind === "text" && !actualMedia.some(t => t.kind === "text" && (t.text.includes(c.text) || c.text.includes(t.text)))) add(`MISSING_MEDIA:${c.text}`, c);
  // A reference utterance may vary; FIXED source text and known speaker cannot vary.
  for (const c of expected) if (c.kind === "performance") for (const beat of c.script.beats) for (const cue of beat.cues) {
    if (cue.kind !== "Spoken" || cue.fidelity !== "fixed") continue;
    const t = reference.content.find(t => t.id === cue.textRef), performer = reference.actors.find(a => a.id === cue.performerRef)?.label;
    if (t?.kind !== "text") continue; // Missing external attachment is a runtime dependency, not invented fixed text.
    // The old test helper trims excerpt endpoints; this comparison removes ONLY endpoint whitespace.
    // Hydration itself keeps original bytes and punctuation, enforced separately by the strict validator.
    if (!actual.some(c => c.kind === "performance" && c.script.beats.some(b => b.cues.some(s => s.kind === "Spoken" && s.fidelity === "fixed" && candidate.actors.find(a => a.id === s.performerRef)?.label === performer && candidate.content.some(v => v.id === s.textRef && v.kind === "text" && v.text.trim() === t.text.trim()))))) add(`MISSING_FIXED_SPEECH:${performer}:${t.text.slice(0, 40)}`, t);
  }
  return { status: issues.length ? "INCOMPLETE" as const : "PASS" as const, issues,
    scope: "ID-free source-grounded phase/read/transition, required media coverage and fixed speech; additional behavioral tests remain mandatory" };
}

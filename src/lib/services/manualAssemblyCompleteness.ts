import type { ManualSourceSemantics } from "@/src/lib/schemas/manualSourceSemanticsSchema";
import type { AssemblyResult } from "./manualActivityAssembly";
import { hydrateSpokenSource } from "./manualSourceSemanticAssembler";
import { validateManualActivityIR } from "./manualActivityValidation";
import type { ActivitySourcePack } from "./manualActivitySourcePreparation";

// Completeness is a separate negative-proof layer; the semantic validator alone accepts partial graphs.
export function assessAssemblyCompleteness(result: AssemblyResult, source: ManualSourceSemantics, pack: ActivitySourcePack) {
  const ir = result.candidate, failures: string[] = [], activities = ir.phases.flatMap(p => p.activities);
  if (validateManualActivityIR(ir, pack.corpus).errors.length) failures.push("STRICT_VALIDATION");
  if (result.issues.some(i => i.severity === "assembly_blocker")) failures.push("UNRESOLVED_RELATIONS");
  for (const s of source.items) {
    if (s.semanticKind === "spoken_content") {
      const hydrated = hydrateSpokenSource(s, pack);
      if (hydrated.issues.length || hydrated.units.some(unit => !ir.content.some(c => c.kind === "text" && c.text === unit.text && c.sourceEvidence.some(e => e.documentId === unit.evidence.documentId && e.sourceSpan.start === unit.evidence.sourceSpan.start && e.sourceSpan.end === unit.evidence.sourceSpan.end)))) failures.push(`SPOKEN_TEMPLATE:${s.localId}`);
      const scripts = activities.filter(a => result.contributions[s.localId]?.includes(a.id) && (a.kind === "PERFORM" || a.kind === "DM_INTERVENE")).flatMap(a =>
        a.kind === "PERFORM" || a.kind === "DM_INTERVENE" ? ir.content.filter(c => c.id === a.payload.scriptRef && c.kind === "performance") : []);
      if (hydrated.units.some(unit => !scripts.some(c => c.kind === "performance" && c.script.beats.some(b => b.cues.some(cue => cue.kind === "Spoken" && cue.fidelity === s.payload.fidelityHint &&
        ir.actors.find(a => a.id === cue.performerRef)?.label === s.payload.speakerHint && ir.content.some(t => t.id === cue.textRef && t.kind === "text" && t.text === unit.text && t.sourceEvidence.some(e => e.documentId === unit.evidence.documentId && e.sourceSpan.start === unit.evidence.sourceSpan.start && e.sourceSpan.end === unit.evidence.sourceSpan.end))))))) failures.push(`SPOKEN_EXECUTION:${s.localId}`);
    }
    if (["spoken_content", "stage_action", "media_cue"].includes(s.semanticKind) && !(result.contributions[s.localId] ?? []).some(ref => activities.some(a => a.id === ref && ["PERFORM", "DM_INTERVENE"].includes(a.kind)))) failures.push(`UNGROUPED_CUE:${s.localId}`);
    if (s.semanticKind === "conditional_guidance" && !result.triggers.some(t => t.sourceItemId === s.localId && ir.policies.conditional.some(p => p.id === t.policyRef))) failures.push(`TRIGGER:${s.localId}`);
    if (s.semanticKind === "required_information" && !(result.contributions[s.localId] ?? []).some(ref => ir.policies.requiredPoints.some(p => p.id === ref))) failures.push(`POINT:${s.localId}`);
    if (s.semanticKind === "runtime_choice") {
      const choice = activities.find(a => a.kind === "PLAYER_CHOICE" && result.contributions[s.localId]?.includes(a.id));
      if (choice?.kind !== "PLAYER_CHOICE" || choice.payload.optionsSource.kind !== "resources") { failures.push(`CHOICE:${s.localId}`); continue; }
      if (choice.payload.quota !== s.payload.quotaHint || choice.payload.outcomeRefs.length !== s.payload.optionLabels.length) failures.push(`CHOICE_MENU:${s.localId}`);
      for (const outcome of choice.payload.outcomeRefs) {
        const kinds = outcome.activityRefs.map(ref => activities.find(a => a.id === ref)?.kind);
        if (JSON.stringify(kinds) !== JSON.stringify(["RESOURCE_ACTION", "READ", "PERFORM", "PERFORM"])) failures.push(`DISPATCH_CHAIN:${outcome.optionRef}`);
        const read = activities.find(a => a.id === outcome.activityRefs[1]);
        if (read?.kind !== "READ" || read.payload.readingMode !== "public_read_aloud" || read.payload.readerSelector.kind !== "choice_reader" || read.payload.readerSelector.choiceRef !== choice.id) failures.push(`ARCHIVE_READER:${outcome.optionRef}`);
        const binding = result.dispatch.find(d => d.resourceRef === outcome.optionRef);
        if (!binding || binding.commentaryRef !== outcome.activityRefs[2] || binding.soloRef !== outcome.activityRefs[3] || binding.segmentAssets.commentary === binding.segmentAssets.solo) failures.push(`PERFORMER_RELATION:${outcome.optionRef}`);
      }
    }
  }
  return { status: failures.length ? "incomplete" as const : "complete" as const, failures,
    scope: "All frozen Source GT facts and supplied human-coordinated relations; not whole-book extraction recall or production runtime readiness" };
}

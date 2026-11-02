import { SOURCE_SEMANTICS_SYSTEM } from "./manualSourceSemanticsPrompt";

export const SOURCE_SEMANTICS_PROMPT_V2_VERSION = "manual-source-semantics-prompt-2";

// This experimental prompt is not wired into the production extractor.
export const SOURCE_SEMANTICS_V2_REPLACEMENTS = {
  2: "Named kinds may share evidence. Numbered sections are not acts. Current-act flow/start headings mean phase_marker enter; document sections chapter, phase mentions reference. Hints need evidence: positive actNumberHint or null; 第0幕 prologue/null. No unseen future acts.",
  4: "reading_instruction needs actual booklet/archive reading, stated or presupposed by 'after reading', not an imperative. Reading BGM/cues alone mean media_cue, NOT READ. Reading + music/discussion needs separate items; free discussion is not ordered sharing. Prefer activities, conditional behavior, required info and disclosure over guidance (advice/experience/optional pacing/style), without omitting other facts. Key/important/advice/cue-if-missed is soft/optional, not hard; hard needs explicit must/mandatory/blocked progression. Missing clue -> soft required_information + conditional_guidance(question). Preserve IF/THEN, not a hard main activity; '?' alone is not waiting.",
  5: "Separate speech/stage/media/advice; ONE speaker/persona per item. Source-mandated wording is fixed; flexible suggested speech reference: split adjacent units. Host prompts/questions use host_question, explanations host_explain, not performance by section alone. Multi-block fixed speech: all literal sourceBlockIds, speakerHint/personaHint, fidelityHint=fixed; omit excerpt/boundaries for full-block hydration. No range aliases, fake merged excerpts or one excerpt posing as a whole monologue. Short selection: ONE block, unique verbatim excerpt OR boundaries, never both. Mixed PDF pages need safe selection or unresolved.",
  9: "No fabricated facts. Each payload fact, including identity details, needs declared literal sourceBlockIds: cite all needed blocks or narrow the claim. IDs must exist in input. PDF diagrams/colors cannot prove casting/fixedness; archive_cross_reference supports only explicit archive facts. Ambiguous phase/fidelity/selection/evidence or unsupported enums -> unresolved. Omit unknown optional fields."
} as const;

export const SOURCE_SEMANTICS_V2_FEW_SHOTS = [
  "Read files + music -> reading_instruction(public_archive) + media_cue(play).",
  "After reading booklets, talk freely -> reading_instruction(private_booklet) + discussion_instruction(free).",
  "Key clue; ask if missed -> required_information(soft) + conditional_guidance(question).",
  "Section 3 / Act 1 flow -> phase_marker(chapter,unknown,null) / phase_marker(enter,act,1).",
  "Fixed Hello / Suggested Who are you? -> spoken_content(fixed,host_explain) / spoken_content(reference,host_question).",
  "Fixed speech blocks A,B -> sourceBlockIds=[A,B], fixed, omit excerpt/boundaries.",
  "Unclear mixed voices -> unresolved."
] as const;

const paragraphs = SOURCE_SEMANTICS_SYSTEM.split("\n");
if (paragraphs.length !== 10) throw new Error("Prompt v1 paragraph layout changed; review v2 delta");
export const SOURCE_SEMANTICS_V2_SYSTEM = paragraphs.map((line, index) =>
  SOURCE_SEMANTICS_V2_REPLACEMENTS[index as keyof typeof SOURCE_SEMANTICS_V2_REPLACEMENTS] ?? line).join("\n") +
  "\nGeneric sketches, NOT source/full JSON; required fields follow grammar:\n" + SOURCE_SEMANTICS_V2_FEW_SHOTS.join("\n");

export function sourceSemanticsV2Messages<T extends { role: string; content: string }>(messages: T[]) {
  if (messages.length !== 2 || messages[0].role !== "system" || messages[1].role !== "user" || messages[0].content !== SOURCE_SEMANTICS_SYSTEM) {
    throw new Error("Only frozen v1 messages may be upgraded");
  }
  return messages.map((message, index) => ({ ...message, content: index === 0 ? SOURCE_SEMANTICS_V2_SYSTEM : message.content }));
}

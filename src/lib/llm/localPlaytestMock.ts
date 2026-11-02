import "server-only";
import { createMockLlmClient } from "./mockLlmClient";
import type { GenerateStructuredInput, LlmClient } from "./llmTypes";

// Only selected by the original browser fixture's Mock-only manifest. This is a
// model stub at the existing client boundary, not fixture dialogue or an agent.
// It reads only the already-scoped request, never a definition or answer table.
export function createOriginalBrowserMockClient(): LlmClient {
  const mock = createMockLlmClient();
  return { ...mock, generateStructured: input => mock.generateStructured(originalBrowserMockInput(input)) };
}
export function originalBrowserMockInput<T>(input: GenerateStructuredInput<T>): GenerateStructuredInput<T> {
  const message = input.messages?.find(m => m.role === "user");
  if (!message) return input;
  let context;
  try { context = JSON.parse(message.content); } catch { return input; }
  if (input.agentType === "ai_player_runtime_choice") {
    const optionId = context.choice?.options?.[0]?.optionId;
    if (typeof optionId === "string") return { ...input, mockOutput: { optionId } };
  }
  if (input.agentType === "ai_player_discussion_utterance") {
    const allowed = context.allowed_inputs;
    if (allowed?.role?.role_id !== input.roleId) return input;
    if (allowed.current_input_policy) return { ...input, mockOutput: { content: "我暂时不能确定，先保留自己的判断。", formal_clue_ids: [],
      metadata: { revealed_facts: [], emotional_points: [], questions_raised: [], mentioned_role_ids: [], event_tags: [], topic_tags: [] },
      self_check: { follows_brief_intent: true, uses_only_allowed_context: true, avoids_forbidden_boundaries: true } } };
    const booklet = allowed?.current_role_booklet;
    const permitted = [...(booklet?.mustShare ?? []), ...(booklet?.mayShare ?? [])].filter((value: string) =>
      value.trim() && !(booklet?.mustNotShare ?? []).some((secret: string) => secret.trim() && (value.includes(secret) || secret.includes(value))));
    // Reviewed permissions can span several paragraphs. A Mock reply must
    // still fit the real reply contract: choose a complete source sentence,
    // never cut a negation/condition halfway or copy an entire long paragraph.
    const fact = permitted.flatMap((value: string) => value.length <= 170 ? [value] : value.match(/[^。！？!?]+[。！？!?]/g) ?? [])
      .find((value: string) => value.trim() && value.length <= 170);
    const matching = /纸条|暂定分工|词条/.test(allowed?.latest_message?.content ?? "");
    return { ...input, mockOutput: { content: fact ? fact + (matching
      ? "我建议先对照每个人实际观察过的事，再分配纸条；这是我的意见，最终由大家确认。" : "这是我本幕能够确认的见闻，愿意和大家一起核对。") : "我暂时有些困惑，想先听听大家的看法。",
      formal_clue_ids: (allowed.runtime_clues ?? []).filter((c: {visibility: string; granted: boolean; shareAllowed: boolean; publiclyShared: boolean}) =>
        c.visibility === "private" && c.granted && c.shareAllowed && !c.publiclyShared).map((c: {clueId: string}) => c.clueId),
      metadata: { revealed_facts: fact ? [fact] : [], emotional_points: [], questions_raised: [], mentioned_role_ids: [], event_tags: [], topic_tags: [] },
      self_check: { follows_brief_intent: true, uses_only_allowed_context: true, avoids_forbidden_boundaries: true } } };
  }
  return input;
}

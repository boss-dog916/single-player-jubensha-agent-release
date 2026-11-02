import type { Message } from "@/src/lib/types/game";

// Reporting wrappers only; preserve negation, uncertainty, numbers and conditions.
export function publicFactKey(text: string): string {
  let value = text.trim();
  const report = value.match(/^(.{1,24}?)(?:公开表示[：:]?|公开称|表示[：:]?)([\s\S]*)$/);
  if (report) {
    const [, speaker] = report;
    let body = report[2];
    if (body.startsWith(speaker)) body = body.slice(speaker.length);
    body = body.replace(/^(?:我)?(?:现在)?(?:可以)?确认/, "");
    value = `${speaker}:${body}`;
  }
  return value.replace(/[\s，。；：,:;“”"']/g, "");
}
export function uniquePublicFacts(facts: string[]): string[] {
  const seen = new Set<string>();
  return facts.filter(fact => { const key = publicFactKey(fact); if (seen.has(key)) return false; seen.add(key); return true; });
}
export function presentPublicFacts(facts: string[], messages: Message[]) {
  const lowValue = new Set<string>();
  for (const message of messages) {
    const question = messages.find(m => m.message_id === message.reply_to_message_id);
    if (message.speaker_type !== "ai_player" || question?.metadata.sourceNodeType !== "performance_instruction") continue;
    for (const fact of message.metadata.revealed_facts) {
      if (/没有.{0,8}印象|不记得|不知道|不清楚|没法回答/.test(fact)) {
        lowValue.add(publicFactKey(fact));
        lowValue.add(publicFactKey(`${message.speaker_name}公开表示：${fact}`));
      }
    }
  }
  // Read-only repair for historical boards: resolve an exact metadata claim
  // to its public source message. Never rewrite words inside arbitrary prose.
  const attributed = facts.map(fact => {
    const source = messages.find(m => m.speaker_type === "ai_player" && m.metadata.revealed_facts.some(f =>
      /[我你]/.test(f) && (fact === f || fact === `${m.speaker_name}公开表示：${f}`)));
    return source ? `${source.speaker_name ?? source.speaker_role_id}公开表示：“${source.content}”` : fact;
  });
  const unique = uniquePublicFacts(attributed);
  return { facts: unique.filter(f => !lowValue.has(publicFactKey(f))),
    otherResponses: unique.filter(f => lowValue.has(publicFactKey(f))) };
}

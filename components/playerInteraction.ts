export function quotePreview(text: string, limit = 120) {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  const head = Math.floor((limit - 3) * .68), tail = limit - 3 - head;
  return `${chars.slice(0, head).join("")} … ${chars.slice(-tail).join("")}`;
}

export type ShareSendMode = "auto" | "share" | "discussion";
export function chatSubmissionType(input: { canShare: boolean; replyToMessageId?: string | null; content: string; mode?: ShareSendMode }) {
  if (!input.canShare || input.replyToMessageId) return "USER_DISCUSSION" as const;
  if (input.mode === "share") return "USER_SHARE" as const;
  if (input.mode === "discussion") return "USER_DISCUSSION" as const;
  const question = /[?？]|(?:吗|么|呢)[。！!\s]*$|请问|问一下|问问|想问|有没有|怎么看|能否|可否|是不是|是否|为什么|怎么|什么|哪里|哪儿|谁|哪位|在哪|多少|几点|你们觉得|大家觉得/.test(input.content);
  return question ? "USER_DISCUSSION" as const : "USER_SHARE" as const;
}

export function chatEnterAction(event: { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean;
  repeat?: boolean; isComposing?: boolean; keyCode?: number }, composing: boolean, text: string, sending: boolean) {
  if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || composing || event.isComposing || event.keyCode === 229) return "edit";
  return !event.repeat && text.trim() && !sending ? "send" : "ignore";
}

export type FloatingPosition = { x: number; y: number };
export function clampFloatingPosition(position: FloatingPosition, viewport: { width: number; height: number }, size = { width: 112, height: 48 }) {
  const maxX = Math.max(0, viewport.width - size.width - 8), maxY = Math.max(0, viewport.height - size.height - 8);
  return { x: Math.min(maxX, Math.max(Math.min(8, maxX), Number.isFinite(position.x) ? position.x : maxX)),
    y: Math.min(maxY, Math.max(Math.min(8, maxY), Number.isFinite(position.y) ? position.y : maxY)) };
}
export const isDragMovement = (dx: number, dy: number) => dx * dx + dy * dy > 36;

export function shareDraftKey(gameId: string, actId: string, roleId: string | null) {
  return roleId ? `shareDraft:${gameId}:${actId}:${roleId}` : null;
}
export function loadShareDraft(storage: Pick<Storage, "getItem">, key: string | null) {
  try { return key ? storage.getItem(key) ?? "" : ""; } catch { return ""; }
}
export function saveShareDraft(storage: Pick<Storage, "setItem">, key: string | null, value: string) {
  try { if (key) storage.setItem(key, value); } catch { /* Keep the current editable value. */ }
}

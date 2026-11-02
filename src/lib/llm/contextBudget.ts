import { LlmClientError } from "./llmErrors";

export const LOCAL_CONTEXT_HARD_LIMIT = 60_000;
// Includes JSON escaping of the messages; leaves room for schema/instructions.
export const CHOICE_CONTEXT_TARGET = 48_000;
export function serializedMessageChars(messages: unknown) { return JSON.stringify(messages).length; }
export function assertContextBudget(messages: unknown, limit = LOCAL_CONTEXT_HARD_LIMIT) {
  const chars = serializedMessageChars(messages);
  if (chars > limit) throw new LlmClientError({ type: "context_limit",
    message: `本地模型上下文超限：序列化消息 ${chars} 字符，允许 ${limit} 字符。请求尚未发送，请精简任务上下文后恢复。` });
  return chars;
}

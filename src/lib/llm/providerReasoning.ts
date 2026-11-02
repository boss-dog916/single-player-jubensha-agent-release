import type { BaseLlmInput } from "@/src/lib/llm/llmTypes";

export function providerReasoningOptions(model: string, input: Pick<BaseLlmInput, "reasoningEffort">) {
  const disabled = input.reasoningEffort === "none" || process.env.LLM_THINKING_MODE === "disabled";
  if (model.startsWith("deepseek-v4")) {
    return { enable_thinking: !disabled,
      reasoning_effort: disabled ? undefined : input.reasoningEffort };
  }
  return { reasoning_effort: input.reasoningEffort };
}

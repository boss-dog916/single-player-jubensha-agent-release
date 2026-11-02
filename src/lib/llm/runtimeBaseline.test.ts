import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { applicationDatabaseUrl } from "../env/runtimeBaseline";
import { effectiveTaskModelProfile, resolveTaskModelProfile } from "./taskModelProfiles";
import { generateStructured, setLlmClientForTests } from "./llmClient";

beforeEach(() => {
  for (const key of ["RUNTIME_LLM_PROVIDER", "RUNTIME_LLM_MODEL", "RUNTIME_LLM_BASE_URL", "RUNTIME_LLM_API_KEY", "LONG_NIGHT_PLAYTEST_DIR",
    "LONG_NIGHT_PLAYTEST_RUNTIME_PROVIDER", "DM_SEMANTIC_OBSERVER_PROVIDER", "DM_SEMANTIC_OBSERVER_MODEL", "DM_SEMANTIC_OBSERVER_BASE_URL", "DM_SEMANTIC_OBSERVER_API_KEY", "QWEN_BASE_URL"]) vi.stubEnv(key, "");
  vi.stubEnv("OPENAI_MODEL", "deepseek-v4-flash");
  vi.stubEnv("OPENAI_BASE_URL", "https://old-gateway.invalid/v1");
  vi.stubEnv("BAILIAN_API_KEY", "offline-bailian");
  vi.stubEnv("BAILIAN_BASE_URL", "https://bailian.fixture/v1");
  setLlmClientForTests(null);
});
afterEach(() => { setLlmClientForTests(null); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("uses the same safe baseline for ordinary and legacy Live requests despite old OPENAI settings", () => {
  const normal = effectiveTaskModelProfile({ agentType: "ai_player_reaction_planner", maxOutputTokens: 800 });
  expect(normal).toMatchObject({ provider: "bailian", model: "qwen3.8-flash", reasoningPolicy: "disabled", timeoutMs: 90000, maxOutputTokens: 2400 });
  vi.stubEnv("LONG_NIGHT_PLAYTEST_DIR", "legacy-test"); vi.stubEnv("LONG_NIGHT_PLAYTEST_RUNTIME_PROVIDER", "bailian");
  expect(effectiveTaskModelProfile({ agentType: "ai_player_reaction_planner", maxOutputTokens: 800 })).toEqual(normal);
});

it.each([["ai_player_discussion_utterance", 1500, 1500], ["ai_player_discussion_utterance", 900, 900],
  ["discussion_checker", 1100, 1100], ["dm_node_realizer", 1800, 1800], ["story_board_writer", 6000, 2400],
  ["ai_player_runtime_choice", 100, 100]] as const)("preserves the verified task budget %s/%s", (agentType, budget, expected) => {
  expect(effectiveTaskModelProfile({ agentType, maxOutputTokens: budget }).maxOutputTokens).toBe(expected);
});

it("keeps Observer and Parser independent when users change the runtime API/model", async () => {
  vi.stubEnv("RUNTIME_LLM_PROVIDER", "compatible"); vi.stubEnv("RUNTIME_LLM_MODEL", "user-model");
  vi.stubEnv("RUNTIME_LLM_BASE_URL", "https://user-api.fixture/v1"); vi.stubEnv("RUNTIME_LLM_API_KEY", "user-secret");
  const calls: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    calls.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ model: "user-model", choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
  }));
  await generateStructured({ agentType: "ai_player_reaction_planner", schemaName: "fixture", zodSchema: z.object({ ok: z.boolean() }),
    messages: [{ role: "user", content: "JSON fixture" }], maxOutputTokens: 800 });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ url: "https://user-api.fixture/v1/chat/completions", auth: "Bearer user-secret", body: { max_completion_tokens: 2400 } });
  expect(resolveTaskModelProfile("semantic_observer")).toMatchObject({ provider: "bailian", model: "deepseek-v4.1-flash", maxOutputTokens: 2400 });
  expect(resolveTaskModelProfile("manual_planner").provider).toBe("bailian");
});

it("does not let DeepSeek selection silently enable Planner thinking", async () => {
  vi.stubEnv("RUNTIME_LLM_PROVIDER", "compatible"); vi.stubEnv("RUNTIME_LLM_MODEL", "deepseek-v4-flash");
  vi.stubEnv("RUNTIME_LLM_BASE_URL", "https://user-api.fixture/v1"); vi.stubEnv("RUNTIME_LLM_API_KEY", "offline-key");
  const bodies: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { headers: { "content-type": "application/json" } }); }));
  await generateStructured({ agentType: "ai_player_reaction_planner", schemaName: "fixture", zodSchema: z.object({ ok: z.boolean() }), messages: [{ role: "user", content: "JSON fixture" }], maxRetries: 5 });
  expect(bodies[0]).toMatchObject({ enable_thinking: false, max_completion_tokens: 2400 });
});

it("normalizes one default SQLite path and makes explicit overrides unambiguous", () => {
  expect(applicationDatabaseUrl("")).toBe(`file:${process.cwd()}/storage/app.db`);
  expect(applicationDatabaseUrl("file:../storage/app.db")).toBe(applicationDatabaseUrl(""));
  expect(applicationDatabaseUrl("file:/tmp/explicit.db")).toBe("file:/tmp/explicit.db");
});

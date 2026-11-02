import "server-only";
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { BaseLlmInput, TaskModelProfile } from "./llmTypes";
import { assertContextBudget } from "./contextBudget";
import { LlmClientError } from "./llmErrors";

// Explicit local development switch only. Ordinary games have no such switch.
// This is a small HTTP request cap, not a scheduler or a game permission system.
export function localPlaytestMode(): "blocked" | "mock" | "live" | null {
  if (!process.env.LONG_NIGHT_PLAYTEST_DIR) return null;
  if (process.env.NODE_ENV === "production") throw new Error("Local playtest cannot run in production");
  const mode = process.env.LONG_NIGHT_PLAYTEST_MODE ?? "blocked";
  if (!["blocked", "mock", "live"].includes(mode)) throw new Error("Invalid local playtest mode");
  return mode as "blocked" | "mock" | "live";
}
export function localPlaytestManifest() {
  const root = realpathSync(process.env.LONG_NIGHT_PLAYTEST_DIR!);
  const base = resolve(process.cwd(), "storage/playtests");
  if (!root.startsWith(base + sep)) throw new Error("Playtest directory must be inside storage/playtests");
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
    databaseUrl: string; gameId: string; definitionId: string; maxCalls: number | null;
    fixtureKind?: string; mockOnly?: boolean; allowedActIds?: string[];
  };
  if (manifest.databaseUrl !== `file:${join(root, "playtest.db")}` || process.env.DATABASE_URL !== manifest.databaseUrl) {
    throw new Error("Playtest database does not match isolated manifest");
  }
  const uncapped = manifest.fixtureKind === "long-night-full" && manifest.mockOnly === false && manifest.maxCalls === null;
  if (!uncapped && (!Number.isInteger(manifest.maxCalls) || manifest.maxCalls! < 1 || manifest.maxCalls! > 500)) throw new Error("Invalid playtest request cap");
  if (manifest.fixtureKind === "long-night-authentic-act1" && manifest.maxCalls !== 50) throw new Error("真实角色资料第一幕试玩的全局请求硬上限必须为50；不能提高本局额度。");
  return { root, manifest };
}
export function assertLocalPlaytestCall(input: BaseLlmInput, profile: TaskModelProfile) {
  const mode = localPlaytestMode();
  if (!mode) return;
  const { manifest } = localPlaytestManifest();
  if (input.gameSessionId !== manifest.gameId) throw new Error("Only the prepared isolated game can call LLMs");
  if (mode === "blocked") throw new Error("真实模型尚未授权：请等待确认后重启为 live 模式。当前没有发送模型请求。");
  if (manifest.mockOnly && mode !== "mock") throw new Error("This prepared fixture is Mock-only; live calls forbidden");
  const allowedOriginalActs = manifest.fixtureKind === "old-house-six-act" ? Array.from({ length: 6 }, (_, i) => `runtime_act_${i + 1}`)
    : manifest.fixtureKind === "old-house-group-matching" ? ["runtime_act_1", "runtime_act_2"] : [];
  const fullActs = manifest.fixtureKind === "long-night-full" && Array.from({ length: 6 }, (_, i) => `runtime_act_${i+1}`).includes(input.actId ?? "") && manifest.allowedActIds?.includes(input.actId!);
  const originalMockActs = mode === "mock" && manifest.mockOnly === true &&
    allowedOriginalActs.includes(input.actId ?? "") && manifest.allowedActIds?.includes(input.actId!);
  if (input.actId !== "runtime_act_1" && !originalMockActs && !fullActs) throw new Error("试玩调用止于第一幕；第二幕仅供读本，不再生成。");
  if (mode === "live" && !process.env[profile.provider === "bailian" ? "BAILIAN_API_KEY" : "OPENAI_API_KEY"]?.trim()) {
    throw new Error("Live playtest requires real provider credentials; Mock fallback forbidden");
  }
}
export async function localPlaytestFetch(resource: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], input: BaseLlmInput, profile: TaskModelProfile) {
  if (localPlaytestMode()) {
    assertLocalPlaytestCall(input, profile);
    if (localPlaytestMode() !== "live") throw new Error("Network model calls are blocked in this playtest mode");
    const { root, manifest } = localPlaytestManifest();
    const lock = join(root, "request.lock"), fd = openSync(lock, "wx");
    try {
      const path = join(root, "request-budget.json");
      const state = JSON.parse(readFileSync(path, "utf8")) as { calls: number; requests: unknown[] };
      if (!Number.isInteger(state.calls) || state.calls < 0 || state.calls !== state.requests.length) throw new Error("Invalid playtest budget ledger");
      if (manifest.maxCalls !== null && state.calls >= manifest.maxCalls) throw new LlmClientError({ type: "test_budget", message: `试玩模型请求已达 ${manifest.maxCalls} 次上限；停止生成，保留游戏记录。` });
      const body = JSON.parse(String(init?.body));
      if (body.model !== profile.model || (init?.method !== "POST")) throw new Error("Unexpected playtest model request");
      const outputCap = body.max_tokens ?? body.max_completion_tokens;
      assertContextBudget(body.messages);
      if (!Number.isInteger(outputCap) || outputCap < 1 || outputCap > 2400) {
        throw new Error("Playtest request exceeds the 2400 output-token / 60000 input-character bound");
      }
      state.calls++;
      state.requests.push({ index: state.calls, at: new Date().toISOString(), gameId: input.gameSessionId,
        agentType: input.agentType, provider: profile.provider, model: body.model, actId: input.actId });
      // Reserve BEFORE sending, including requests that subsequently fail/timeout.
      writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  return fetch(resource, init);
}

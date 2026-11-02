import { normalizeLlmError } from "./llmErrors";
import type { BaseLlmInput, TaskModelProfile } from "./llmTypes";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
// Only this explicit provider/model pair. No Mock/BUPT or Parser fallback.
const switched = new Set<string>();
function statePath(p: TaskModelProfile) {
  const root = process.env.BAILIAN_FAILOVER_STATE_DIR
    || join(process.env.LONG_NIGHT_PLAYTEST_DIR || "storage", "model-failover");
  const key = `${p.provider}:${p.endpointIdentity}:${p.model}`;
  return join(resolve(root), `${createHash("sha256").update(key).digest("hex")}.json`);
}
export function bailianFallbackProfile(profile: TaskModelProfile, input: BaseLlmInput, error?: unknown): TaskModelProfile | null {
  if (profile.provider !== "bailian" || profile.model !== "deepseek-v4.1-flash" || profile.taskType.startsWith("manual_") || input.signal?.aborted) return null;
  const failure = error === undefined ? null : normalizeLlmError(error).type;
  const path = statePath(profile);
  if (error !== undefined) {
    if (!["quota", "rate_limit", "network", "timeout", "service_unavailable"].includes(failure!)) return null;
    // A switch is sticky, including across restarts. One file per endpoint/model
    // avoids concurrent writers overwriting unrelated providers' state.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, JSON.stringify({ model: "deepseek-v4.1-flash-1017", reason: failure, switchedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    switched.add(path);
  } else if (!switched.has(path) && !existsSync(path)) return null;
  return { ...profile, model: "deepseek-v4.1-flash-1017", profileVersion: `${profile.profileVersion}:fallback-1017` };
}
export function resetBailianFailoverForTests() { switched.clear(); }

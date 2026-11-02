import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { loadEnvConfig } from "@next/env";
import { applicationDatabaseUrl, RUNTIME_BASELINE } from "../src/lib/env/runtimeBaseline";

const [command = "check", ...args] = process.argv.slice(2);
loadEnvConfig(process.cwd(), command !== "start");
if (process.env.LONG_NIGHT_PLAYTEST_DIR) throw new Error("Standard entry does not use a playtest manifest. Unset LONG_NIGHT_PLAYTEST_DIR first; historical launchers remain separate.");
process.env.DATABASE_URL = applicationDatabaseUrl();
process.env.SHARE_DRAFT_ENABLED ??= "false";
const { effectiveTaskModelProfile, resolveTaskModelProfile, hasTaskApiKey } = await import("../src/lib/llm/taskModelProfiles");
const { bailianFallbackProfile } = await import("../src/lib/llm/bailianFailover");
const observer = resolveTaskModelProfile("semantic_observer");
const problems = (await import("../src/lib/env/runtimeConfiguration")).runtimeConfigurationProblems();
const databasePath = process.env.DATABASE_URL.slice(5);
const summary = {
  baseline: RUNTIME_BASELINE.version, databasePath,
  databaseOverride: databasePath !== resolve("storage/app.db"),
  runtime: { ...resolveTaskModelProfile(), credentialConfigured: hasTaskApiKey("runtime") },
  observer: { ...(bailianFallbackProfile(observer, { agentType: "dm_semantic_observer" }) ?? observer), primaryModel: observer.model, credentialConfigured: hasTaskApiKey("semantic_observer") },
  planner: effectiveTaskModelProfile({ agentType: "ai_player_reaction_planner", maxOutputTokens: 800 }),
  budgets: RUNTIME_BASELINE, thinking: false, configurationProblems: problems,
  compression: { enabled: process.env.AUTO_CONTEXT_COMPRESSION_ENABLED !== "false", triggerChars: Number(process.env.AUTO_CONTEXT_TRIGGER_CHARS ?? 54000),
    targetChars: Number(process.env.AUTO_CONTEXT_TARGET_CHARS ?? 52000), windowTokens: Number(process.env.AUTO_CONTEXT_MODEL_WINDOW_TOKENS ?? 65536) },
  shareDraftEnabled: process.env.SHARE_DRAFT_ENABLED === "true"
};
console.log(JSON.stringify(summary, null, 2));
if (summary.databaseOverride) console.warn("DATABASE_URL explicitly overrides storage/app.db; no database is migrated or merged automatically.");
if (process.env.OPENAI_MODEL && summary.runtime.provider === "bailian") console.warn("Legacy OPENAI_MODEL/OPENAI_BASE_URL do not select the runtime. Use RUNTIME_LLM_* explicitly.");

if (command === "init" || command === "install") {
  const bundle = resolve(process.env.LONG_NIGHT_PRESET_DIR || "storage/presets/long-night-v4");
  mkdirSync(dirname(databasePath), { recursive: true });
  if (!existsSync(databasePath)) writeFileSync(databasePath, "", { flag: "wx", mode: 0o600 });
  const migration = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: process.env, stdio: "inherit" });
  if (migration.status !== 0) throw new Error("Database migrations failed; preset import was not run.");
  const { importLongNightPreset } = await import("../src/lib/services/presetScriptService");
  try {
    if (command === "install") {
      if (!args[0]) throw new Error('用法：npm run preset:install -- "资源包.zip或目录"');
      const { withPresetSource } = await import("../src/lib/services/presetArchive");
      console.log(JSON.stringify(await withPresetSource(args[0], importLongNightPreset), null, 2));
    } else if (existsSync(resolve(bundle, "bundle.json"))) console.log(JSON.stringify(await importLongNightPreset(bundle), null, 2));
    else console.log("个人数据库已初始化；尚未安装预置剧本。运行 npm run preset:install -- <合法资源包ZIP或目录>，或使用实验性上传功能。");
  }
  finally { await (await import("../src/lib/db/prisma")).prisma.$disconnect(); }
} else if (["dev", "start", "build"].includes(command)) {
  if (command !== "build" && problems.length) throw new Error(`模型配置未完成，服务未启动：\n${problems.join("\n")}`);
  if (command !== "build" && !existsSync(databasePath)) throw new Error("Database missing. Run npm run db:init before starting.");
  const hostArgs = command !== "build" && !args.some(arg => arg === "--hostname" || arg === "-H" || arg.startsWith("--hostname=") || arg.startsWith("-H="))
    ? ["--hostname", "127.0.0.1"] : [];
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", command, ...args, ...hostArgs], { env: process.env, stdio: "inherit" });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("exit", code => process.exit(code ?? 1));
} else if (command === "check") { if (problems.length) process.exitCode = 1; }
else throw new Error("Use check, init, install, dev, build or start");

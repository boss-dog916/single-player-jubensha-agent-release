import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { accessDirectory, developerSecret, issueCredential } from "@/src/lib/access/localCredentials";
if (existsSync(".env")) process.loadEnvFile(".env");
const args = process.argv.slice(2);
const value = (name: string, fallback = "") => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
if (value("--dir")) {
  const root = resolve(value("--dir"));
  process.env.LONG_NIGHT_PLAYTEST_DIR = root;
  const manifest = resolve(root, "manifest.json");
  if (existsSync(manifest) && ["old-house-six-act", "long-night-authentic-act1", "long-night-full"].includes(JSON.parse(readFileSync(manifest, "utf8")).fixtureKind)) {
    process.env.LOCAL_ACCESS_STATE_DIR = resolve(root, "access-control");
    delete process.env.LOCAL_DEVELOPER_TOKEN; delete process.env.LOCAL_ACCESS_SIGNING_KEY;
  }
}
if (args.includes("--paths-only")) { developerSecret(); issueCredential("developer"); console.log(`凭证目录：${accessDirectory()}`); }
else if (value("--game")) {
  const port = Number(value("--port", "3103")); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid port");
  console.log(`仅交给本局玩家，10分钟内有效；不要贴入日志或聊天：\nhttp://127.0.0.1:${port}/games/${value("--game")}#access=${issueCredential("entry", value("--game"))}`);
} else console.log(`本机开发者凭证（仅在 /developer 输入，勿分享给玩家）：\n${developerSecret()}\n凭证目录：${accessDirectory()}`);

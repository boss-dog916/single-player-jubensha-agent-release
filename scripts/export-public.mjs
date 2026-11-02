import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const target = resolve(process.argv[2] || "storage/public-source-v1");
if (existsSync(target)) throw new Error("目标已存在，请指定新目录；不覆盖任何已有文件");
const selected = [];
const tests = new Set(["src/lib/llm/runtimeBaseline.test.ts", "src/lib/env/runtimeConfiguration.test.ts", "src/lib/services/presetArchive.test.ts",
  "src/lib/state/gameStateMachine.test.ts", "src/lib/services/publicDiscussionContext.test.ts",
  "src/lib/services/rolePrivateKnowledge.test.ts", "src/lib/services/runtimeChoiceContext.test.ts"]);
const select = path => {
  if (path.startsWith("src/lib/test/")) return path === "src/lib/test/serverOnlyStub.ts";
  if (/\.test\.[tj]sx?$/.test(path)) return tests.has(path);
  if (path.startsWith("benchmarks/")) return path === "benchmarks/local-access.ts";
  if (path.startsWith("docs/")) return ["docs/INSTALLATION.md", "docs/PUBLIC_RELEASE_PREPARATION.md", "docs/PUBLIC_RELEASE_FINAL_CHECK.md"].includes(path);
  return !/\.(?:pdf|docx|db|log|zip|pem|key)$|(^|\/)\.env(?!\.example$)/i.test(path);
};
const visit = path => {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return;
  if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) visit(`${path}/${name}`);
  else if (select(path)) selected.push(path);
};
for (const root of ["app", "components", "src", "lib", "data", "scripts", "benchmarks", "prisma/migrations", "docs/INSTALLATION.md", "docs/PUBLIC_RELEASE_PREPARATION.md", "docs/PUBLIC_RELEASE_FINAL_CHECK.md"]) visit(root);
for (const file of [".gitignore", ".env.example", "README.md", "package.json", "package-lock.json", "prisma/schema.prisma", "next.config.ts", "next-env.d.ts", "postcss.config.mjs", "tailwind.config.ts", "tsconfig.json", "vitest.config.ts"]) if (existsSync(file)) selected.push(file);
const secrets = existsSync(".env") ? [...readFileSync(".env", "utf8").matchAll(/^\s*[A-Z_]*(?:API_KEY|TOKEN|SIGNING_KEY)\s*=\s*["']?([^\r\n"']+)/gm)].map(m => m[1].trim()).filter(value => value.length >= 20) : [];
for (const path of selected) {
  const bytes = readFileSync(path);
  if (secrets.some(secret => bytes.includes(secret))) throw new Error(`发现实际凭据，未导出：${path}`);
  if (/\u90ed\u679c|\u9648\u4fca\u9752|\u4f60\u662f\u6765\u6740\u6b7b\u4ed6\u7684/.test(bytes.toString("utf8"))) throw new Error(`发现私有剧情文本，未导出：${path}`);
}
mkdirSync(target, { recursive: true });
for (const path of selected) { mkdirSync(resolve(target, path, ".."), { recursive: true }); copyFileSync(path, join(target, path)); }
writeFileSync(join(target, "next-env.d.ts"), '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n');
const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
for (const name of Object.keys(pkg.scripts)) if (name.startsWith("benchmark:") || name.startsWith("playtest:")) delete pkg.scripts[name];
writeFileSync(join(target, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
console.log(JSON.stringify({ output: target, files: selected.length, includesGitHistory: false, includesScriptResources: false, includesCredentials: false }));

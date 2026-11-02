// Local authoring operation only. Reads an explicitly supplied source DB in
// read-only mode and exports no game, memory, message, credential or AgentRun.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

const [source, target = "storage/presets/long-night-v4"] = process.argv.slice(2);
if (!source) throw new Error("Usage: npm run preset:export -- <source.db> [new-output-directory]");
const root = resolve(target);
if (existsSync(root)) throw new Error("Preset output already exists; use a new directory. Existing bundles are never overwritten.");
const read = (sql: string) => JSON.parse(execFileSync("sqlite3", ["-readonly", "-cmd", ".timeout 5000", "-json", resolve(source), sql], { encoding: "utf8", maxBuffer: 20_000_000 }) || "[]");
const runtime = read("SELECT * FROM ScriptRuntimeDefinition WHERE id='cmvv6oibj0001ejaub97rwzmx'")[0];
if (!runtime || runtime.version !== 4) throw new Error("Reviewed v4 definition missing");
const pkg = read(`SELECT * FROM ScriptPackage WHERE id='${runtime.scriptPackageId}'`)[0];
const tables: Record<string, any[]> = {};
for (const table of ["UploadedAsset", "ParsedDocument", "DocumentSection", "RoleActBooklet", "DMFlow"]) {
  tables[table] = read(`SELECT * FROM ${table} WHERE scriptPackageId='${runtime.scriptPackageId}'`);
}
tables.GroupMatchingKey = read(`SELECT * FROM GroupMatchingKey WHERE runtimeDefinitionId='${runtime.id}'`);
// Check every source file before creating the bundle, so missing originals do
// not produce an apparently complete installable preset.
for (const asset of tables.UploadedAsset) {
  if (!existsSync(resolve(asset.localPath))) throw new Error(`Missing preset source asset: ${asset.originalName}`);
}
mkdirSync(resolve(root, "assets"), { recursive: true });
for (const asset of tables.UploadedAsset) {
  const fileName = `${asset.id}-${basename(asset.localPath)}`;
  copyFileSync(resolve(asset.localPath), resolve(root, "assets", fileName));
  asset.localPath = `assets/${fileName}`;
  asset.sha256 = createHash("sha256").update(readFileSync(resolve(root, asset.localPath))).digest("hex");
  asset.sizeBytes = statSync(resolve(root, asset.localPath)).size;
}
writeFileSync(resolve(root, "bundle.json"), JSON.stringify({ format: "local-script-preset-v1", presetId: "long-night-v4", version: 4,
  rolePolicy: existsSync("storage/script-policies/long-night-v4.json") ? JSON.parse(readFileSync("storage/script-policies/long-night-v4.json", "utf8")) : undefined,
  distribution: "local-only-pending-owner-permission", package: pkg, runtime, tables }, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ output: root, assets: tables.UploadedAsset.length, version: 4, exportedGameRecords: 0 }));

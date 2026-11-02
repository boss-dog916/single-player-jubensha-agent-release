import "server-only";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { prisma } from "@/src/lib/db/prisma";
import { validateScriptRuntimeDefinition } from "./scriptRuntimeDefinitionService";
import { validateMatchingAssignments } from "./groupMatchingKeyService";

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const slug = "preset-long-night-v4";

export async function importLongNightPreset(bundleDirectory: string) {
  const root = resolve(bundleDirectory);
  const bundle = JSON.parse(readFileSync(resolve(root, "bundle.json"), "utf8"));
  if (bundle.format !== "local-script-preset-v1" || bundle.presetId !== "long-night-v4" || bundle.version !== 4) throw new Error("Unsupported preset bundle");
  const digest = sha(bundle.runtime.definitionJson);
  const assets = bundle.tables.UploadedAsset as Array<Record<string, any>>;
  for (const asset of assets) {
    const file = realpathSync(resolve(root, asset.localPath));
    if (!file.startsWith(realpathSync(root) + sep) || sha(readFileSync(file)) !== asset.sha256) throw new Error(`Preset asset integrity failed: ${asset.originalName}`);
  }
  if (bundle.rolePolicy) {
    const directory = resolve("storage/script-policies"), file = resolve(directory, "long-night-v4.json");
    const policy = JSON.stringify(bundle.rolePolicy);
    if (existsSync(file)) {
      if (JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) !== policy) throw new Error("Existing preset policy differs; user resources were not overwritten");
    } else { mkdirSync(directory, { recursive: true }); writeFileSync(file, policy, { flag: "wx", mode: 0o600 }); }
  }
  const old = await prisma.scriptPackage.findUnique({ where: { slug }, include: { runtimeDefinitions: true } });
  if (old) {
    const marker = JSON.parse(old.sourceMetaJson ?? "{}");
    if (marker.presetId !== bundle.presetId || marker.digest !== digest) throw new Error("Existing package differs from this preset; user data was not overwritten");
    const runtime = old.runtimeDefinitions.find(r => r.version === 4);
    if (!runtime || await prisma.groupMatchingKey.count({ where: { runtimeDefinitionId: runtime.id } }) !== bundle.tables.GroupMatchingKey.length) throw new Error("Existing preset incomplete; no automatic overwrite");
    return { scriptPackageId: old.id, runtimeDefinitionId: runtime.id, version: 4, imported: false, reason: "already_initialized" };
  }

  // Stable namespaced IDs preserve every internal reference without collisions
  // with original authoring records or games in a user's existing database.
  const ids = new Map<string, string>();
  for (const row of [bundle.package, bundle.runtime, ...Object.values(bundle.tables).flat() as any[]]) {
    ids.set(row.id, `preset-ln4-${sha(row.id).slice(0, 24)}`);
  }
  const remap = (value: any): any => typeof value === "string" ? ids.get(value) ?? value
    : Array.isArray(value) ? value.map(remap)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v)])) : value;
  const rowData = (row: Record<string, any>) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "sha256").map(([key, value]) => [key,
    key === "isActive" ? Boolean(value)
      : value !== null && ["createdAt", "updatedAt", "compiledAt"].includes(key) ? new Date(value)
      : typeof value === "string" && key.endsWith("Json") ? JSON.stringify(remap(JSON.parse(value))) : remap(value)]));
  const definition = remap(JSON.parse(bundle.runtime.definitionJson));
  const validation = validateScriptRuntimeDefinition(definition);
  if (validation.errors.length) throw new Error(`Preset Runtime invalid: ${validation.errors.map(error => error.code).join(", ")}`);
  for (const node of definition.dmFlow.actFlows.flatMap((flow: any) => flow.nodes).filter((node: any) => node.choice?.type === "group_matching")) {
    const key = bundle.tables.GroupMatchingKey.find((key: any) => key.choiceId === node.choice.choiceId);
    if (!key) throw new Error("Preset missing server-only matching key");
    validateMatchingAssignments(node, JSON.parse(key.assignmentsJson));
  }
  const destination = resolve("storage/scripts/presets", digest);
  mkdirSync(destination, { recursive: true });
  for (const asset of assets) {
    const file = resolve(destination, `${ids.get(asset.id)}${asset.originalName.toLowerCase().endsWith(".pdf") ? ".pdf" : ".source"}`);
    if (existsSync(file)) {
      if (sha(readFileSync(file)) !== asset.sha256) throw new Error("Preset destination differs; existing resource was not overwritten");
    } else copyFileSync(resolve(root, asset.localPath), file, constants.COPYFILE_EXCL);
    asset.localPath = relative(process.cwd(), file);
  }
  await prisma.$transaction(async tx => {
    await tx.scriptPackage.create({ data: { ...rowData(bundle.package), slug,
      sourceMetaJson: JSON.stringify({ presetId: bundle.presetId, digest, distribution: bundle.distribution }) } as any });
    for (const [table, model] of [["UploadedAsset", "uploadedAsset"], ["ParsedDocument", "parsedDocument"],
      ["DocumentSection", "documentSection"], ["RoleActBooklet", "roleActBooklet"], ["DMFlow", "dMFlow"]]) {
      for (const row of bundle.tables[table]) await (tx as any)[model].create({ data: rowData(row) });
    }
    await tx.scriptRuntimeDefinition.create({ data: { ...rowData(bundle.runtime), definitionJson: JSON.stringify(definition),
      validationReportJson: JSON.stringify(validation), status: validation.errors.length ? "INVALID" : validation.status === "warning" ? "WARNING" : "VALID" } as any });
    for (const row of bundle.tables.GroupMatchingKey) await tx.groupMatchingKey.create({ data: rowData(row) as any });
  }, { timeout: 30_000 });
  return { scriptPackageId: ids.get(bundle.package.id), runtimeDefinitionId: ids.get(bundle.runtime.id), version: 4,
    imported: true, assets: assets.length, acts: definition.acts.length, errors: validation.errors.length, warnings: validation.warnings.length,
    importedGameRecords: 0 };
}

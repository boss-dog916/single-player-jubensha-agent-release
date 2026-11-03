import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  AssetParseStatus,
  IngestionJobStatus,
  ScriptPackageStatus,
  UploadedAssetPurpose,
  UploadedAssetKind,
  type IngestionJob,
  type ScriptPackage,
  type UploadedAsset
} from "@prisma/client";
import { prisma } from "@/src/lib/db/prisma";
import { loadScript, parseScriptJson } from "@/src/lib/script/loadScript";
import type { Script } from "@/src/lib/script/scriptTypes";
import { fromJsonValue, toJsonInput } from "@/src/lib/services/jsonFields";
import { getRuntimeScriptForGameSession } from "@/src/lib/services/runtimeDefinitionSessionService";
import {
  validateScriptPackageScript,
  type ValidationReport
} from "@/src/lib/services/scriptPackageValidator";

const DEFAULT_SCRIPT_PACKAGE_SLUG = "demo-script";
const STORAGE_ROOT = join(process.cwd(), "storage", "scripts");
const INGESTION_STEP_NAMES = [
  "upload",
  "text_extraction",
  "document_classification",
  "section_segmentation",
  "role_extraction",
  "booklet_extraction",
  "dm_flow_extraction",
  "clue_extraction",
  "validation",
  "human_review"
] as const;

export type CreateScriptPackageInput = {
  slug?: string | null;
  title?: string | null;
  description?: string | null;
  scriptJson: unknown;
  status?: ScriptPackageStatus;
  validationJson?: unknown;
  sourceMetaJson?: unknown;
};

export type UploadScriptAssetInput = {
  scriptPackageId: string;
  file: File;
  kind?: UploadedAssetKind;
  assetPurpose?: UploadedAssetPurpose;
  roleName?: string | null;
  metadataJson?: unknown;
};

export type CreateIngestionJobInput = {
  scriptPackageId: string;
  inputJson?: unknown;
  stepNames?: string[];
};

export type ScriptPackageWithScript = ScriptPackage & {
  script: Script;
  validation: ValidationReport | null;
  sourceMeta: unknown | null;
};

export type ScriptPackageSummary = {
  id: string;
  slug: string | null;
  title: string;
  description: string | null;
  status: ScriptPackageStatus;
  isDefaultDemo: boolean;
  assetCount: number;
  latestIngestionJobStatus: IngestionJobStatus | null;
  validation: ValidationReport;
  createdAt: Date;
  updatedAt: Date;
};

export type ScriptPackageDetail = ScriptPackageSummary & {
  sourceMeta: unknown | null;
  script: Script;
};

export type UpdateScriptPackageInput = {
  slug?: string | null;
  title?: string;
  description?: string | null;
  status?: ScriptPackageStatus;
  scriptJson?: unknown;
  sourceMetaJson?: unknown;
};

export async function getOrCreateDefaultScriptPackage(): Promise<ScriptPackageWithScript> {
  const existing = await prisma.scriptPackage.findUnique({
    where: { slug: DEFAULT_SCRIPT_PACKAGE_SLUG }
  });

  if (existing) {
    return hydrateScriptPackage(existing);
  }

  const script = loadScript();
  const record = await prisma.scriptPackage.create({
    data: {
      slug: DEFAULT_SCRIPT_PACKAGE_SLUG,
      title: script.title,
      description: script.summary,
      status: ScriptPackageStatus.READY,
      scriptJson: toJsonInput(script),
      validationJson: toJsonInput(validateScriptPackageScript(script)),
      sourceMetaJson: toJsonInput({
        source: "data/demo-script.json",
        ingestion: "seeded_from_legacy_demo",
        pipeline_version: 1
      })
    }
  });

  return {
    ...record,
    script,
    validation: fromJsonValue(record.validationJson, null),
    sourceMeta: fromJsonValue(record.sourceMetaJson, null)
  };
}

export async function createScriptPackage(
  input: CreateScriptPackageInput
): Promise<ScriptPackageWithScript> {
  const script = parseScriptJson(input.scriptJson);
  const validation = validateScriptPackageScript(script);
  const record = await prisma.scriptPackage.create({
    data: {
      slug: input.slug?.trim() || null,
      title: input.title?.trim() || script.title,
      description: input.description?.trim() || script.summary,
      status: input.status ?? ScriptPackageStatus.DRAFT,
      scriptJson: toJsonInput(script),
      validationJson: toJsonInput(input.validationJson ?? validation),
      sourceMetaJson:
        input.sourceMetaJson === undefined ? null : toJsonInput(input.sourceMetaJson)
    }
  });

  return hydrateScriptPackage(record);
}

export async function listScriptPackages(): Promise<ScriptPackageWithScript[]> {
  const records = await prisma.scriptPackage.findMany({
    orderBy: { updatedAt: "desc" }
  });

  return records.map(hydrateScriptPackage);
}

export async function listScriptPackageSummaries(): Promise<ScriptPackageSummary[]> {
  await getOrCreateDefaultScriptPackage();
  const records = await prisma.scriptPackage.findMany({
    include: {
      _count: { select: { assets: true } },
      ingestionJobs: {
        orderBy: { createdAt: "desc" },
        take: 1
      }
    },
    orderBy: { updatedAt: "desc" }
  });

  return records.map((record) =>
    toScriptPackageSummary(record, record._count.assets, record.ingestionJobs[0]?.status ?? null)
  );
}

export async function getScriptPackage(
  scriptPackageId: string
): Promise<ScriptPackageWithScript> {
  const record = await prisma.scriptPackage.findUnique({
    where: { id: scriptPackageId }
  });

  if (!record) {
    throw new Error(`ScriptPackage not found for id "${scriptPackageId}".`);
  }

  return hydrateScriptPackage(record);
}

export async function getScriptPackageDetail(
  scriptPackageId: string
): Promise<ScriptPackageDetail> {
  const record = await prisma.scriptPackage.findUnique({
    where: { id: scriptPackageId },
    include: {
      _count: { select: { assets: true } },
      ingestionJobs: {
        orderBy: { createdAt: "desc" },
        take: 1
      }
    }
  });

  if (!record) {
    throw new Error(`ScriptPackage not found for id "${scriptPackageId}".`);
  }

  const hydrated = hydrateScriptPackage(record);

  return {
    ...toScriptPackageSummary(
      record,
      record._count.assets,
      record.ingestionJobs[0]?.status ?? null
    ),
    sourceMeta: hydrated.sourceMeta,
    script: hydrated.script
  };
}

export async function updateScriptPackage(
  scriptPackageId: string,
  input: UpdateScriptPackageInput
): Promise<ScriptPackageDetail> {
  const data: {
    slug?: string | null;
    title?: string;
    description?: string | null;
    status?: ScriptPackageStatus;
    scriptJson?: string;
    validationJson?: string;
    sourceMetaJson?: string | null;
  } = {};

  if ("slug" in input) {
    data.slug = input.slug?.trim() || null;
  }

  if (input.title !== undefined) {
    data.title = input.title.trim();
  }

  if ("description" in input) {
    data.description = input.description?.trim() || null;
  }

  if (input.status) {
    data.status = input.status;
  }

  if (input.scriptJson !== undefined) {
    const script = parseScriptJson(input.scriptJson);

    data.scriptJson = toJsonInput(script);
    data.validationJson = toJsonInput(validateScriptPackageScript(script));
  }

  if (input.sourceMetaJson !== undefined) {
    data.sourceMetaJson = toJsonInput(input.sourceMetaJson);
  }

  await prisma.scriptPackage.update({
    where: { id: scriptPackageId },
    data
  });

  return getScriptPackageDetail(scriptPackageId);
}

export async function deleteScriptPackage(scriptPackageId: string): Promise<void> {
  await prisma.scriptPackage.delete({
    where: { id: scriptPackageId }
  });
}

export async function listUploadedAssets(scriptPackageId: string): Promise<UploadedAsset[]> {
  await getScriptPackage(scriptPackageId);

  return prisma.uploadedAsset.findMany({
    where: { scriptPackageId },
    orderBy: { createdAt: "desc" }
  });
}

export async function deleteUploadedAsset(input: {
  scriptPackageId: string;
  assetId: string;
}): Promise<void> {
  const asset = await prisma.uploadedAsset.findFirst({
    where: {
      id: input.assetId,
      scriptPackageId: input.scriptPackageId
    }
  });

  if (!asset) {
    throw new Error(`UploadedAsset not found for id "${input.assetId}".`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.documentSection.deleteMany({
      where: {
        scriptPackageId: input.scriptPackageId,
        uploadedAssetId: input.assetId
      }
    });
    await tx.parsedDocument.deleteMany({
      where: {
        scriptPackageId: input.scriptPackageId,
        uploadedAssetId: input.assetId
      }
    });
    await tx.uploadedAsset.delete({
      where: { id: input.assetId }
    });
  });

  await unlink(join(process.cwd(), asset.localPath)).catch(() => undefined);
}

export async function listIngestionJobs(scriptPackageId: string) {
  await getScriptPackage(scriptPackageId);

  return prisma.ingestionJob.findMany({
    where: { scriptPackageId },
    include: {
      steps: {
        orderBy: { createdAt: "asc" }
      }
    },
    orderBy: { createdAt: "desc" }
  });
}

export async function validateAndStoreScriptPackage(
  scriptPackageId: string
): Promise<ValidationReport> {
  const scriptPackage = await getScriptPackage(scriptPackageId);
  const report = validateScriptPackageScript(scriptPackage.script);

  await prisma.scriptPackage.update({
    where: { id: scriptPackageId },
    data: {
      validationJson: toJsonInput(report)
    }
  });

  return report;
}

export async function getScriptForGameSession(gameSessionId: string): Promise<Script> {
  const session = await prisma.gameSession.findUnique({
    where: { id: gameSessionId },
    include: { scriptPackage: true }
  });

  if (!session) {
    throw new Error(`GameSession not found for gameSessionId "${gameSessionId}".`);
  }

  const runtimeScript = await getRuntimeScriptForGameSession(session);

  if (runtimeScript) {
    return runtimeScript;
  }

  if (session.scriptPackage) {
    return hydrateScriptPackage(session.scriptPackage).script;
  }

  return (await getOrCreateDefaultScriptPackage()).script;
}

export async function getScriptPackageForNewSession(
  scriptPackageId?: string | null
): Promise<ScriptPackageWithScript> {
  const scriptPackage = scriptPackageId
    ? await getScriptPackage(scriptPackageId)
    : await getOrCreateDefaultScriptPackage();
  const report = validateScriptPackageScript(scriptPackage.script);

  if (report.status === "invalid") {
    await prisma.scriptPackage.update({
      where: { id: scriptPackage.id },
      data: {
        validationJson: toJsonInput(report)
      }
    });

    throw new Error(
      `ScriptPackage "${scriptPackage.title}" is invalid: ${report.issues
        .filter((issue) => issue.level === "error")
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`
    );
  }

  return scriptPackage;
}

export async function uploadScriptAsset({
  scriptPackageId,
  file,
  kind = UploadedAssetKind.OTHER,
  assetPurpose = UploadedAssetPurpose.BOTH,
  roleName,
  metadataJson
}: UploadScriptAssetInput): Promise<UploadedAsset> {
  await getScriptPackage(scriptPackageId);
  (await import("./runtimeReadingSources")).readingMetadata(metadataJson === undefined ? null : JSON.stringify(metadataJson));

  const uploadedAssetId = randomUUID();
  const safeFileName = sanitizeFileName(file.name || "uploaded-asset");
  const relativePath = join(
    "storage",
    "scripts",
    scriptPackageId,
    "raw",
    `${uploadedAssetId}-${safeFileName}`
  );
  const absolutePath = join(process.cwd(), relativePath);

  await mkdir(join(STORAGE_ROOT, scriptPackageId, "raw"), { recursive: true });
  await writeFile(absolutePath, Buffer.from(await file.arrayBuffer()));

  return prisma.uploadedAsset.create({
    data: {
      id: uploadedAssetId,
      scriptPackageId,
      kind,
      assetPurpose,
      roleName: normalizeOptionalText(roleName),
      originalName: file.name || "uploaded-asset",
      mimeType: file.type || null,
      sizeBytes: file.size ? Math.min(file.size, 2147483647) : null,
      localPath: relativePath,
      parseStatus: AssetParseStatus.PENDING,
      metadataJson: metadataJson === undefined ? null : toJsonInput(metadataJson)
    }
  });
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

export async function createIngestionJob({
  scriptPackageId,
  inputJson,
  stepNames = [...INGESTION_STEP_NAMES]
}: CreateIngestionJobInput): Promise<
  IngestionJob & {
    steps: Array<{ id: string; stepName: string; status: IngestionJobStatus }>;
  }
> {
  await getScriptPackage(scriptPackageId);

  return prisma.ingestionJob.create({
    data: {
      scriptPackageId,
      status: IngestionJobStatus.PENDING,
      currentStep: stepNames[0] ?? null,
      inputJson: inputJson === undefined ? null : toJsonInput(inputJson),
      steps: {
        create: stepNames.map((stepName) => ({
          stepName,
          status: IngestionJobStatus.PENDING
        }))
      }
    },
    include: {
      steps: {
        select: {
          id: true,
          stepName: true,
          status: true
        },
        orderBy: { createdAt: "asc" }
      }
    }
  });
}

export function normalizeUploadedAssetKind(value: unknown): UploadedAssetKind {
  if (typeof value !== "string") {
    return UploadedAssetKind.OTHER;
  }

  return Object.values(UploadedAssetKind).includes(value as UploadedAssetKind)
    ? (value as UploadedAssetKind)
    : UploadedAssetKind.OTHER;
}

export function normalizeUploadedAssetPurpose(value: unknown): UploadedAssetPurpose {
  if (typeof value !== "string") {
    return UploadedAssetPurpose.BOTH;
  }

  return Object.values(UploadedAssetPurpose).includes(value as UploadedAssetPurpose)
    ? (value as UploadedAssetPurpose)
    : UploadedAssetPurpose.BOTH;
}

export function normalizeScriptPackageStatus(value: unknown): ScriptPackageStatus {
  if (typeof value !== "string") {
    return ScriptPackageStatus.DRAFT;
  }

  return Object.values(ScriptPackageStatus).includes(value as ScriptPackageStatus)
    ? (value as ScriptPackageStatus)
    : ScriptPackageStatus.DRAFT;
}

function hydrateScriptPackage(record: ScriptPackage): ScriptPackageWithScript {
  const script = parseScriptJson(
    fromJsonValue<unknown>(record.scriptJson, null),
    `ScriptPackage "${record.id}"`
  );

  // Older demo saves omitted role_a from the share order (assuming the human
  // always chose it). Append missing roles without shifting saved indices or
  // rewriting the stored script. Published Runtime definitions are untouched.
  if (record.slug === DEFAULT_SCRIPT_PACKAGE_SLUG) for (const act of script.acts) {
    act.share_order = [...new Set([...act.share_order, ...script.roles.map(role => role.role_id)])];
  }

  return {
    ...record,
    script,
    validation: normalizeValidationReport(record.validationJson, script),
    sourceMeta: fromJsonValue(record.sourceMetaJson, null)
  };
}

function toScriptPackageSummary(
  record: ScriptPackage,
  assetCount: number,
  latestIngestionJobStatus: IngestionJobStatus | null
): ScriptPackageSummary {
  const hydrated = hydrateScriptPackage(record);

  return {
    id: record.id,
    slug: record.slug,
    title: record.title,
    description: record.description,
    status: record.status,
    isDefaultDemo: record.slug === DEFAULT_SCRIPT_PACKAGE_SLUG,
    assetCount,
    latestIngestionJobStatus,
    validation: hydrated.validation ?? validateScriptPackageScript(hydrated.script),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function normalizeValidationReport(
  value: string | null,
  script: Script
): ValidationReport {
  const parsed = fromJsonValue<Partial<ValidationReport> | null>(value, null);

  if (
    parsed &&
    (parsed.status === "valid" || parsed.status === "warning" || parsed.status === "invalid") &&
    Array.isArray(parsed.issues)
  ) {
    return {
      status: parsed.status,
      issues: parsed.issues.filter(
        (issue): issue is ValidationReport["issues"][number] =>
          Boolean(issue) &&
          (issue.level === "error" || issue.level === "warning") &&
          typeof issue.path === "string" &&
          typeof issue.message === "string"
      ),
      checkedAt: typeof parsed.checkedAt === "string" ? parsed.checkedAt : new Date().toISOString()
    };
  }

  return validateScriptPackageScript(script);
}

function sanitizeFileName(fileName: string): string {
  const base = basename(fileName)
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);

  return base || "uploaded-asset";
}

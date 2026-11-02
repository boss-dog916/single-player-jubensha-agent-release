import "server-only";

import { readFile } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { DocumentSectionPurpose, UploadedAssetKind, UploadedAssetPurpose } from "@prisma/client";
import { prisma } from "@/src/lib/db/prisma";
import type { RoleId, Script } from "@/src/lib/script/scriptTypes";
import { getRuntimePlayerDisplayForGameSession, getRuntimeReadingSourcesForGameSession } from "@/src/lib/services/runtimeDefinitionSessionService";
import { getScriptForGameSession } from "@/src/lib/services/scriptPackageService";

import { fromJsonValue } from "./jsonFields";
import type { ReadingReceipt } from "./runtimeReadingService";

const DEMO_SCRIPT_PACKAGE_SLUG = "demo-script";

export type PlayerPdfReadingDocument = {
  sectionId: string; assetId: string; originalName: string; pdfUrl: string; pageStart: number; pageEnd: number;
  readingOrder: number; required: boolean; completed: boolean;
};

export type PlayerPdfReadingView = {
  documents?: PlayerPdfReadingDocument[];
  status: "available";
  roleId: RoleId;
  roleName: string;
  actIndex: number;
  actTitle: string;
  sectionId: string;
  assetId: string;
  originalName: string;
  pageStart: number;
  pageEnd: number;
  pdfUrl: string;
  rangeRestriction: "ui_page_hint" | "server_page_slice";
};

export type PlayerPdfReadingMissingView = {
  status: "not_configured";
  roleId: RoleId;
  roleName: string;
  actIndex: number;
  actTitle: string;
  message: string;
};

export type PlayerPdfReadingSnapshotView =
  | PlayerPdfReadingView
  | PlayerPdfReadingMissingView;

export type PlayerPdfBookletChapter = {
  actIndex: number;
  actTitle: string;
  documents: PlayerPdfReadingDocument[];
};

export type PlayerPdfBookletView = {
  roleId: RoleId;
  roleName: string;
  currentActIndex: number;
  chapters: PlayerPdfBookletChapter[];
};

type PlayerPdfReadingInternal = PlayerPdfReadingView & {
  localPath: string;
};

export class PlayerPdfReadingError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "PlayerPdfReadingError";
  }
}

export async function getPlayerPdfReadingForSnapshot(
  gameSessionId: string
): Promise<PlayerPdfReadingSnapshotView | null> {
  const session = await prisma.gameSession.findUnique({
    where: { id: gameSessionId },
    include: { scriptPackage: true }
  });

  if (!session) {
    throw new PlayerPdfReadingError("GameSession 不存在。", 404);
  }

  if (
    !session.runtimeDefinitionId &&
    (!session.scriptPackageId || session.scriptPackage?.slug === DEMO_SCRIPT_PACKAGE_SLUG)
  ) {
    return null;
  }

  try {
    const roleId = session.userRoleId;
    const actIndex = Number(session.currentActId.match(/^runtime_act_(\d+)$/)?.[1]);
    const sources = roleId && session.runtimeDefinitionId ? await getRuntimeReadingSourcesForGameSession({ gameSessionId, roleName: roleId, actIndex }) : null;
    const receipts = fromJsonValue<ReadingReceipt[]>(session.readingReceiptsJson, []);
    const documents: PlayerPdfReadingDocument[] = [];
    const views: PlayerPdfReadingInternal[] = [];
    for (const source of sources?.displays ?? []) {
      const v = await getPlayerDisplaySectionForReading({ gameSessionId, sectionId: source.sourceDocumentSectionId });
      views.push(v);
      documents.push({ sectionId: v.sectionId, assetId: v.assetId, originalName: v.originalName, pdfUrl: v.pdfUrl,
        pageStart: v.pageStart, pageEnd: v.pageEnd, readingOrder: source.readingOrder ?? 0, required: source.required !== false,
        completed: receipts.some(r => r.definitionId === session.runtimeDefinitionId && r.roleId === roleId && r.actId === session.currentActId && r.sectionId === v.sectionId) ||
          !source.bookKey && fromJsonValue<string[]>(session.userReadActIds, []).includes(session.currentActId) });
    }
    const next = documents.find(d => d.required && !d.completed) ?? documents[0];
    const view = views.find(v => v.sectionId === next?.sectionId) ?? await getPlayerDisplaySectionForReading({ gameSessionId });
    const { localPath: _localPath, ...safeView } = view;
    return { ...safeView, ...(documents.length ? { documents } : {}) };
  } catch (error) {
    if (error instanceof PlayerPdfReadingError && error.statusCode === 404) {
      const context = getCurrentReadingContext(
        await getScriptForGameSession(gameSessionId),
        session.userRoleId,
        session.currentActId
      );

      if (!context) {
        throw error;
      }

      return {
        status: "not_configured",
        roleId: context.roleId,
        roleName: context.roleName,
        actIndex: context.currentActIndex + 1,
        actTitle: context.actTitle,
        message: "当前角色当前幕尚未配置 PDF 读本，请回到剧本管理页完成 player_display 分幕。"
      };
    }

    throw error;
  }
}

// The reader page deliberately resolves every displayed section through the
// same per-section guard as the in-game reader.  The list itself therefore
// cannot turn a permitted past act into a shortcut around branch conditions.
export async function getPlayerPdfBookletForReading(
  gameSessionId: string
): Promise<PlayerPdfBookletView> {
  const session = await prisma.gameSession.findUnique({
    where: { id: gameSessionId },
    include: { scriptPackage: true }
  });

  if (!session) throw new PlayerPdfReadingError("GameSession 不存在。", 404);
  if (!session.scriptPackageId || !session.scriptPackage) {
    throw new PlayerPdfReadingError("当前游戏没有关联 ScriptPackage。", 404);
  }
  if (!session.runtimeDefinitionId && session.scriptPackage.slug === DEMO_SCRIPT_PACKAGE_SLUG) {
    throw new PlayerPdfReadingError("Demo 剧本使用文本读本，不使用 PDF 读本。", 404);
  }

  const script = await getScriptForGameSession(gameSessionId);
  const context = getCurrentReadingContext(script, session.userRoleId, session.currentActId);
  if (!context) throw new PlayerPdfReadingError("当前会话尚未选择玩家角色，不能读取角色 PDF。", 403);

  const candidateSections: Array<{ actIndex: number; sourceDocumentSectionId?: string; readingOrder?: number; required?: boolean }> = session.runtimeDefinitionId
    ? ((await getRuntimeReadingSourcesForGameSession({ gameSessionId, roleName: context.roleId }))?.displays ?? []).map(source => ({
        actIndex: source.actIndex,
        sourceDocumentSectionId: source.sourceDocumentSectionId,
        readingOrder: source.readingOrder,
        required: source.required
      }))
    : script.acts.slice(0, context.currentActIndex + 1).map((_, index) => ({ actIndex: index + 1 }));
  const chapters = new Map<number, PlayerPdfBookletChapter>();

  for (const candidate of candidateSections) {
    try {
      const view = await getPlayerDisplaySectionForReading({
        gameSessionId,
        roleName: context.roleName,
        actIndex: candidate.actIndex,
        sectionId: candidate.sourceDocumentSectionId
      });
      const chapter = chapters.get(view.actIndex) ?? {
        actIndex: view.actIndex,
        actTitle: view.actTitle,
        documents: []
      };
      chapter.documents.push({
        sectionId: view.sectionId,
        assetId: view.assetId,
        originalName: view.originalName,
        pdfUrl: view.pdfUrl,
        pageStart: 1,
        pageEnd: view.pageEnd - view.pageStart + 1,
        readingOrder: candidate.readingOrder ?? 0,
        required: candidate.required !== false,
        completed: false
      });
      chapters.set(view.actIndex, chapter);
    } catch (error) {
      // A legacy package can omit a past PDF.  It is not a permission grant,
      // so leave it out; any authorization or integrity error remains visible.
      if (!session.runtimeDefinitionId && error instanceof PlayerPdfReadingError && error.statusCode === 404) continue;
      throw error;
    }
  }

  return {
    roleId: context.roleId,
    roleName: context.roleName,
    currentActIndex: context.currentActIndex + 1,
    chapters: [...chapters.values()]
      .map(chapter => ({ ...chapter, documents: chapter.documents.sort((a, b) => a.readingOrder - b.readingOrder || a.originalName.localeCompare(b.originalName, "zh-CN")) }))
      .sort((a, b) => a.actIndex - b.actIndex)
  };
}

export async function getPlayerDisplaySectionForReading(input: {
  gameSessionId: string;
  roleName?: string | null;
  actIndex?: number | null;
  sectionId?: string | null;
}): Promise<PlayerPdfReadingInternal> {
  const session = await prisma.gameSession.findUnique({
    where: { id: input.gameSessionId },
    include: { scriptPackage: true }
  });

  if (!session) {
    throw new PlayerPdfReadingError("GameSession 不存在。", 404);
  }

  if (!session.scriptPackageId || !session.scriptPackage) {
    throw new PlayerPdfReadingError("当前游戏没有关联 ScriptPackage。", 404);
  }

  if (!session.runtimeDefinitionId && session.scriptPackage.slug === DEMO_SCRIPT_PACKAGE_SLUG) {
    throw new PlayerPdfReadingError("Demo 剧本使用文本读本，不使用 PDF 读本。", 404);
  }

  const script = await getScriptForGameSession(input.gameSessionId);
  const context = getCurrentReadingContext(script, session.userRoleId, session.currentActId);

  if (!context) {
    throw new PlayerPdfReadingError("当前会话尚未选择玩家角色，不能读取角色 PDF。", 403);
  }

  const requestedRoleName = input.roleName?.trim() || context.roleName;

  if (requestedRoleName !== context.roleName && requestedRoleName !== context.roleId) {
    throw new PlayerPdfReadingError("不能读取其他角色的 PDF 读本。", 403);
  }

  const requestedActIndex = input.actIndex ?? context.currentActIndex + 1;

  if (!Number.isInteger(requestedActIndex) || requestedActIndex <= 0) {
    throw new PlayerPdfReadingError("actIndex 必须是正整数。", 400);
  }

  if (requestedActIndex > context.currentActIndex + 1) {
    throw new PlayerPdfReadingError("不能读取当前幕之后的 PDF 读本。", 403);
  }

  const requestedAct = session.runtimeDefinitionId ? script.acts.find(a => a.act_id === `runtime_act_${requestedActIndex}`) : script.acts[requestedActIndex - 1];

  if (!requestedAct) {
    throw new PlayerPdfReadingError("请求的幕不存在。", 404);
  }

  const runtimePlayerDisplay = await getRuntimePlayerDisplayForGameSession({
    gameSessionId: input.gameSessionId,
    roleName: context.roleId,
    actIndex: requestedActIndex, sectionId: input.sectionId
  });
  if (session.runtimeDefinitionId && !runtimePlayerDisplay) throw new PlayerPdfReadingError("当前没有获授权的这份读本。", 403);
  const section = runtimePlayerDisplay
    ? await prisma.documentSection.findFirst({
        where: {
          id: runtimePlayerDisplay.sourceDocumentSectionId,
          scriptPackageId: session.scriptPackageId,
          sectionType: "role_act",
          sectionPurpose: DocumentSectionPurpose.PLAYER_DISPLAY,
          roleName: context.roleId,
          actIndex: requestedActIndex
        },
        include: {
          uploadedAsset: true
        }
      })
    : await prisma.documentSection.findFirst({
        where: {
          scriptPackageId: session.scriptPackageId,
          sectionType: "role_act",
          sectionPurpose: DocumentSectionPurpose.PLAYER_DISPLAY,
          roleName: { in: [context.roleName, context.roleId] },
          isActive: true, parsedDocument: { isActive: true },
          actIndex: requestedActIndex
        },
        include: {
          uploadedAsset: true
        },
        orderBy: { orderIndex: "asc" }
      });

  if (!section || input.sectionId && section.id !== input.sectionId) {
    throw new PlayerPdfReadingError(
      "当前角色当前幕尚未配置 PDF 读本，请回到剧本管理页完成 player_display 分幕。",
      404
    );
  }

  if (
    (section.uploadedAsset.kind !== UploadedAssetKind.ROLE_BOOKLET && !(runtimePlayerDisplay?.pdfOnly && section.uploadedAsset.kind === UploadedAssetKind.CLUE)) ||
    (section.uploadedAsset.assetPurpose !== UploadedAssetPurpose.PLAYER_DISPLAY &&
      section.uploadedAsset.assetPurpose !== UploadedAssetPurpose.BOTH) ||
    !isPdfAsset(section.uploadedAsset)
  ) {
    throw new PlayerPdfReadingError("当前 player_display section 未关联有效的 PDF 角色剧本。", 404);
  }

  if (runtimePlayerDisplay && (section.uploadedAssetId !== runtimePlayerDisplay.uploadedAssetId ||
    section.pageStart !== runtimePlayerDisplay.pageStart || section.pageEnd !== runtimePlayerDisplay.pageEnd))
    throw new PlayerPdfReadingError("读本来源已变化，不能读取与绑定定义不同的页面。", 409);
  if (!section.pageStart || !section.pageEnd) {
    throw new PlayerPdfReadingError("当前 PDF 读本缺少页码范围。", 404);
  }

  return {
    status: "available",
    roleId: context.roleId,
    roleName: context.roleName,
    actIndex: requestedActIndex,
    actTitle: requestedAct.title,
    sectionId: section.id,
    assetId: section.uploadedAssetId,
    originalName: section.uploadedAsset.originalName,
    pageStart: section.pageStart,
    pageEnd: section.pageEnd,
    pdfUrl: `/api/games/${input.gameSessionId}/player-display/pdf?roleName=${encodeURIComponent(
      context.roleName
    )}&actIndex=${requestedActIndex}&sectionId=${encodeURIComponent(section.id)}`,
    rangeRestriction: "ui_page_hint",
    localPath: section.uploadedAsset.localPath
  };
}

export async function readPlayerDisplayPdfForReading(input: {
  gameSessionId: string;
  roleName?: string | null;
  actIndex?: number | null;
  sectionId?: string | null;
}): Promise<{
  fileName: string;
  bytes: Buffer;
  pageStart: number;
  pageEnd: number;
}> {
  const view = await getPlayerDisplaySectionForReading(input);
  const absolutePath = resolveSafeStoragePath(view.localPath);
  const bytes = await readFile(absolutePath);

  return {
    fileName: basename(view.originalName) || "role-booklet.pdf",
    bytes,
    pageStart: view.pageStart,
    pageEnd: view.pageEnd
  };
}

function getCurrentReadingContext(
  script: Script,
  userRoleId: string | null,
  currentActId: string
): {
  roleId: RoleId;
  roleName: string;
  currentActIndex: number;
  actTitle: string;
} | null {
  if (!userRoleId) {
    return null;
  }

  const role = script.roles.find((candidate) => candidate.role_id === userRoleId);
  const currentActIndex = script.acts.findIndex((act) => act.act_id === currentActId);
  const currentAct = currentActIndex === -1 ? null : script.acts[currentActIndex];

  if (!role || !currentAct) {
    return null;
  }

  return {
    roleId: role.role_id,
    roleName: role.name,
    currentActIndex: Number(currentActId.match(/^runtime_act_(\d+)$/)?.[1]) ? Number(currentActId.match(/^runtime_act_(\d+)$/)![1]) - 1 : currentActIndex,
    actTitle: currentAct.title
  };
}

function isPdfAsset(asset: { mimeType: string | null; originalName: string }): boolean {
  return asset.mimeType === "application/pdf" || asset.originalName.toLowerCase().endsWith(".pdf");
}

function resolveSafeStoragePath(localPath: string): string {
  const storageRoot = resolve(process.cwd(), "storage");
  const absolutePath = resolve(process.cwd(), localPath);

  if (absolutePath !== storageRoot && !absolutePath.startsWith(`${storageRoot}${sep}`)) {
    throw new PlayerPdfReadingError("PDF 文件路径不在受控 storage 目录内。", 500);
  }

  return absolutePath;
}

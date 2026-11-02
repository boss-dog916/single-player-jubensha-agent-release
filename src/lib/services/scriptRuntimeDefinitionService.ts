import "server-only";

import {
  DMFlowParseStatus,
  DocumentSectionPurpose,
  RoleActBookletParseStatus,
  ScriptRuntimeDefinitionStatus,
  UploadedAssetKind,
  type ScriptRuntimeDefinition
} from "@prisma/client";
import { prisma } from "@/src/lib/db/prisma";
import type { DMFlowActFlow } from "@/src/lib/services/dmFlowService";
import { fromJsonValue, toJsonInput } from "@/src/lib/services/jsonFields";
import type { DMFlowNode, DMFlowNodeType } from "@/src/lib/schemas/dmFlowSchema";
import { normalizeDMFlowForRuntime } from "@/src/lib/services/dmFlowNormalization";
import { validateDMLifecycle } from "@/src/lib/services/dmLifecycleValidation";
import { getDMFlow } from "@/src/lib/services/dmFlowService";
import { compileManualAct, combineSemanticFragments, VALIDATOR_VERSION, type LogicalActControl } from "@/src/lib/services/manualControlCompiler";

import { readingMetadata, type ReadingMetadata } from "./runtimeReadingSources";
import { validateReadingSources } from "./runtimeReadingValidation";

const COMPILER_VERSION = 3;

export type RuntimeRole = {
  roleName: string;
  displayName: string;
  isUserSelectable: boolean;
};

export type RuntimeAct = {
  actIndex: number;
  title?: string;
  modelPolicy?: "disabled";
  control?: LogicalActControl;
};

export type RuntimeRoleBooklet = ReadingMetadata & {
  roleName: string;
  actIndex: number;
  privateText: string;
  mustShare: string[];
  mayShare: string[];
  mustNotShare: string[];
  emotionalPoints: string[];
  relationshipPoints: string[];
  timelineFragments: string[];
  sourceRoleActBookletId: string;
};

export type RuntimeDMFlow = {
  openingNodes: DMFlowNode[];
  actFlows: Array<{
    actIndex: number;
    title?: string;
    nodes: DMFlowNode[];
    sourceSectionId?: string;
    sourceEvidence?: import("@/src/lib/schemas/manualSemanticSchema").SourceEvidence;
  }>;
  endingNodes: DMFlowNode[];
};

export type RuntimePlayerDisplaySection = ReadingMetadata & {
  roleName: string;
  actIndex: number;
  sourceDocumentSectionId: string;
  uploadedAssetId: string;
  pageStart: number;
  pageEnd: number;
};

export type RuntimeClue = {
  clueId: string;
  title: string;
  source: "dm_flow_clue_ref" | "uploaded_asset" | "manual_placeholder";
  assetId?: string;
  pdf?: { sourceDocumentSectionId: string; uploadedAssetId: string; pageStart: number; pageEnd: number };
  rawText?: string;
  releaseMode: "fixed_at_node" | "dm_decision" | "user_choice" | "manual" | "unknown";
  releaseActIndex?: number;
  visibility: "public" | "private" | "unknown";
  targetRoleNames: string[];
};

export type RuntimeSafetyRules = {
  aiPlayerReadScope: "own_role_current_and_unlocked_acts_only";
  playerReadScope: "own_role_pdf_current_and_unlocked_acts_only";
  dmOutputScope: "current_stage_public_safe_only";
  publicStoryBoardSource: "public_messages_only";
};

export type RuntimeSourceRefs = {
  roleBookletIds: string[];
  dmFlowId?: string;
  playerDisplaySectionIds: string[];
  uploadedAssetIds: string[];
};

export type ScriptRuntimeDefinitionJson = {
  scriptPackageId: string;
  title: string;
  endingMode: "story_reconstruction";
  roles: RuntimeRole[];
  acts: RuntimeAct[];
  roleBooklets: RuntimeRoleBooklet[];
  dmFlow: RuntimeDMFlow | null;
  playerDisplay: RuntimePlayerDisplaySection[];
  clues: RuntimeClue[];
  safety: RuntimeSafetyRules;
  sourceRefs: RuntimeSourceRefs;
  compileMeta: {
    compiledAt: string;
    compilerVersion: number;
    warnings: string[];
  };
};

export type RuntimeValidationIssue = {
  code: string;
  message: string;
  path?: string;
  severity: "error" | "warning";
};

export type RuntimeValidationReport = {
  status: "valid" | "warning" | "invalid";
  errors: RuntimeValidationIssue[];
  warnings: RuntimeValidationIssue[];
  validatorVersion?: string;
  validatedAt?: string;
};

export type ScriptRuntimeDefinitionView = {
  id: string;
  scriptPackageId: string;
  version: number;
  status: RuntimeValidationReport["status"];
  definition: ScriptRuntimeDefinitionJson;
  validationReport: RuntimeValidationReport;
  storedValidationReport: RuntimeValidationReport;
  compiledAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type ScriptRuntimeDefinitionSummary = {
  id: string;
  scriptPackageId: string;
  version: number;
  status: RuntimeValidationReport["status"];
  compiledAt: Date;
  validationReport: RuntimeValidationReport;
  storedValidationReport: RuntimeValidationReport;
  counts: {
    roles: number;
    acts: number;
    roleBooklets: number;
    dmFlowActFlows: number;
    playerDisplay: number;
    clues: number;
  };
  endingMode: ScriptRuntimeDefinitionJson["endingMode"];
};

export type RuntimeCompileSummary = ScriptRuntimeDefinitionSummary & {
  definitionId: string;
};

export async function getLatestScriptRuntimeDefinition(
  scriptPackageId: string
): Promise<ScriptRuntimeDefinitionView | null> {
  const record = await prisma.scriptRuntimeDefinition.findFirst({
    where: { scriptPackageId },
    orderBy: { version: "desc" }
  });

  return record ? toRuntimeDefinitionView(record) : null;
}

export async function getScriptRuntimeDefinition(
  runtimeDefinitionId: string
): Promise<ScriptRuntimeDefinitionView> {
  const record = await prisma.scriptRuntimeDefinition.findUnique({
    where: { id: runtimeDefinitionId }
  });

  if (!record) {
    throw new Error(`RuntimeDefinition "${runtimeDefinitionId}" 不存在。`);
  }

  return toRuntimeDefinitionView(record);
}

export async function getLatestScriptRuntimeDefinitionSummary(
  scriptPackageId: string
): Promise<ScriptRuntimeDefinitionSummary | null> {
  const latest = await getLatestScriptRuntimeDefinition(scriptPackageId);

  return latest ? toRuntimeDefinitionSummary(latest) : null;
}

export async function compileScriptPackageToRuntimeDefinition(
  scriptPackageId: string
): Promise<RuntimeCompileSummary> {
  const scriptPackage = await prisma.scriptPackage.findUnique({
    where: { id: scriptPackageId }
  });

  if (!scriptPackage) {
    throw new Error("ScriptPackage not found.");
  }

  const sourceSnapshot = await compileSourceSnapshot(prisma, scriptPackageId);
  const [roleBookletRecords, dmFlowRecord, playerDisplaySections, clueAssets] =
    await Promise.all([
      prisma.roleActBooklet.findMany({
        where: {
          scriptPackageId,
          parseStatus: RoleActBookletParseStatus.SUCCESS,
          sourceSection: { isActive: true, parsedDocument: { isActive: true } }
        },
        include: { sourceSection: { include: { uploadedAsset: true } } },
        orderBy: [{ roleName: "asc" }, { actIndex: "asc" }, { updatedAt: "desc" }]
      }),
      getDMFlow(scriptPackageId),
      prisma.documentSection.findMany({
        where: {
          scriptPackageId,
          sectionType: "role_act",
          sectionPurpose: DocumentSectionPurpose.PLAYER_DISPLAY,
          isActive: true, parsedDocument: { isActive: true }
        },
        include: { uploadedAsset: true },
        orderBy: [{ roleName: "asc" }, { actIndex: "asc" }]
      }),
      prisma.uploadedAsset.findMany({
        where: {
          scriptPackageId,
          kind: UploadedAssetKind.CLUE
        },
        orderBy: { createdAt: "asc" }
      })
    ]);

  const compileWarnings: RuntimeValidationIssue[] = [];
  const roleBooklets = compileRoleBooklets(roleBookletRecords, compileWarnings);
  const roles = compileRoles(roleBooklets);
  const dmFlow = dmFlowRecord ? compileDMFlow({ openingNodesJson: toJsonInput(dmFlowRecord.openingNodes),
    actFlowsJson: toJsonInput(dmFlowRecord.actFlows), endingNodesJson: toJsonInput(dmFlowRecord.endingNodes) }) : null;
  const semanticCompiled = combineSemanticFragments(dmFlowRecord?.semanticActs ?? []).map(compileManualAct);
  if (dmFlow) for (const compiled of semanticCompiled) dmFlow.actFlows.push({ actIndex: compiled.control.actIndex, nodes: compiled.nodes });
  const playerDisplay = compilePlayerDisplay(playerDisplaySections);
  const acts = compileActs(roleBooklets, dmFlow, playerDisplay);
  for (const act of acts) {
    const matches = semanticCompiled.filter(c => c.control.actIndex === act.actIndex);
    if (matches.length === 1) act.control = matches[0].control;
  }
  for (const warning of dmFlowRecord?.warnings ?? []) compileWarnings.push(issue("DM_SOURCE_WARNING", warning, "dmFlow", "warning"));
  if (dmFlowRecord?.format === "legacy_nodes" || dmFlowRecord?.format === "mixed") compileWarnings.push(issue("LEGACY_DM_FORMAT", "Legacy node adapter used; conversation policy was not newly inferred.", "dmFlow", "warning"));
  const clueResult = compileClues(dmFlow, clueAssets, compileWarnings);
  const compiledAt = new Date();
  const definition: ScriptRuntimeDefinitionJson = {
    scriptPackageId,
    title: scriptPackage.title,
    endingMode: "story_reconstruction",
    roles,
    acts,
    roleBooklets,
    dmFlow,
    playerDisplay,
    clues: clueResult.clues,
    safety: {
      aiPlayerReadScope: "own_role_current_and_unlocked_acts_only",
      playerReadScope: "own_role_pdf_current_and_unlocked_acts_only",
      dmOutputScope: "current_stage_public_safe_only",
      publicStoryBoardSource: "public_messages_only"
    },
    sourceRefs: {
      roleBookletIds: roleBooklets.map((booklet) => booklet.sourceRoleActBookletId),
      dmFlowId: dmFlowRecord?.id,
      playerDisplaySectionIds: playerDisplay.map((section) => section.sourceDocumentSectionId),
      uploadedAssetIds: Array.from(
        new Set([
          ...playerDisplay.map((section) => section.uploadedAssetId),
          ...clueResult.uploadedAssetIds
        ])
      )
    },
    compileMeta: {
      compiledAt: compiledAt.toISOString(),
      compilerVersion: COMPILER_VERSION,
      warnings: compileWarnings.map((warning) => warning.message)
    }
  };
  const validationReport = mergeCompileWarnings(
    validateScriptRuntimeDefinition(definition),
    compileWarnings
  );
  const record = await prisma.$transaction(async tx => {
    if (sourceSnapshot !== await compileSourceSnapshot(tx, scriptPackageId)) throw new Error("编译期间来源或解析产物已变化，请重新编译当前 revision。");
    const latest = await tx.scriptRuntimeDefinition.findFirst({ where: { scriptPackageId }, orderBy: { version: "desc" } });
    return tx.scriptRuntimeDefinition.create({
    data: {
      scriptPackageId,
      version: (latest?.version ?? 0) + 1,
      status: toPrismaStatus(validationReport.status),
      definitionJson: toJsonInput(definition),
      validationReportJson: toJsonInput(validationReport),
      compiledAt
    }
    });
  });
  const view = toRuntimeDefinitionView(record);

  return {
    ...toRuntimeDefinitionSummary(view),
    definitionId: record.id
  };
}

async function compileSourceSnapshot(db: Pick<typeof prisma, "documentSection" | "dMParseArtifact" | "dMFlow" | "roleActBooklet">, scriptPackageId: string): Promise<string> {
  const sections = await db.documentSection.findMany({ where: { scriptPackageId, isActive: true, parsedDocument: { isActive: true } },
    orderBy: { id: "asc" }, select: { id: true, metadataJson: true, uploadedAsset: { select: { metadataJson: true } }, sectionSetRevision: true, parsedDocument: { select: { id: true, documentRevision: true, sectionSetRevision: true } } } });
  const artifacts = await db.dMParseArtifact.findMany({ where: { scriptPackageId, status: "active" }, orderBy: { id: "asc" }, select: { id: true } });
  const flow = await db.dMFlow.findUnique({ where: { scriptPackageId }, select: { updatedAt: true } });
  const booklets = await db.roleActBooklet.findMany({ where: { scriptPackageId }, orderBy: { id: "asc" }, select: { id: true, updatedAt: true } });
  return JSON.stringify({ sections, artifacts, flow, booklets });
}

export function validateScriptRuntimeDefinition(
  definition: ScriptRuntimeDefinitionJson
): RuntimeValidationReport {
  const errors: RuntimeValidationIssue[] = [];
  const warnings: RuntimeValidationIssue[] = [];
  for (const finding of validateDMLifecycle(definition)) {
    (finding.fatal ? errors : warnings).push(issue(finding.code, finding.message, "dmFlow", finding.fatal ? "error" : "warning"));
  }
  const roles = definition.roles.map((role) => role.roleName);
  const acts = definition.acts.map((act) => act.actIndex);

  if (definition.roles.length === 0) {
    errors.push(issue("NO_ROLES", "RuntimeDefinition 没有角色。", "roles", "error"));
  }

  if (definition.acts.length === 0) {
    errors.push(issue("NO_ACTS", "RuntimeDefinition 没有幕。", "acts", "error"));
  }

  if (definition.roleBooklets.length === 0) {
    errors.push(issue("NO_ROLE_BOOKLETS", "RuntimeDefinition 没有 RoleActBooklet。", "roleBooklets", "error"));
  }

  if (!definition.dmFlow) {
    errors.push(issue("NO_DM_FLOW", "RuntimeDefinition 缺少 DMFlow。", "dmFlow", "error"));
  }

  if (definition.endingMode !== "story_reconstruction") {
    errors.push(
      issue(
        "INVALID_ENDING_MODE",
        "endingMode 必须为 story_reconstruction。",
        "endingMode",
        "error"
      )
    );
  }

  for (const [index, booklet] of definition.roleBooklets.entries()) {
    if (!booklet.privateText.trim()) {
      errors.push(
        issue(
          "EMPTY_PRIVATE_TEXT",
          `${booklet.roleName} 第 ${booklet.actIndex} 幕 privateText 为空。`,
          `roleBooklets.${index}.privateText`,
          "error"
        )
      );
    }

    if (booklet.mustShare.length === 0) {
      warnings.push(
        issue(
          "EMPTY_MUST_SHARE",
          `${booklet.roleName} 第 ${booklet.actIndex} 幕 mustShare 为空。`,
          `roleBooklets.${index}.mustShare`,
          "warning"
        )
      );
    }
  }

  for (const roleName of roles) {
    for (const actIndex of acts) {
      if (!definition.roleBooklets.some((booklet) => booklet.roleName === roleName && booklet.actIndex === actIndex) &&
        !(definition.acts.find(a => a.actIndex === actIndex)?.modelPolicy === "disabled" && definition.playerDisplay.some(p => p.pdfOnly && p.roleName === roleName && p.actIndex === actIndex))) {
        errors.push(
          issue(
            "MISSING_ROLE_BOOKLET",
            `${roleName} 缺少第 ${actIndex} 幕 RoleActBooklet。`,
            `roleBooklets`,
            "error"
          )
        );
      }

      if (!definition.playerDisplay.some((section) => section.roleName === roleName && section.actIndex === actIndex)) {
        warnings.push(
          issue(
            "MISSING_PLAYER_DISPLAY",
            `${roleName} 缺少第 ${actIndex} 幕玩家 PDF section。`,
            "playerDisplay",
            "warning"
          )
        );
      }
    }
  }

  if (definition.dmFlow) {
    if (definition.dmFlow.openingNodes.length === 0) {
      warnings.push(issue("EMPTY_OPENING_NODES", "DMFlow openingNodes 为空。", "dmFlow.openingNodes", "warning"));
    }

    if (definition.dmFlow.endingNodes.length === 0) {
      warnings.push(issue("EMPTY_ENDING_NODES", "DMFlow endingNodes 为空。", "dmFlow.endingNodes", "warning"));
    }

    for (const actIndex of acts) {
      if (!definition.dmFlow.actFlows.some((actFlow) => actFlow.actIndex === actIndex)) {
        warnings.push(
          issue(
            "MISSING_DM_ACT_FLOW",
            `第 ${actIndex} 幕缺少 DMFlow actFlow。`,
            "dmFlow.actFlows",
            "warning"
          )
        );
      }
    }
  }

  if (definition.playerDisplay.length === 0) {
    warnings.push(issue("NO_PLAYER_DISPLAY", "RuntimeDefinition 没有 playerDisplay section。", "playerDisplay", "warning"));
  }

  for (const [index, section] of definition.playerDisplay.entries()) {
    if (!section.pageStart || !section.pageEnd) {
      warnings.push(
        issue(
          "PLAYER_DISPLAY_PAGE_RANGE_MISSING",
          `${section.roleName} 第 ${section.actIndex} 幕 playerDisplay 缺少页码范围。`,
          `playerDisplay.${index}`,
          "warning"
        )
      );
    } else if (section.pageStart > section.pageEnd) {
      errors.push(
        issue(
          "PLAYER_DISPLAY_PAGE_RANGE_INVALID",
          `${section.roleName} 第 ${section.actIndex} 幕 playerDisplay pageStart 大于 pageEnd。`,
          `playerDisplay.${index}`,
          "error"
        )
      );
    }
  }

  for (const [index, clue] of definition.clues.entries()) {
    if (!clue.assetId) {
      warnings.push(
        issue(
          "CLUE_ASSET_UNMATCHED",
          `线索 ${clue.title} 暂未匹配 UploadedAsset。`,
          `clues.${index}.assetId`,
          "warning"
        )
      );
    }
  }

  errors.push(...validateReadingSources(definition).map(message => issue("INVALID_READING_SOURCE", message, "roleBooklets/playerDisplay", "error")));

  if (containsAbsoluteStoragePath(definition)) {
    errors.push(
      issue(
        "ABSOLUTE_STORAGE_PATH_LEAK",
        "RuntimeDefinition 中包含 storage 绝对路径。",
        undefined,
        "error"
      )
    );
  }

  return {
    status: errors.length > 0 ? "invalid" : warnings.length > 0 ? "warning" : "valid",
    errors,
    warnings,
    validatorVersion: VALIDATOR_VERSION, validatedAt: new Date().toISOString()
  };
}

function compileRoleBooklets(
  records: Awaited<ReturnType<typeof prisma.roleActBooklet.findMany>>,
  warnings: RuntimeValidationIssue[]
): RuntimeRoleBooklet[] {
  // Every active source is a distinct reading unit; never collapse branches.
  return records
    .sort((left, right) => left.roleName.localeCompare(right.roleName, "zh-CN") || left.actIndex - right.actIndex)
    .map((record) => ({
      roleName: record.roleName,
      actIndex: record.actIndex,
      privateText: record.privateText,
      mustShare: fromJsonValue<string[]>(record.mustShareJson, []),
      mayShare: fromJsonValue<string[]>(record.mayShareJson, []),
      mustNotShare: fromJsonValue<string[]>(record.mustNotShareJson, []),
      emotionalPoints: fromJsonValue<string[]>(record.emotionalPointsJson, []),
      relationshipPoints: fromJsonValue<string[]>(record.relationshipPointsJson, []),
      timelineFragments: fromJsonValue<string[]>(record.timelineFragmentsJson, []),
      sourceRoleActBookletId: record.id,
      ...readingMetadata((record as typeof record & { sourceSection?: { metadataJson: string | null; uploadedAsset?: { metadataJson: string | null } } }).sourceSection?.metadataJson,
        (record as typeof record & { sourceSection?: { uploadedAsset?: { metadataJson: string | null } } }).sourceSection?.uploadedAsset?.metadataJson)
    }));
}

function compileRoles(roleBooklets: RuntimeRoleBooklet[]): RuntimeRole[] {
  return Array.from(new Set(roleBooklets.map((booklet) => booklet.roleName)))
    .sort((left, right) => left.localeCompare(right, "zh-CN"))
    .map((roleName) => ({
      roleName,
      displayName: roleName,
      isUserSelectable: true
    }));
}

function compileActs(
  roleBooklets: RuntimeRoleBooklet[],
  dmFlow: RuntimeDMFlow | null,
  playerDisplay: RuntimePlayerDisplaySection[]
): RuntimeAct[] {
  const actIndexes = new Set<number>();

  roleBooklets.forEach((booklet) => actIndexes.add(booklet.actIndex));
  dmFlow?.actFlows.forEach((actFlow) => actIndexes.add(actFlow.actIndex));
  playerDisplay.forEach((section) => actIndexes.add(section.actIndex));

  return Array.from(actIndexes)
    .sort((left, right) => left - right)
    .map((actIndex) => ({
      actIndex,
      title: dmFlow?.actFlows.find((actFlow) => actFlow.actIndex === actIndex)?.title
    }));
}

function compileDMFlow(record: {
  openingNodesJson: string;
  actFlowsJson: string;
  endingNodesJson: string;
}): RuntimeDMFlow {
  const actFlows = fromJsonValue<DMFlowActFlow[]>(record.actFlowsJson, []);
  const normalized = normalizeDMFlowForRuntime({
    openingNodes: fromJsonValue<unknown[]>(record.openingNodesJson, []),
    actFlows: actFlows.map((actFlow) => ({
      actIndex: actFlow.actIndex,
      title: actFlow.title,
      nodes: Array.isArray(actFlow.nodes) ? actFlow.nodes : [],
      warnings: actFlow.warnings,
      sourceSectionId: actFlow.sourceSectionId,
      sourceEvidence: actFlow.sourceEvidence
    })),
    endingNodes: fromJsonValue<unknown[]>(record.endingNodesJson, [])
  });

  return {
    openingNodes: normalized.openingNodes,
    actFlows: normalized.actFlows.map((actFlow) => ({
      actIndex: actFlow.actIndex,
      title: actFlow.title,
      nodes: actFlow.nodes,
      sourceSectionId: actFlow.sourceSectionId, sourceEvidence: actFlow.sourceEvidence
    })),
    endingNodes: normalized.endingNodes
  };
}

function compilePlayerDisplay(
  sections: Awaited<ReturnType<typeof prisma.documentSection.findMany>>
): RuntimePlayerDisplaySection[] {
  return sections
    .filter((section) => section.roleName && section.actIndex && section.pageStart && section.pageEnd)
    .map((section) => ({
      roleName: section.roleName ?? "",
      actIndex: section.actIndex ?? 0,
      sourceDocumentSectionId: section.id,
      uploadedAssetId: section.uploadedAssetId,
      pageStart: section.pageStart ?? 0,
      pageEnd: section.pageEnd ?? 0,
      ...readingMetadata(section.metadataJson, (section as typeof section & { uploadedAsset?: { metadataJson: string | null } }).uploadedAsset?.metadataJson)
    }));
}

function compileClues(
  dmFlow: RuntimeDMFlow | null,
  clueAssets: Awaited<ReturnType<typeof prisma.uploadedAsset.findMany>>,
  warnings: RuntimeValidationIssue[]
): { clues: RuntimeClue[]; uploadedAssetIds: string[] } {
  const clues: RuntimeClue[] = [];
  const uploadedAssetIds = new Set<string>();

  for (const asset of clueAssets) {
    uploadedAssetIds.add(asset.id);
    clues.push({
      clueId: `asset_${asset.id}`,
      title: asset.originalName,
      source: "uploaded_asset",
      assetId: asset.id,
      releaseMode: "unknown",
      visibility: "unknown",
      targetRoleNames: []
    });
  }

  for (const node of allDMFlowNodes(dmFlow)) {
    if (node.type !== "clue_release") {
      continue;
    }

    if (node.clueRefs.length === 0) {
      warnings.push(
        issue(
          "CLUE_RELEASE_EMPTY_REFS",
          `线索发放节点 ${node.title ?? node.nodeId} 缺少 clueRefs。`,
          "dmFlow",
          "warning"
        )
      );
      continue;
    }

    for (const [index, clueRef] of node.clueRefs.entries()) {
      const title = clueRef.title?.trim() || buildClueTitle(clueRef.rawText ?? node.sourceQuote);
      const matchedAsset = clueAssets.find((asset) => title && asset.originalName.includes(title));

      if (matchedAsset) {
        uploadedAssetIds.add(matchedAsset.id);
      } else {
        warnings.push(
          issue(
            "CLUE_ASSET_UNMATCHED",
            `线索 ${title} 暂未匹配 UploadedAsset。`,
            "clues",
            "warning"
          )
        );
      }

      clues.push({
        clueId: `dm_${node.nodeId}_${index + 1}`,
        title,
        source: "dm_flow_clue_ref",
        assetId: matchedAsset?.id,
        rawText: clueRef.rawText ?? node.sourceQuote,
        releaseMode: clueRef.releaseMode,
        releaseActIndex: node.actIndex ?? undefined,
        visibility: clueRef.visibility,
        targetRoleNames: clueRef.targetRoleNames
      });
    }
  }

  return {
    clues,
    uploadedAssetIds: Array.from(uploadedAssetIds)
  };
}

function normalizeDMFlowNodes(nodes: unknown[]): DMFlowNode[] {
  return nodes.map((node, index) => normalizeDMFlowNode(node, index));
}

function normalizeDMFlowNode(value: unknown, index: number): DMFlowNode {
  const record = isRecord(value) ? value : {};
  const nodeId = typeof record.nodeId === "string" && record.nodeId.trim() ? record.nodeId : `legacy_node_${index + 1}`;
  const sourceQuote =
    typeof record.sourceQuote === "string" && record.sourceQuote.trim()
      ? record.sourceQuote
      : typeof record.text === "string" && record.text.trim()
        ? record.text
        : typeof record.fixedLine === "string" && record.fixedLine.trim()
          ? record.fixedLine
          : nodeId;

  return {
    nodeId,
    type: normalizeDMFlowNodeType(record.type),
    actIndex: typeof record.actIndex === "number" && Number.isInteger(record.actIndex) ? record.actIndex : null,
    title: typeof record.title === "string" ? record.title : null,
    text: typeof record.text === "string" ? record.text : null,
    fixedLine: typeof record.fixedLine === "string" ? record.fixedLine : null,
    promptGoal: typeof record.promptGoal === "string" ? record.promptGoal : null,
    targetRoleNames: stringArray(record.targetRoleNames),
    expectedSpeakerRoleNames: stringArray(record.expectedSpeakerRoleNames),
    durationHint: typeof record.durationHint === "string" ? record.durationHint : null,
    orderHint: typeof record.orderHint === "number" && Number.isInteger(record.orderHint) ? record.orderHint : null,
    requiredPublicPoints: stringArray(record.requiredPublicPoints),
    ifMissingPoints: stringArray(record.ifMissingPoints),
    forbiddenReveals: stringArray(record.forbiddenReveals),
    conditionalRules: [],
    guidance: {
      discussionGoal:
        typeof record.promptGoal === "string" ? record.promptGoal : typeof record.text === "string" ? record.text : null,
      requiredPublicPoints: stringArray(record.requiredPublicPoints),
      ifMissingPoints: stringArray(record.ifMissingPoints),
      forbiddenReveals: stringArray(record.forbiddenReveals),
      toneGuidance: null,
      fallbackHint: null
    },
    clueRefs: Array.isArray(record.clueRefs) ? record.clueRefs.map(normalizeClueRef) : [],
    performance: normalizePerformance(record.performance),
    sourceQuote,
    confidence: typeof record.confidence === "number" ? Math.min(1, Math.max(0, record.confidence)) : 0.5,
    warnings: stringArray(record.warnings)
  };
}

function normalizeDMFlowNodeType(value: unknown): DMFlowNodeType {
  const allowed: DMFlowNodeType[] = [
    "fixed_line",
    "reading_start",
    "sharing_round",
    "free_discussion",
    "dm_prompt",
    "performance_instruction",
    "clue_release",
    "act_summary",
    "transition",
    "ending_reveal"
  ];

  return allowed.includes(value as DMFlowNodeType) ? (value as DMFlowNodeType) : "dm_prompt";
}

function normalizeClueRef(value: unknown): DMFlowNode["clueRefs"][number] {
  const record = isRecord(value) ? value : {};

  return {
    title: typeof record.title === "string" ? record.title : null,
    rawText: typeof record.rawText === "string" ? record.rawText : null,
    releaseMode: normalizeReleaseMode(record.releaseMode),
    targetRoleNames: stringArray(record.targetRoleNames),
    visibility: normalizeVisibility(record.visibility)
  };
}

function normalizeReleaseMode(value: unknown): RuntimeClue["releaseMode"] {
  return value === "fixed_at_node" ||
    value === "dm_decision" ||
    value === "user_choice" ||
    value === "manual" ||
    value === "unknown"
    ? value
    : "unknown";
}

function normalizeVisibility(value: unknown): RuntimeClue["visibility"] {
  return value === "public" || value === "private" || value === "unknown" ? value : "unknown";
}

function normalizePerformance(value: unknown): DMFlowNode["performance"] {
  if (!isRecord(value)) {
    return null;
  }

  return {
    kind:
      value.kind === "npc_line" ||
      value.kind === "bgm" ||
      value.kind === "prop" ||
      value.kind === "letter" ||
      value.kind === "audio" ||
      value.kind === "video" ||
      value.kind === "other"
        ? value.kind
        : null,
    instruction: typeof value.instruction === "string" ? value.instruction : null,
    rawText: typeof value.rawText === "string" ? value.rawText : null
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function allDMFlowNodes(dmFlow: RuntimeDMFlow | null): DMFlowNode[] {
  if (!dmFlow) {
    return [];
  }

  return [
    ...dmFlow.openingNodes,
    ...dmFlow.actFlows.flatMap((actFlow) => actFlow.nodes),
    ...dmFlow.endingNodes
  ];
}

function buildClueTitle(rawText: string): string {
  const compact = rawText.replace(/\s+/g, " ").trim();

  return compact.slice(0, 24) || "未命名线索";
}

function mergeCompileWarnings(
  report: RuntimeValidationReport,
  compileWarnings: RuntimeValidationIssue[]
): RuntimeValidationReport {
  const warnings = dedupeIssues([...report.warnings, ...compileWarnings]);

  return {
    ...report,
    status: report.errors.length > 0 ? "invalid" : warnings.length > 0 ? "warning" : "valid",
    errors: dedupeIssues(report.errors),
    warnings
  };
}

function issue(
  code: string,
  message: string,
  path: string | undefined,
  severity: RuntimeValidationIssue["severity"]
): RuntimeValidationIssue {
  return {
    code,
    message,
    path,
    severity
  };
}

function dedupeIssues(issues: RuntimeValidationIssue[]): RuntimeValidationIssue[] {
  const seen = new Set<string>();
  const result: RuntimeValidationIssue[] = [];

  for (const item of issues) {
    const key = `${item.severity}:${item.code}:${item.path ?? ""}:${item.message}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function containsAbsoluteStoragePath(value: unknown): boolean {
  return JSON.stringify(value).includes("/storage/scripts/");
}

function toPrismaStatus(status: RuntimeValidationReport["status"]): ScriptRuntimeDefinitionStatus {
  if (status === "valid") {
    return ScriptRuntimeDefinitionStatus.VALID;
  }

  if (status === "warning") {
    return ScriptRuntimeDefinitionStatus.WARNING;
  }

  return ScriptRuntimeDefinitionStatus.INVALID;
}

function fromPrismaStatus(status: ScriptRuntimeDefinitionStatus): RuntimeValidationReport["status"] {
  if (status === ScriptRuntimeDefinitionStatus.VALID) {
    return "valid";
  }

  if (status === ScriptRuntimeDefinitionStatus.WARNING) {
    return "warning";
  }

  return status === ScriptRuntimeDefinitionStatus.INVALID ? "invalid" : "warning";
}

function toRuntimeDefinitionView(record: ScriptRuntimeDefinition): ScriptRuntimeDefinitionView {
  const definition = fromJsonValue<ScriptRuntimeDefinitionJson>(
    record.definitionJson,
    emptyDefinition(record.scriptPackageId)
  );
  const storedValidationReport = fromJsonValue<RuntimeValidationReport>(
    record.validationReportJson,
    { status: fromPrismaStatus(record.status), errors: [], warnings: [] }
  );
  const validationReport = validateScriptRuntimeDefinition(definition);
  validationReport.warnings.push(...storedValidationReport.warnings.filter(w => !validationReport.warnings.some(current => current.code === w.code && current.message === w.message)));
  if (!validationReport.errors.length && validationReport.warnings.length) validationReport.status = "warning";

  return {
    id: record.id,
    scriptPackageId: record.scriptPackageId,
    version: record.version,
    status: validationReport.status,
    definition,
    validationReport,
    storedValidationReport,
    compiledAt: record.compiledAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function toRuntimeDefinitionSummary(
  view: ScriptRuntimeDefinitionView
): ScriptRuntimeDefinitionSummary {
  return {
    id: view.id,
    scriptPackageId: view.scriptPackageId,
    version: view.version,
    status: view.validationReport.status,
    compiledAt: view.compiledAt,
    validationReport: view.validationReport,
    storedValidationReport: view.storedValidationReport,
    counts: {
      roles: view.definition.roles.length,
      acts: view.definition.acts.length,
      roleBooklets: view.definition.roleBooklets.length,
      dmFlowActFlows: view.definition.dmFlow?.actFlows.length ?? 0,
      playerDisplay: view.definition.playerDisplay.length,
      clues: view.definition.clues.length
    },
    endingMode: view.definition.endingMode
  };
}

function emptyDefinition(scriptPackageId: string): ScriptRuntimeDefinitionJson {
  return {
    scriptPackageId,
    title: "",
    endingMode: "story_reconstruction",
    roles: [],
    acts: [],
    roleBooklets: [],
    dmFlow: null,
    playerDisplay: [],
    clues: [],
    safety: {
      aiPlayerReadScope: "own_role_current_and_unlocked_acts_only",
      playerReadScope: "own_role_pdf_current_and_unlocked_acts_only",
      dmOutputScope: "current_stage_public_safe_only",
      publicStoryBoardSource: "public_messages_only"
    },
    sourceRefs: {
      roleBookletIds: [],
      playerDisplaySectionIds: [],
      uploadedAssetIds: []
    },
    compileMeta: {
      compiledAt: new Date(0).toISOString(),
      compilerVersion: COMPILER_VERSION,
      warnings: []
    }
  };
}

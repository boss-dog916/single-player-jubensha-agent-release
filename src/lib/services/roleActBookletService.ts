import "server-only";

import {
  DocumentSectionPurpose,
  IngestionJobStatus,
  RoleActBookletParseStatus,
  type RoleActBooklet
} from "@prisma/client";
import { prisma } from "@/src/lib/db/prisma";
import { generateStructured } from "@/src/lib/llm/llmClient";
import { buildRoleActBookletPrompt } from "@/src/lib/prompts/roleActBookletPrompt";
import {
  RoleActBookletOutputSchema,
  type RoleActBookletOutput
} from "@/src/lib/schemas/roleActBookletSchema";
import { fromJsonValue, toJsonInput } from "@/src/lib/services/jsonFields";

const ROLE_ACT_BOOKLET_PARSE_TIMEOUT_MS = 180_000;

export type RoleActBookletView = {
  id: string;
  scriptPackageId: string;
  roleName: string;
  actIndex: number;
  sourceSectionId: string;
  privateText: string;
  mustShare: string[];
  mayShare: string[];
  mustNotShare: string[];
  emotionalPoints: string[];
  relationshipPoints: string[];
  timelineFragments: string[];
  parseStatus: RoleActBookletParseStatus;
  parseError: string | null;
  warnings: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type RoleActBookletParseSummary = {
  successCount: number;
  failedCount: number;
  skippedCount: number;
  results: Array<{
    roleName: string;
    actIndex: number;
    sourceSectionId?: string;
    status: "success" | "failed" | "skipped";
    error?: string;
    warning?: string;
  }>;
};

export async function listRoleActBooklets(
  scriptPackageId: string
): Promise<RoleActBookletView[]> {
  const records = await prisma.roleActBooklet.findMany({
    where: { scriptPackageId },
    orderBy: [{ roleName: "asc" }, { actIndex: "asc" }]
  });

  return records.map(toRoleActBookletView);
}

export async function parseRoleActBooklet(input: {
  scriptPackageId: string;
  roleName?: string | null;
  actIndex?: number | null;
  sourceSectionId?: string | null;
}): Promise<RoleActBookletView> {
  const section = await findSourceSection(input);

  if (!section.text.trim()) {
    const record = await upsertFailedBooklet(section, "AI 文本源为空，不能生成结构化角色本。");

    return toRoleActBookletView(record);
  }

  const job = await createRoleActBookletParseJob({
    scriptPackageId: input.scriptPackageId,
    roleName: section.roleName,
    actIndex: section.actIndex,
    sourceSectionId: section.id
  });

  try {
    const result = await generateStructured<RoleActBookletOutput>({
      agentType: "role_act_booklet_parser",
      roleId: section.roleName,
      actId: `act_${section.actIndex}`,
      phase: "ingestion",
      schemaName: "role_act_booklet",
      zodSchema: RoleActBookletOutputSchema,
      messages: buildRoleActBookletPrompt({
        roleName: section.roleName,
        actIndex: section.actIndex,
        sourceText: section.text
      }),
      temperature: 0.2,
      maxOutputTokens: 6000,
      timeoutMs: ROLE_ACT_BOOKLET_PARSE_TIMEOUT_MS,
      metadata: {
        scriptPackageId: input.scriptPackageId,
        sourceSectionId: section.id
      },
      mockOutput: createHeuristicRoleActBookletOutput(section.roleName, section.actIndex, section.text)
    });
    const output = validateOutput(result.data, section.roleName, section.actIndex);
    const record = await prisma.roleActBooklet.upsert({
      where: { sourceSectionId: section.id },
      create: {
        scriptPackageId: input.scriptPackageId,
        roleName: section.roleName,
        actIndex: section.actIndex,
        sourceSectionId: section.id,
        privateText: output.privateText,
        mustShareJson: toJsonInput(output.mustShare),
        mayShareJson: toJsonInput(output.mayShare),
        mustNotShareJson: toJsonInput(output.mustNotShare),
        emotionalPointsJson: toJsonInput(output.emotionalPoints),
        relationshipPointsJson: toJsonInput(output.relationshipPoints),
        timelineFragmentsJson: toJsonInput(output.timelineFragments),
        parseStatus: RoleActBookletParseStatus.SUCCESS,
        parseError: null,
        warningsJson: toJsonInput(output.warnings)
      },
      update: {
        roleName: section.roleName,
        actIndex: section.actIndex,
        privateText: output.privateText,
        mustShareJson: toJsonInput(output.mustShare),
        mayShareJson: toJsonInput(output.mayShare),
        mustNotShareJson: toJsonInput(output.mustNotShare),
        emotionalPointsJson: toJsonInput(output.emotionalPoints),
        relationshipPointsJson: toJsonInput(output.relationshipPoints),
        timelineFragmentsJson: toJsonInput(output.timelineFragments),
        parseStatus: RoleActBookletParseStatus.SUCCESS,
        parseError: null,
        warningsJson: toJsonInput(output.warnings)
      }
    });

    await completeRoleActBookletParseJob(job.id, job.stepId, {
      status: "success",
      roleActBookletId: record.id,
      warningCount: output.warnings.length
    });

    return toRoleActBookletView(record);
  } catch (error) {
    const message = error instanceof Error ? error.message : "角色本结构化解析失败。";
    const record = await upsertFailedBooklet(section, message);

    await failRoleActBookletParseJob(job.id, job.stepId, message);

    return toRoleActBookletView(record);
  }
}

export async function parseAllRoleActBookletsForScriptPackage(
  scriptPackageId: string
): Promise<RoleActBookletParseSummary> {
  const sections = await prisma.documentSection.findMany({
    where: {
      scriptPackageId,
      sectionType: "role_act",
      sectionPurpose: DocumentSectionPurpose.AI_TEXT_SOURCE,
      isActive: true, parsedDocument: { isActive: true }
    },
    orderBy: [{ roleName: "asc" }, { actIndex: "asc" }]
  });
  const displaySections = await prisma.documentSection.findMany({
    where: {
      scriptPackageId,
      sectionType: "role_act",
      sectionPurpose: DocumentSectionPurpose.PLAYER_DISPLAY,
      isActive: true, parsedDocument: { isActive: true }
    },
    orderBy: [{ roleName: "asc" }, { actIndex: "asc" }]
  });
  const sourceKeys = new Set(
    sections
      .filter((section) => section.roleName && section.actIndex)
      .map((section) => `${section.roleName}::${section.actIndex}`)
  );
  const summary: RoleActBookletParseSummary = {
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    results: []
  };

  for (const displaySection of displaySections) {
    if (!displaySection.roleName || !displaySection.actIndex) {
      continue;
    }

    const key = `${displaySection.roleName}::${displaySection.actIndex}`;

    if (sourceKeys.has(key)) {
      continue;
    }

    summary.skippedCount += 1;
    summary.results.push({
      roleName: displaySection.roleName,
      actIndex: displaySection.actIndex,
      status: "skipped",
      warning: "该角色该幕缺少 AI 文本源，无法进行角色结构化解析，请上传 DOCX 或等待 OCR 支持。"
    });
  }

  for (const section of sections) {
    if (!section.roleName || !section.actIndex) {
      summary.skippedCount += 1;
      summary.results.push({
        roleName: section.roleName ?? "-",
        actIndex: section.actIndex ?? 0,
        sourceSectionId: section.id,
        status: "skipped",
        warning: "AI 文本源 section 缺少 roleName 或 actIndex。"
      });
      continue;
    }

    const result = await parseRoleActBooklet({
      scriptPackageId,
      roleName: section.roleName,
      actIndex: section.actIndex,
      sourceSectionId: section.id
    });

    if (result.parseStatus === RoleActBookletParseStatus.SUCCESS) {
      summary.successCount += 1;
      summary.results.push({
        roleName: section.roleName,
        actIndex: section.actIndex,
        sourceSectionId: section.id,
        status: "success"
      });
    } else {
      summary.failedCount += 1;
      summary.results.push({
        roleName: section.roleName,
        actIndex: section.actIndex,
        sourceSectionId: section.id,
        status: "failed",
        error: result.parseError ?? "角色本结构化解析失败。"
      });
    }
  }

  return summary;
}

async function findSourceSection(input: {
  scriptPackageId: string;
  roleName?: string | null;
  actIndex?: number | null;
  sourceSectionId?: string | null;
}) {
  const sections = await prisma.documentSection.findMany({
    where: input.sourceSectionId ? { id: input.sourceSectionId, scriptPackageId: input.scriptPackageId,
      isActive: true, parsedDocument: { isActive: true } } : {
      scriptPackageId: input.scriptPackageId, sectionType: "role_act", sectionPurpose: DocumentSectionPurpose.AI_TEXT_SOURCE,
      isActive: true, parsedDocument: { isActive: true }, roleName: input.roleName?.trim(), actIndex: input.actIndex ?? undefined
    }, orderBy: { orderIndex: "asc" }, take: input.sourceSectionId ? 1 : 2
  });
  if (sections.length > 1) throw new Error("当前角色当前幕有多份文本源，请明确指定 sourceSectionId。");
  const section = sections[0];

  if (!section) {
    throw new Error("未找到当前角色当前幕的 AI 文本源 DocumentSection。");
  }

  if (section.sectionType !== "role_act") {
    throw new Error("sourceSectionId 不是角色本 role_act section。");
  }

  if (section.sectionPurpose !== DocumentSectionPurpose.AI_TEXT_SOURCE) {
    throw new Error("sourceSectionId 必须指向 AI_TEXT_SOURCE section。");
  }

  if (!section.roleName || !section.actIndex) {
    throw new Error("AI 文本源 section 缺少 roleName 或 actIndex。");
  }

  if (input.roleName?.trim() && input.roleName.trim() !== section.roleName) {
    throw new Error("请求 roleName 与 sourceSection 不匹配。");
  }

  if (input.actIndex && input.actIndex !== section.actIndex) {
    throw new Error("请求 actIndex 与 sourceSection 不匹配。");
  }

  return {
    id: section.id,
    scriptPackageId: section.scriptPackageId,
    roleName: section.roleName,
    actIndex: section.actIndex,
    text: section.text
  };
}

function validateOutput(
  output: RoleActBookletOutput,
  roleName: string,
  actIndex: number
): RoleActBookletOutput {
  if (output.roleName !== roleName) {
    throw new Error(`LLM 输出 roleName 不匹配：期望 ${roleName}，实际 ${output.roleName}。`);
  }

  if (output.actIndex !== actIndex) {
    throw new Error(`LLM 输出 actIndex 不匹配：期望 ${actIndex}，实际 ${output.actIndex}。`);
  }

  if (!output.privateText.trim()) {
    throw new Error("LLM 输出 privateText 为空。");
  }

  return {
    ...output,
    mustShare: output.mustShare.filter(Boolean),
    mayShare: output.mayShare.filter(Boolean),
    mustNotShare: output.mustNotShare.filter(Boolean),
    emotionalPoints: output.emotionalPoints.filter(Boolean),
    relationshipPoints: output.relationshipPoints.filter(Boolean),
    timelineFragments: output.timelineFragments.filter(Boolean),
    warnings:
      output.mustShare.length === 0
        ? Array.from(new Set([...output.warnings, "当前幕未抽取到 mustShare，请人工检查。"]))
        : output.warnings
  };
}

async function upsertFailedBooklet(
  section: { id: string; scriptPackageId: string; roleName: string; actIndex: number },
  error: string
): Promise<RoleActBooklet> {
  return prisma.roleActBooklet.upsert({
    where: { sourceSectionId: section.id },
    create: {
      scriptPackageId: section.scriptPackageId,
      roleName: section.roleName,
      actIndex: section.actIndex,
      sourceSectionId: section.id,
      privateText: "",
      parseStatus: RoleActBookletParseStatus.FAILED,
      parseError: error,
      warningsJson: toJsonInput([])
    },
    update: {
      roleName: section.roleName,
      actIndex: section.actIndex,
      privateText: "",
      mustShareJson: toJsonInput([]),
      mayShareJson: toJsonInput([]),
      mustNotShareJson: toJsonInput([]),
      emotionalPointsJson: toJsonInput([]),
      relationshipPointsJson: toJsonInput([]),
      timelineFragmentsJson: toJsonInput([]),
      parseStatus: RoleActBookletParseStatus.FAILED,
      parseError: error,
      warningsJson: toJsonInput([])
    }
  });
}

async function createRoleActBookletParseJob(input: {
  scriptPackageId: string;
  roleName: string;
  actIndex: number;
  sourceSectionId: string;
}): Promise<{ id: string; stepId: string }> {
  const job = await prisma.ingestionJob.create({
    data: {
      scriptPackageId: input.scriptPackageId,
      status: IngestionJobStatus.RUNNING,
      currentStep: "role_act_booklet_parse",
      inputJson: toJsonInput(input),
      steps: {
        create: {
          stepName: "role_act_booklet_parse",
          status: IngestionJobStatus.RUNNING,
          inputJson: toJsonInput(input),
          startedAt: new Date()
        }
      }
    },
    include: { steps: true }
  });

  return {
    id: job.id,
    stepId: job.steps[0]?.id ?? ""
  };
}

async function completeRoleActBookletParseJob(
  jobId: string,
  stepId: string,
  output: unknown
): Promise<void> {
  await prisma.ingestionStepRun.update({
    where: { id: stepId },
    data: {
      status: IngestionJobStatus.COMPLETED,
      outputJson: toJsonInput(output),
      finishedAt: new Date()
    }
  });
  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: {
      status: IngestionJobStatus.COMPLETED,
      outputJson: toJsonInput(output),
      currentStep: "role_act_booklet_parse"
    }
  });
}

async function failRoleActBookletParseJob(
  jobId: string,
  stepId: string,
  errorMessage: string
): Promise<void> {
  await prisma.ingestionStepRun.update({
    where: { id: stepId },
    data: {
      status: IngestionJobStatus.FAILED,
      errorMessage,
      finishedAt: new Date()
    }
  });
  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: {
      status: IngestionJobStatus.FAILED,
      errorMessage,
      currentStep: "role_act_booklet_parse"
    }
  });
}

function createHeuristicRoleActBookletOutput(
  roleName: string,
  actIndex: number,
  text: string
): RoleActBookletOutput {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const explicitSecretLines = lines.filter((line) =>
    /不要|不能|秘密|暂时不能公开|别告诉|不要告诉|不能让别人知道/.test(line)
  );
  const shareLines = lines
    .filter((line) => !explicitSecretLines.includes(line))
    .filter((line) => line.length >= 8)
    .slice(0, 6);

  return {
    roleName,
    actIndex,
    privateText: text.trim(),
    mustShare: shareLines.slice(0, Math.max(1, Math.min(3, shareLines.length))),
    mayShare: shareLines.slice(3, 6),
    mustNotShare: explicitSecretLines,
    emotionalPoints: lines.filter((line) => /害怕|难过|愧疚|喜欢|爱|恨|遗憾|痛苦|开心|怀念/.test(line)).slice(0, 5),
    relationshipPoints: lines.filter((line) => /他|她|那个人|父亲|母亲|朋友|恋人|孩子|哥哥|姐姐|弟弟|妹妹/.test(line)).slice(0, 5),
    timelineFragments: lines.filter((line) => /年前|那天|晚上|早上|小时候|之后|以前|后来|离开/.test(line)).slice(0, 5),
    warnings: shareLines.length === 0 ? ["当前幕未抽取到明显可分享信息，请人工检查。"] : []
  };
}

function toRoleActBookletView(record: RoleActBooklet): RoleActBookletView {
  return {
    id: record.id,
    scriptPackageId: record.scriptPackageId,
    roleName: record.roleName,
    actIndex: record.actIndex,
    sourceSectionId: record.sourceSectionId,
    privateText: record.privateText,
    mustShare: fromJsonValue<string[]>(record.mustShareJson, []),
    mayShare: fromJsonValue<string[]>(record.mayShareJson, []),
    mustNotShare: fromJsonValue<string[]>(record.mustNotShareJson, []),
    emotionalPoints: fromJsonValue<string[]>(record.emotionalPointsJson, []),
    relationshipPoints: fromJsonValue<string[]>(record.relationshipPointsJson, []),
    timelineFragments: fromJsonValue<string[]>(record.timelineFragmentsJson, []),
    parseStatus: record.parseStatus,
    parseError: record.parseError,
    warnings: fromJsonValue<string[]>(record.warningsJson, []),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

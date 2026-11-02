import "server-only";

import type { GameSession as PrismaGameSession } from "@prisma/client";
import { validateReadingSources } from "./runtimeReadingValidation";
import { authorizedReadingSources, combineReadingBooklets, type ReadingAccess } from "./runtimeReadingSources";
import type { DMFlowCursor } from "@/src/lib/types/game";
import { prisma } from "@/src/lib/db/prisma";
import type { DMFlowNode } from "@/src/lib/schemas/dmFlowSchema";
import type { Script } from "@/src/lib/script/scriptTypes";
import { fromJsonValue } from "@/src/lib/services/jsonFields";
import { validateDMLifecycle } from "@/src/lib/services/dmLifecycleValidation";
import {
  getLatestScriptRuntimeDefinition,
  getScriptRuntimeDefinition,
  type RuntimePlayerDisplaySection,
  type ScriptRuntimeDefinitionJson,
  type ScriptRuntimeDefinitionView
} from "@/src/lib/services/scriptRuntimeDefinitionService";

export type RuntimeActRangeInput = {
  start?: number | null;
  end?: number | null;
};

export type RuntimeSessionScopeInput = {
  actRange?: RuntimeActRangeInput | null;
  roleNames?: string[] | null;
};

export type RuntimeSessionScope = {
  publicStoryBoardEnabled?: boolean;
  runtimeDefinitionId: string;
  scriptPackageId: string;
  testMode: boolean;
  runtimeMode?: import("@/src/lib/services/runtimeMode").RuntimeMode;
  runtimeDefinitionVersion?: number;
  actRange: {
    start: number;
    end: number;
  };
  roleNames: string[];
  warnings: string[];
};

export type PreparedRuntimeGameSession = {
  runtimeDefinitionId: string;
  scriptPackageId: string;
  scope: RuntimeSessionScope;
  script: Script;
};

export async function prepareRuntimeGameSession(input: {
  scriptPackageId?: string | null;
  runtimeDefinitionId?: string | null;
  scope?: RuntimeSessionScopeInput | null;
  normalGame?: boolean;
}): Promise<PreparedRuntimeGameSession> {
  if (!input.runtimeDefinitionId && input.scriptPackageId) {
    const candidates = await prisma.scriptRuntimeDefinition.findMany({ where: { scriptPackageId: input.scriptPackageId }, orderBy: { version: "desc" }, select: { id: true } });
    const failures: string[] = [];
    for (const candidate of candidates) {
      try { return await prepareRuntimeGameSession({ ...input, runtimeDefinitionId: candidate.id }); }
      catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    }
    throw new Error(`没有可运行的 RuntimeDefinition：${failures[0] ?? "请先生成并验证 RuntimeDefinition。"}`);
  }
  const definition = input.runtimeDefinitionId
    ? await getScriptRuntimeDefinition(input.runtimeDefinitionId)
    : input.scriptPackageId
      ? await getLatestRuntimeDefinitionOrThrow(input.scriptPackageId)
      : null;

  if (!definition) {
    throw new Error("请先生成 RuntimeDefinition，再从上传剧本启动测试局。");
  }

  if (input.scriptPackageId && definition.scriptPackageId !== input.scriptPackageId) {
    throw new Error("RuntimeDefinition 与当前剧本包不匹配。");
  }
  if (definition.definition.endingMode !== "story_reconstruction") throw new Error("RuntimeDefinition endingMode 不安全或不支持。");

  const scopeInput = input.normalGame && !input.scope?.actRange ? { ...input.scope, actRange: {
    start: definition.definition.acts[0]?.actIndex, end: definition.definition.acts.at(-1)?.actIndex } } : input.scope ?? {};
  const scope = buildRuntimeSessionScope(definition, scopeInput);
  const readingErrors = validateReadingSources(definition.definition);
  if (readingErrors.length) throw new Error(`读本来源不可运行：${readingErrors.join("；")}`);
  for (const role of scope.roleNames) {
    const first = definition.definition.roleBooklets.filter(b => b.roleName === role && b.actIndex === scope.actRange.start);
    if (first.length && first.every(b => b.whenChoice)) throw new Error(`${role} 的起始幕仅有条件读本，必须从前置选择所在幕开始。`);
  }
  if (input.normalGame && !input.scope?.roleNames && scope.roleNames.length !== definition.definition.roles.length) {
    throw new Error("正常游戏存在缺少角色本或玩家读本的角色；请补齐，或显式选择测试范围。");
  }
  for (const role of scope.roleNames) for (const act of definition.definition.acts.filter(a => a.actIndex >= scope.actRange.start && a.actIndex <= scope.actRange.end)) {
    const sources = definition.definition.roleBooklets.filter(b => b.roleName === role && b.actIndex === act.actIndex);
    if ((!sources.length || sources.some(b => !b.privateText.trim())) &&
      !(act.modelPolicy === "disabled" && definition.definition.playerDisplay.some(p => p.pdfOnly && p.roleName === role && p.actIndex === act.actIndex))) {
      throw new Error(`${role} 第 ${act.actIndex} 幕角色本为空，不能启动。`);
    }
    if (input.normalGame && !definition.definition.playerDisplay.some(p => p.roleName === role && p.actIndex === act.actIndex)) {
      throw new Error(`${role} 第 ${act.actIndex} 幕缺少玩家读本，不能开始正常游戏。`);
    }
  }
  const issues = validateDMLifecycle(definition.definition, scope);
  const fatal = issues.filter(i => i.fatal);
  if (fatal.length) throw new Error(`DMFlow 不可运行：${fatal.map(i => `${i.code}: ${i.message}`).join("；")}`);
  await (await import("./groupMatchingKeyService")).assertGroupMatchingKeysForScope(definition.id, scope);
  scope.warnings.push(...issues.map(i => `${i.code}: ${i.message}`));
  const script = adaptRuntimeDefinitionToScript(definition.definition, scope);

  return {
    runtimeDefinitionId: definition.id,
    scriptPackageId: definition.scriptPackageId,
    scope,
    script
  };
}

export async function getRuntimeScriptForGameSession(
  session: Pick<PrismaGameSession, "runtimeDefinitionId" | "runtimeScopeJson"> & Partial<Pick<PrismaGameSession, "currentActId" | "dmFlowCursorJson">>
): Promise<Script | null> {
  if (!session.runtimeDefinitionId) {
    return null;
  }

  const definition = await getScriptRuntimeDefinition(session.runtimeDefinitionId);
  const savedScope = fromJsonValue<RuntimeSessionScope | null>(
    session.runtimeScopeJson ?? null,
    null
  );
  const scope = savedScope?.runtimeDefinitionId
    ? savedScope
    : buildRuntimeSessionScope(definition, {});

  return adaptRuntimeDefinitionToScript(definition.definition, scope, {
    definition: definition.definition, definitionId: definition.id, definitionVersion: definition.version,
    cursor: fromJsonValue<DMFlowCursor | null>(session.dmFlowCursorJson ?? null, null),
    minActIndex: scope?.actRange.start, maxActIndex: scope?.actRange.end,
    currentActIndex: Number(session.currentActId?.match(/^runtime_act_(\d+)$/)?.[1]) || scope.actRange.start, roleName: ""
  });
}

export async function getRuntimeReadingSourcesForGameSession(input: {
  gameSessionId: string; roleName: string; actIndex?: number;
}) {
  const session = await prisma.gameSession.findUnique({ where: { id: input.gameSessionId } });
  if (!session?.runtimeDefinitionId) return null;
  const view = await getScriptRuntimeDefinition(session.runtimeDefinitionId);
  const scope = fromJsonValue<RuntimeSessionScope | null>(session.runtimeScopeJson ?? null, null);
  if (scope && !scope.roleNames.includes(input.roleName)) return { booklets: [], displays: [] };
  const access: ReadingAccess = { definition: view.definition, definitionId: view.id, definitionVersion: view.version,
    cursor: fromJsonValue<DMFlowCursor | null>(session.dmFlowCursorJson ?? null, null),
    minActIndex: scope?.actRange.start, maxActIndex: scope?.actRange.end,
    currentActIndex: Number(session.currentActId.match(/^runtime_act_(\d+)$/)?.[1]) || 0, roleName: input.roleName };
  return authorizedReadingSources(access, input.actIndex);
}

export async function getRuntimePlayerDisplayForGameSession(input: {
  gameSessionId: string; roleName: string; actIndex: number; sectionId?: string | null;
}): Promise<RuntimePlayerDisplaySection | null> {
  const sources = await getRuntimeReadingSourcesForGameSession(input);
  return sources?.displays.find(s => !input.sectionId || s.sourceDocumentSectionId === input.sectionId) ?? null;
}

export function isRuntimeDefinitionSession(
  session: Pick<PrismaGameSession, "runtimeDefinitionId">
): boolean {
  return Boolean(session.runtimeDefinitionId);
}

function buildRuntimeSessionScope(
  view: ScriptRuntimeDefinitionView,
  input: RuntimeSessionScopeInput
): RuntimeSessionScope {
  const definition = view.definition;
  const actIndexes = getAvailableActIndexes(definition);
  const start = normalizeActIndex(input.actRange?.start, actIndexes[0] ?? 1);
  const end = normalizeActIndex(input.actRange?.end, start);
  const scopedActIndexes = actIndexes.filter((actIndex) => actIndex >= start && actIndex <= end);
  const warnings: string[] = [];

  if (scopedActIndexes.length === 0) {
    throw new Error(`RuntimeDefinition 中没有第 ${start} 到第 ${end} 幕可用于测试。`);
  }

  const explicitRoleNames = normalizeRoleNames(input.roleNames);
  const eligibleRoleNames = explicitRoleNames.length
    ? explicitRoleNames
    : definition.roles.map((role) => role.roleName);
  const roleNames = eligibleRoleNames.filter((roleName) =>
    isRoleUsableInScope(definition, roleName, scopedActIndexes)
  );
  const excludedRoles = eligibleRoleNames.filter((roleName) => !roleNames.includes(roleName));

  if (excludedRoles.length) {
    const missingMessages = excludedRoles.map((roleName) =>
      describeRoleScopeMissingReason(definition, roleName, scopedActIndexes)
    );

    if (explicitRoleNames.length) {
      throw new Error(`无法启动测试局：${missingMessages.join("；")}`);
    }

    warnings.push(`已排除不可测试角色：${missingMessages.join("；")}`);
  }

  if (roleNames.length < 2) {
    throw new Error(
      `至少需要 2 个可测试角色才能启动测试局；当前可用 ${roleNames.length} 个。请至少完成两个角色第 ${scopedActIndexes[0]} 幕的结构化解析和玩家 PDF 分幕。`
    );
  }

  if (roleNames.length < 3) {
    warnings.push("当前只有 2 个可测试角色，可以启动功能测试；正式体验建议至少 3 个角色。");
  }

  if (containsAbsoluteStoragePath(definition)) {
    throw new Error("RuntimeDefinition 中包含 storage 绝对路径，不能启动测试局。");
  }

  if (!hasDMFlowForFirstScopedAct(definition, scopedActIndexes[0] ?? start)) {
    warnings.push("第 1 个测试幕缺少可用 DMFlow，测试局会使用系统兜底主持流程。");
  }

  return {
    runtimeDefinitionId: view.id,
    scriptPackageId: view.scriptPackageId,
    testMode: true,
    actRange: {
      start: scopedActIndexes[0] ?? start,
      end: scopedActIndexes.at(-1) ?? end
    },
    roleNames,
    warnings
  };
}

function adaptRuntimeDefinitionToScript(
  definition: ScriptRuntimeDefinitionJson,
  scope: RuntimeSessionScope,
  access?: ReadingAccess
): Script {
  const scopedActIndexes = getAvailableActIndexes(definition).filter(
    (actIndex) => actIndex >= scope.actRange.start && actIndex <= scope.actRange.end
  );

  return {
    script_id: `runtime_definition_${scope.runtimeDefinitionId}`,
    title: `${definition.title || "上传剧本"}${scope.testMode ? "（测试局）" : ""}`,
    summary: "由 RuntimeDefinition 生成的运行脚本。",
    roles: scope.roleNames.map((roleName) => {
      const role = definition.roles.find((candidate) => candidate.roleName === roleName);

      return {
        role_id: roleName,
        name: role?.displayName || roleName,
        personality: "上传剧本角色"
      };
    }),
    acts: scopedActIndexes.map((actIndex) => {
      const runtimeAct = definition.acts.find((act) => act.actIndex === actIndex);

      return {
        act_id: buildRuntimeActId(actIndex),
        title: runtimeAct?.title?.trim() || `第 ${actIndex} 幕`,
        bgm: "未配置",
        share_order: scope.roleNames,
        dm_flow: adaptDMFlowForAct(definition, actIndex, scope.actRange.start),
        booklets: scope.roleNames.map((roleName) => {
          const booklet = access
            ? combineReadingBooklets(authorizedReadingSources({ ...access, roleName }, actIndex).booklets)
            : null;

          // Script shape stays compatible, but unresolved/future sources never
          // enter this projection. Authoring eligibility is checked separately.
          return { role_id: roleName, private_text: booklet?.privateText ?? "",
            must_share: booklet?.mustShare ?? [], may_share: booklet?.mayShare ?? [], must_not_share: booklet?.mustNotShare ?? [] };
        })
      };
    })
  };
}

function adaptDMFlowForAct(
  definition: ScriptRuntimeDefinitionJson,
  actIndex: number,
  firstScopedActIndex: number
): Record<string, unknown> {
  const dmFlow = definition.dmFlow;
  const actFlow = dmFlow?.actFlows.find((flow) => flow.actIndex === actIndex);
  const nodes = actFlow?.nodes ?? [];
  const openingNodes = actIndex === firstScopedActIndex ? dmFlow?.openingNodes ?? [] : [];
  const endingNodes = dmFlow?.endingNodes ?? [];
  const freeDiscussion = findNode(nodes, ["free_discussion"]);

  return {
    opening: adaptNode(findNode(openingNodes, ["fixed_line", "dm_prompt", "transition"])),
    reading_instruction: adaptNode(findNode(nodes, ["reading_start"])),
    share_intro: adaptNode(findNode(nodes, ["sharing_round"])),
    share_prompt: adaptNode(findNode(nodes, ["sharing_round", "dm_prompt"])),
    free_discussion: adaptNode(freeDiscussion),
    discussion_guidance: adaptNode(freeDiscussion ?? findNode(nodes, ["dm_prompt"])),
    dm_questions: nodes.filter((node) => node.type === "dm_prompt").map(adaptNode).filter(Boolean),
    act_summary: adaptNode(findNode(nodes, ["act_summary"])),
    performance_nodes: nodes
      .filter((node) => node.type === "performance_instruction")
      .map(adaptNode)
      .filter(Boolean),
    advance_to_next_act: adaptNode(findNode(nodes, ["transition"])),
    finished: adaptNode(findNode(endingNodes, ["ending_reveal", "fixed_line", "dm_prompt"])),
    forbidden_reveals: Array.from(
      new Set(nodes.flatMap((node) => node.forbiddenReveals).filter(Boolean))
    )
  };
}

function adaptNode(node: DMFlowNode | null | undefined): Record<string, unknown> | null {
  if (!node) {
    return null;
  }

  const fixedContent = node.fixedLine?.trim() || (node.type === "fixed_line" ? node.text?.trim() : "");
  const guidance =
    node.promptGoal?.trim() ||
    (node.type !== "fixed_line" ? node.text?.trim() || node.sourceQuote?.trim() : "") ||
    node.performance?.instruction?.trim() ||
    node.performance?.rawText?.trim();

  return {
    id: node.nodeId,
    mode: fixedContent ? "fixed" : guidance ? "guided" : "fallback",
    content: fixedContent || undefined,
    guidance: fixedContent ? undefined : guidance || undefined,
    question_goal: node.promptGoal ?? undefined,
    required_public_points: node.requiredPublicPoints,
    if_missing_points: node.ifMissingPoints,
    forbidden_reveals: node.forbiddenReveals,
    focus_points: [node.title, node.text].filter((item): item is string => Boolean(item?.trim())),
    storyBoardEligible: node.type === "act_summary" || node.type === "ending_reveal"
  };
}

function findNode(nodes: DMFlowNode[], types: DMFlowNode["type"][]): DMFlowNode | null {
  return nodes.find((node) => types.includes(node.type)) ?? null;
}

function getLatestRuntimeDefinitionOrThrow(
  scriptPackageId: string
): Promise<ScriptRuntimeDefinitionView> {
  return getLatestScriptRuntimeDefinition(scriptPackageId).then((definition) => {
    if (!definition) {
      throw new Error("请先生成 RuntimeDefinition，再从上传剧本启动测试局。");
    }

    return definition;
  });
}

function getAvailableActIndexes(definition: ScriptRuntimeDefinitionJson): number[] {
  const indexes = new Set<number>();

  definition.acts.forEach((act) => indexes.add(act.actIndex));
  definition.roleBooklets.forEach((booklet) => indexes.add(booklet.actIndex));
  definition.playerDisplay.forEach((section) => indexes.add(section.actIndex));
  definition.dmFlow?.actFlows.forEach((actFlow) => indexes.add(actFlow.actIndex));

  return Array.from(indexes).filter((actIndex) => actIndex > 0).sort((left, right) => left - right);
}

function isRoleUsableInScope(
  definition: ScriptRuntimeDefinitionJson,
  roleName: string,
  actIndexes: number[]
): boolean {
  return (
    actIndexes.every((actIndex) => definition.roleBooklets.some(b => b.roleName === roleName && b.actIndex === actIndex) ||
      definition.acts.find(a => a.actIndex === actIndex)?.modelPolicy === "disabled" && hasPlayerDisplay(definition, roleName, actIndex)) &&
    hasPlayerDisplay(definition, roleName, actIndexes[0] ?? 1)
  );
}

function describeRoleScopeMissingReason(
  definition: ScriptRuntimeDefinitionJson,
  roleName: string,
  actIndexes: number[]
): string {
  const missing: string[] = [];

  for (const actIndex of actIndexes) {
    if (!definition.roleBooklets.some(b => b.roleName === roleName && b.actIndex === actIndex)) {
      missing.push(`第 ${actIndex} 幕 RoleActBooklet`);
    }
  }

  const firstActIndex = actIndexes[0] ?? 1;

  if (!hasPlayerDisplay(definition, roleName, firstActIndex)) {
    missing.push(`第 ${firstActIndex} 幕玩家 PDF`);
  }

  return `${roleName} 缺少 ${missing.join("、")}`;
}

function hasPlayerDisplay(
  definition: ScriptRuntimeDefinitionJson,
  roleName: string,
  actIndex: number
): boolean {
  return definition.playerDisplay.some(
    (section) => section.roleName === roleName && section.actIndex === actIndex
  );
}

function hasDMFlowForFirstScopedAct(
  definition: ScriptRuntimeDefinitionJson,
  actIndex: number
): boolean {
  return Boolean(
    definition.dmFlow?.openingNodes.length ||
      definition.dmFlow?.actFlows.some(
        (actFlow) => actFlow.actIndex === actIndex && actFlow.nodes.length > 0
      )
  );
}

function buildRuntimeActId(actIndex: number): string {
  return `runtime_act_${actIndex}`;
}

function normalizeRoleNames(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(value.map((item) => item.trim()).filter(Boolean)));
}

function normalizeActIndex(value: number | null | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function containsAbsoluteStoragePath(value: unknown): boolean {
  return JSON.stringify(value).includes("/storage/scripts/");
}

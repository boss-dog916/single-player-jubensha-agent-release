"use client";
import { StoryBoardOption } from "../StoryBoardOption";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useState } from "react";
import { ManualControlDetails, SourceEvidenceDetails, ValidationProvenance } from "@/components/ManualContractDetails";
import { ManualSemanticCandidates } from "@/components/ManualSemanticCandidates";
import type { LogicalActControl } from "@/src/lib/services/manualControlCompiler";
import type { ManualSemanticAct, SourceEvidence } from "@/src/lib/schemas/manualSemanticSchema";
import type {
  ScriptPackageDetail,
  ScriptPackageSummary
} from "@/src/lib/services/scriptPackageService";
import type { GameRuntimeSnapshot } from "@/src/lib/services/gameRuntimeSnapshotService";
import type { RecoverableGameSessionSummary } from "@/src/lib/services/gameSessionRecoveryService";

type SafeDetail = Omit<ScriptPackageDetail, "script">;
type AssetView = {
  metadataJson?: string | null;
  id: string;
  kind: string;
  assetPurpose: string;
  roleName: string | null;
  originalName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  parseStatus: string;
  createdAt: string | Date;
};
type ParsedDocumentView = {
  documentRevision: number;
  sectionSetRevision: number;
  isActive: boolean;
  id: string;
  scriptPackageId: string;
  uploadedAssetId: string;
  kind: string;
  sourceType: string;
  parseStatus: string;
  segmentationStatus: string;
  segmentationError: string | null;
  rawText: string;
  normalizedText: string;
  extractorName: string | null;
  qualityStatus: string;
  qualityWarnings: string[];
  pageCount: number;
  charCount: number;
  extractedText: string;
  errorMessage: string | null;
  pages: Array<{
    pageNumber: number;
    text: string;
    paragraphs: string[];
    charCount: number;
  }>;
  createdAt: string | Date;
  updatedAt: string | Date;
};
type DocumentSectionView = {
  sectionSetRevision: number;
  isActive: boolean;
  id: string;
  uploadedAssetId: string;
  parsedDocumentId: string;
  sectionType: string;
  sectionPurpose: string;
  title: string;
  roleName: string | null;
  actIndex: number | null;
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
  metadataJson: string | null;
  orderIndex: number;
  uploadedAsset: {
    id: string;
    kind: string;
    assetPurpose: string;
    originalName: string;
    roleName: string | null;
  };
};
type RoleActBookletView = {
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
  parseStatus: string;
  parseError: string | null;
  warnings: string[];
  createdAt: string | Date;
  updatedAt: string | Date;
};
type DMFlowNodeView = {
  nodeId: string;
  type: string;
  actIndex: number | null;
  title: string | null;
  text: string | null;
  fixedLine: string | null;
  promptGoal: string | null;
  targetRoleNames: string[];
  expectedSpeakerRoleNames: string[];
  durationHint: string | null;
  orderHint: number | null;
  requiredPublicPoints: string[];
  ifMissingPoints: string[];
  forbiddenReveals: string[];
  clueRefs: Array<{
    title: string | null;
    rawText: string | null;
    releaseMode?: string;
    targetRoleNames?: string[];
    visibility?: string;
  }>;
  performance: {
    kind: string | null;
    instruction: string | null;
    rawText: string | null;
  } | null;
  sourceQuote: string;
  confidence: number;
  warnings: string[];
};
type DMFlowView = {
  format?: string;
  semanticActs?: ManualSemanticAct[];
  artifactAudit?: Array<{ id: string; status: string; source: Partial<SourceEvidence> }>;
  id: string;
  scriptPackageId: string;
  openingNodes: DMFlowNodeView[];
  actFlows: Array<{
    actIndex: number;
    title?: string;
    nodes: DMFlowNodeView[];
    warnings: string[];
    sourceSectionId: string;
  }>;
  endingNodes: DMFlowNodeView[];
  sectionResults: Array<{
    sourceSectionId: string;
    sectionType: string;
    actIndex: number | null;
    title: string;
    status: string;
    warningCount: number;
    warnings: string[];
    parseError?: string | null;
    parsedAt: string;
  }>;
  parseStatus: string;
  parseError: string | null;
  warnings: string[];
  createdAt: string | Date;
  updatedAt: string | Date;
};
type RuntimeDefinitionView = {
  id: string;
  scriptPackageId: string;
  version: number;
  status: string;
  definition: {
    endingMode: string;
    roles: unknown[];
    acts: Array<{ actIndex: number; control?: LogicalActControl }>;
    roleBooklets: unknown[];
    dmFlow: { actFlows: unknown[] } | null;
    playerDisplay: unknown[];
    clues: unknown[];
  };
  validationReport: {
    validatorVersion?: string;
    validatedAt?: string;
    status: string;
    errors: RuntimeValidationIssueView[];
    warnings: RuntimeValidationIssueView[];
  };
  storedValidationReport?: RuntimeDefinitionView["validationReport"];
  compiledAt: string | Date;
  createdAt: string | Date;
  updatedAt: string | Date;
};
type RuntimeValidationIssueView = {
  code: string;
  message: string;
  path?: string;
  severity: string;
};
type IngestionJobView = {
  id: string;
  status: string;
  currentStep: string | null;
  errorMessage: string | null;
  createdAt: string | Date;
  steps: Array<{
    id: string;
    stepName: string;
    status: string;
    errorMessage: string | null;
  }>;
};

type Props = {
  initialDetail: SafeDetail;
  initialAssets: AssetView[];
  initialIngestionJobs: IngestionJobView[];
  initialParsedDocuments: ParsedDocumentView[];
  initialDocumentSections: DocumentSectionView[];
  initialRoleActBooklets: RoleActBookletView[];
  initialDMFlow: DMFlowView | null;
  initialRuntimeDefinition: RuntimeDefinitionView | null;
  initialRecoverableGameSessions: RecoverableGameSessionSummary[];
};
type ManualRoleActsValue = {
  roleName: string;
  actStartPages: Array<{
    actIndex: number;
    pageStart: number;
    title: string;
  }>;
};
type ActivePanel =
  | "upload"
  | "roleSplit"
  | "roleParse"
  | "dmFlow"
  | "runtime"
  | "documents"
  | "jobs"
  | "scriptJson"
  | "sections";

export function ScriptPackageDetailClient({
  initialDetail,
  initialAssets,
  initialIngestionJobs,
  initialParsedDocuments,
  initialDocumentSections,
  initialRoleActBooklets,
  initialDMFlow,
  initialRuntimeDefinition,
  initialRecoverableGameSessions
}: Props) {
  const router = useRouter();
  const [detail, setDetail] = useState(initialDetail);
  const [assets, setAssets] = useState(initialAssets);
  const [ingestionJobs, setIngestionJobs] = useState(initialIngestionJobs);
  const [parsedDocuments, setParsedDocuments] = useState(initialParsedDocuments);
  const [documentSections, setDocumentSections] = useState(initialDocumentSections);
  const [roleActBooklets, setRoleActBooklets] = useState(initialRoleActBooklets);
  const [dmFlow, setDMFlow] = useState(initialDMFlow);
  const [candidateRefresh, setCandidateRefresh] = useState(0);
  const [runtimeDefinition, setRuntimeDefinition] = useState(initialRuntimeDefinition);
  const [recoverableGameSessions, setRecoverableGameSessions] = useState(
    initialRecoverableGameSessions
  );
  const [assetKind, setAssetKind] = useState("DM_MANUAL");
  const [assetPurpose, setAssetPurpose] = useState("BOTH");
  const [roleName, setRoleName] = useState("");
  const [readingBookKey, setReadingBookKey] = useState("");
  const [readingOrder, setReadingOrder] = useState("0");
  const [readingChoiceId, setReadingChoiceId] = useState("");
  const [readingOptionId, setReadingOptionId] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [scriptJson, setScriptJson] = useState<string | null>(null);
  const [managementUnlocked, setManagementUnlocked] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<ActivePanel | null>(null);

  async function refreshDetail() {
    const [
      detailResponse,
      assetsResponse,
      jobsResponse,
      parsedResponse,
      sectionsResponse,
      roleBookletsResponse,
      dmFlowResponse,
      runtimeDefinitionResponse,
      gameSessionsResponse
    ] = await Promise.all([
      fetch(`/api/script-packages/${detail.id}`),
      fetch(`/api/script-packages/${detail.id}/assets`),
      fetch(`/api/script-packages/${detail.id}/ingestion-jobs`),
      fetch(`/api/script-packages/${detail.id}/parsed-documents`),
      fetch(`/api/script-packages/${detail.id}/document-sections`),
      fetch(`/api/script-packages/${detail.id}/role-booklets`),
      fetch(`/api/script-packages/${detail.id}/dm-flow`),
      fetch(`/api/script-packages/${detail.id}/runtime-definition/latest`),
      fetch(`/api/script-packages/${detail.id}/game-sessions`)
    ]);
    const [
      detailPayload,
      assetsPayload,
      jobsPayload,
      parsedPayload,
      sectionsPayload,
      roleBookletsPayload,
      dmFlowPayload,
      runtimeDefinitionPayload,
      gameSessionsPayload
    ] = await Promise.all([
      readJsonResponse(detailResponse),
      readJsonResponse(assetsResponse),
      readJsonResponse(jobsResponse),
      readJsonResponse(parsedResponse),
      readJsonResponse(sectionsResponse),
      readJsonResponse(roleBookletsResponse),
      readJsonResponse(dmFlowResponse),
      readJsonResponse(runtimeDefinitionResponse),
      readJsonResponse(gameSessionsResponse)
    ]);

    if (!detailResponse.ok) {
      throw new Error(getErrorMessage(detailPayload, "刷新剧本包失败。"));
    }

    setDetail(stripScript(detailPayload as ScriptPackageDetail));

    if (Array.isArray(assetsPayload.assets)) {
      setAssets(assetsPayload.assets as AssetView[]);
    }

    if (Array.isArray(jobsPayload.ingestionJobs)) {
      setIngestionJobs(jobsPayload.ingestionJobs as IngestionJobView[]);
    }

    if (Array.isArray(parsedPayload.parsedDocuments)) {
      setParsedDocuments(parsedPayload.parsedDocuments as ParsedDocumentView[]);
    }

    if (Array.isArray(sectionsPayload.documentSections)) {
      setDocumentSections(sectionsPayload.documentSections as DocumentSectionView[]);
    }

    if (Array.isArray(roleBookletsPayload.roleActBooklets)) {
      setRoleActBooklets(roleBookletsPayload.roleActBooklets as RoleActBookletView[]);
    }

    setDMFlow((dmFlowPayload.dmFlow as DMFlowView | null) ?? null);
    setCandidateRefresh(value => value + 1);
    setRuntimeDefinition(
      (runtimeDefinitionPayload.runtimeDefinition as RuntimeDefinitionView | null) ?? null
    );
    setRecoverableGameSessions(
      (gameSessionsPayload.gameSessions as RecoverableGameSessionSummary[] | undefined) ?? []
    );
  }

  async function parseAsset(asset: AssetView) {
    setBusy(true);
    setErrorText(null);

    try {
      const response = await fetch(
        `/api/script-packages/${detail.id}/assets/${asset.id}/parse`,
        { method: "POST" }
      );
      const payload = await readJsonResponse(response);

      if (!response.ok && !payload.parsedDocument) {
        throw new Error(getErrorMessage(payload, "解析文本失败。"));
      }

      if (!response.ok) {
        setErrorText(getErrorMessage(payload, "PDF 文本抽取失败。"));
      }

      await refreshDetail();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "解析文本失败。");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAsset(asset: AssetView) {
    if (
      !window.confirm(
        `确认删除「${asset.originalName}」吗？相关抽取文本和切分记录也会一起删除。`
      )
    ) {
      return;
    }

    setBusy(true);
    setErrorText(null);

    try {
      const response = await fetch(`/api/script-packages/${detail.id}/assets/${asset.id}`, {
        method: "DELETE"
      });
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "删除资料失败。"));
      }

      await refreshDetail();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "删除资料失败。");
    } finally {
      setBusy(false);
    }
  }


  async function uploadAsset() {
    if (!selectedFile) {
      setErrorText("请先选择一个文件。");
      return;
    }

    if (assetKind === "ROLE_BOOKLET" && !roleName.trim()) {
      setErrorText("上传角色剧本时请填写角色名，PDF 和 DOCX 需要用同一个角色名关联。");
      return;
    }

    setBusy(true);
    setErrorText(null);

    try {
      const formData = new FormData();

      formData.set("file", selectedFile);
      formData.set("kind", assetKind);
      formData.set("assetPurpose", assetKind === "ROLE_BOOKLET" ? assetPurpose : "BOTH");
      formData.set("roleName", assetKind === "ROLE_BOOKLET" ? roleName : "");
      if (assetKind === "ROLE_BOOKLET" && readingBookKey.trim()) formData.set("metadataJson", JSON.stringify({ reading: {
        bookKey: readingBookKey.trim(), readingOrder: Number(readingOrder), required: true,
        ...(readingChoiceId.trim() ? { whenChoice: { choiceId: readingChoiceId.trim(), roleName: roleName.trim(), optionId: readingOptionId.trim() } } : {})
      } }));

      const response = await fetch(`/api/script-packages/${detail.id}/assets`, {
        method: "POST",
        body: formData
      });
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "上传资料失败。"));
      }

      setSelectedFile(null);
      setRoleName("");
      await refreshDetail();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "上传资料失败。");
    } finally {
      setBusy(false);
    }
  }

  async function createIngestionJob() {
    setBusy(true);
    setErrorText(null);

    try {
      const response = await fetch(`/api/script-packages/${detail.id}/ingestion-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputJson: {
            source: "manual_ui_trigger",
            assetCount: assets.length
          }
        })
      });
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "创建解析任务失败。"));
      }

      await refreshDetail();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "创建解析任务失败。");
    } finally {
      setBusy(false);
    }
  }

  async function rerunValidation() {
    setBusy(true);
    setErrorText(null);

    try {
      const response = await fetch(`/api/script-packages/${detail.id}/validation`, {
        method: "POST"
      });
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "校验失败。"));
      }

      await refreshDetail();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "校验失败。");
    } finally {
      setBusy(false);
    }
  }

  async function loadScriptJson() {
    if (
      !window.confirm(
        "管理模式会显示完整结构化剧本数据，可能包含 DM 信息、角色秘密和最终真相。确认只在管理者视角查看？"
      )
    ) {
      return;
    }

    setManagementUnlocked(true);
    setBusy(true);
    setErrorText(null);

    try {
      const response = await fetch(`/api/script-packages/${detail.id}`);
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "加载 scriptJson 失败。"));
      }

      setScriptJson(JSON.stringify((payload as ScriptPackageDetail).script, null, 2));
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "加载 scriptJson 失败。");
    } finally {
      setBusy(false);
    }
  }

  function unlockManagement() {
    if (
      !window.confirm(
        "管理模式会显示章节原文，可能包含 DM 信息、角色秘密和最终真相。确认只在管理者视角查看？"
      )
    ) {
      return;
    }

    setManagementUnlocked(true);
  }

  async function segmentDocument(parsedDocument: ParsedDocumentView) {
    setBusy(true);
    setErrorText(null);

    try {
      const response = await fetch(
        `/api/script-packages/${detail.id}/parsed-documents/${parsedDocument.id}/sections`,
        { method: "POST" }
      );
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "切分章节失败。"));
      }

      if (typeof payload.segmentationError === "string" && payload.segmentationError) {
        setErrorText(payload.segmentationError);
      }

      await refreshDetail();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "切分章节失败。");
    } finally {
      setBusy(false);
    }
  }

  async function submitManualRoleActs(parsedDocument: ParsedDocumentView, input: ManualRoleActsValue) {
    setBusy(true);
    setErrorText(null);

    try {
      const response = await fetch(
        `/api/script-packages/${detail.id}/parsed-documents/${parsedDocument.id}/sections/manual-role-acts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input)
        }
      );
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "手动切分失败。"));
      }

      await refreshDetail();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "手动切分失败。");
    } finally {
      setBusy(false);
    }
  }

  const [boardEnabled, setBoardEnabled] = useState(false);

  async function startGame(runtimeDefinitionId?: string) {
    if (detail.isDefaultDemo && detail.validation.status === "invalid") {
      setErrorText("该剧本包校验未通过，不能开始游戏。");
      return;
    }

    if (
      detail.isDefaultDemo && detail.validation.status === "warning" &&
      !window.confirm("该剧本包存在 warning，仍要开始游戏吗？")
    ) {
      return;
    }

    setBusy(true);
    setErrorText(null);

    try {
      const response = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scriptPackageId: detail.id,
          ...(runtimeDefinitionId ? { runtimeDefinitionId } : {}),
          publicStoryBoardEnabled: boardEnabled
        })
      });
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "创建游戏失败。"));
      }

      router.push(`/games/${(payload as GameRuntimeSnapshot).session.gameId}`);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "创建游戏失败。");
      setBusy(false);
    }
  }

  async function startRuntimeDefinitionTestGame() {
    if (!runtimeDefinition) {
      setErrorText("请先生成 RuntimeDefinition。");
      return;
    }

    setBusy(true);
    setErrorText(null);

    try {
      const response = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scriptPackageId: detail.id,
          runtimeDefinitionId: runtimeDefinition.id,
          publicStoryBoardEnabled: boardEnabled,
          testMode: true,
          actRange: { start: 1, end: 1 }
        })
      });
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "创建 RuntimeDefinition 测试局失败。"));
      }

      router.push(`/games/${(payload as GameRuntimeSnapshot).session.gameId}`);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "创建 RuntimeDefinition 测试局失败。");
      setBusy(false);
    }
  }

  async function parseAllRoleActBooklets() {
    setBusy(true);
    setErrorText(null);

    try {
      const response = await fetch(`/api/script-packages/${detail.id}/role-booklets/parse-all`, {
        method: "POST"
      });
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "批量角色本结构化解析失败。"));
      }

      const summary = payload.summary as
        | { successCount?: number; failedCount?: number; skippedCount?: number }
        | undefined;

      setErrorText(
        `角色本结构化解析完成：成功 ${summary?.successCount ?? 0}，失败 ${
          summary?.failedCount ?? 0
        }，跳过 ${summary?.skippedCount ?? 0}。`
      );
      await refreshDetail();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "批量角色本结构化解析失败。");
    } finally {
      setBusy(false);
    }
  }

  async function parseOneRoleActBooklet(section: DocumentSectionView) {
    setBusy(true);
    setErrorText(null);

    try {
      const response = await fetch(`/api/script-packages/${detail.id}/role-booklets/parse-one`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roleName: section.roleName,
          actIndex: section.actIndex,
          sourceSectionId: section.id
        })
      });
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "单幕角色本结构化解析失败。"));
      }

      await refreshDetail();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "单幕角色本结构化解析失败。");
    } finally {
      setBusy(false);
    }
  }

  async function parseAllDMFlow() {
    setBusy(true);
    setErrorText(null);

    try {
      const response = await fetch(`/api/script-packages/${detail.id}/dm-flow/parse-all`, {
        method: "POST"
      });
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "批量 DM 手册结构化解析失败。"));
      }

      const candidate = payload.candidate as { status?: string } | undefined;
      setErrorText(`Semantic v2 候选已保存：${candidate?.status ?? "-"}，未发布，不影响现有游戏。`);
      await refreshDetail();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "批量 DM 手册结构化解析失败。");
    } finally {
      setBusy(false);
    }
  }

  async function parseOneDMSection(section: DocumentSectionView) {
    setBusy(true);
    setErrorText(null);

    try {
      const response = await fetch(`/api/script-packages/${detail.id}/dm-flow/parse-section`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionId: section.id })
      });
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "单段 DM 手册结构化解析失败。"));
      }
      const candidate = payload.candidate as { status?: string } | undefined;
      setErrorText(`Semantic v2 范围候选已保存：${candidate?.status ?? "-"}，未发布。`);
      await refreshDetail();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "单段 DM 手册结构化解析失败。");
    } finally {
      setBusy(false);
    }
  }

  async function compileRuntimeDefinition() {
    setBusy(true);
    setErrorText(null);

    try {
      const response = await fetch(
        `/api/script-packages/${detail.id}/runtime-definition/compile`,
        { method: "POST" }
      );
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "生成 RuntimeDefinition 失败。"));
      }

      const summary = payload.summary as
        | { status?: string; version?: number; counts?: { roles?: number; acts?: number } }
        | undefined;

      setErrorText(
        `RuntimeDefinition 已生成：v${summary?.version ?? "-"}，状态 ${
          summary?.status ?? "-"
        }，角色 ${summary?.counts?.roles ?? 0}，幕 ${summary?.counts?.acts ?? 0}。`
      );
      await refreshDetail();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "生成 RuntimeDefinition 失败。");
    } finally {
      setBusy(false);
    }
  }

  function renderActivePanel() {
    switch (activePanel) {
      case "upload":
        return (
          <section>
            <h2 className="text-lg font-semibold text-ink">上传资料</h2>
            <p className="mt-2 text-sm leading-6 text-ink/60">
              每次建议先完成一个角色的玩家 PDF 和 AI DOCX，再处理下一个角色。
            </p>
            {assetKind === "ROLE_BOOKLET" ? <div className="mt-3 grid gap-2 md:grid-cols-4">
              <label className="text-sm">资料标识（同本PDF/DOCX相同）<input className="w-full rounded border p-2" value={readingBookKey} onChange={e => setReadingBookKey(e.target.value)} placeholder="留空兼容原单本" /></label>
              <label className="text-sm">阅读顺序<input type="number" min="0" className="w-full rounded border p-2" value={readingOrder} onChange={e => setReadingOrder(e.target.value)} /></label>
              <label className="text-sm">前置选择ID（可选）<input className="w-full rounded border p-2" value={readingChoiceId} onChange={e => setReadingChoiceId(e.target.value)} /></label>
              <label className="text-sm">所需选项ID<input className="w-full rounded border p-2" disabled={!readingChoiceId} value={readingOptionId} onChange={e => setReadingOptionId(e.target.value)} /></label>
            </div> : null}
            <div className="mt-4 grid gap-3 md:grid-cols-[150px_150px_170px_minmax(0,1fr)_auto]">
              <select
                className="h-10 rounded-md border border-ink/15 bg-paper px-3 text-sm text-ink outline-none focus:border-pine"
                value={assetKind}
                onChange={(event) => setAssetKind(event.target.value)}
              >
                <option value="DM_MANUAL">DM 手册</option>
                <option value="ROLE_BOOKLET">角色本</option>
                <option value="CLUE">线索</option>
                <option value="IMAGE">图片</option>
                <option value="OTHER">其他</option>
              </select>
              <select
                className="h-10 rounded-md border border-ink/15 bg-paper px-3 text-sm text-ink outline-none focus:border-pine disabled:text-ink/30"
                disabled={assetKind !== "ROLE_BOOKLET"}
                value={assetPurpose}
                onChange={(event) => setAssetPurpose(event.target.value)}
              >
                <option value="PLAYER_DISPLAY">玩家 PDF</option>
                <option value="AI_TEXT_SOURCE">AI DOCX</option>
                <option value="BOTH">兼用</option>
              </select>
              <input
                className="h-10 rounded-md border border-ink/15 bg-paper px-3 py-2 text-sm text-ink disabled:text-ink/30"
                disabled={assetKind !== "ROLE_BOOKLET"}
                placeholder="角色名，角色本必填"
                value={roleName}
                onChange={(event) => setRoleName(event.target.value)}
              />
              <input
                className="h-10 min-w-0 rounded-md border border-ink/15 bg-paper px-3 py-2 text-sm text-ink"
                type="file"
                accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
              />
              <button
                className="rounded-md bg-pine px-4 py-2 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:bg-ink/25"
                disabled={busy}
                onClick={() => void uploadAsset()}
              >
                上传
              </button>
            </div>
            <AssetList
              assets={assets}
              parsedDocuments={parsedDocuments}
              busy={busy}
              onParseAsset={parseAsset}
              onDeleteAsset={deleteAsset}
            />
          </section>
        );
      case "roleSplit":
        return (
          <section>
            <h2 className="text-lg font-semibold text-ink">角色剧本分幕</h2>
            <p className="mt-2 text-sm leading-6 text-ink/60">
              进入某个角色模块后，先设置玩家 PDF 页码，再用 DOCX 结束语切分 AI 文本。
            </p>
            <RoleBookletManager
              detailId={detail.id}
              assets={assets}
              parsedDocuments={parsedDocuments}
              sections={documentSections}
              busy={busy}
              onBusyChange={setBusy}
              onError={setErrorText}
              onRefresh={refreshDetail}
            />
          </section>
        );
      case "roleParse":
        return (
          <section>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-ink">角色结构化解析</h2>
                <p className="mt-2 text-sm leading-6 text-ink/60">
                  从每个角色每一幕的 AI 文本源生成 RoleActBooklet。
                </p>
              </div>
              <button
                className="rounded-md bg-pine px-3 py-2 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:bg-ink/25"
                disabled={busy}
                onClick={() => void parseAllRoleActBooklets()}
              >
                解析全部角色本
              </button>
            </div>
            <RoleActBookletManager
              sections={documentSections}
              roleActBooklets={roleActBooklets}
              busy={busy}
              onParseOne={parseOneRoleActBooklet}
            />
          </section>
        );
      case "dmFlow":
        return (
          <section>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-ink">DM 手册结构化解析</h2>
                <p className="mt-2 text-sm leading-6 text-ink/60">
                  Semantic v2 · 候选解析 · 不替换正式定义
                </p>
              </div>
              <button
                className="rounded-md bg-pine px-3 py-2 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:bg-ink/25"
                disabled={busy}
                onClick={() => void parseAllDMFlow()}
              >
                生成全手册语义候选
              </button>
            </div>
            <ManualSemanticCandidates scriptPackageId={detail.id} refreshKey={candidateRefresh} />
            <DMFlowManager
              sections={documentSections}
              dmFlow={dmFlow}
              busy={busy}
              onParseOne={parseOneDMSection}
            />
          </section>
        );
      case "runtime":
        return (
          <section>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-ink">生成可运行剧本</h2>
                <p className="mt-2 text-sm leading-6 text-ink/60">
                  编译 RoleActBooklet、DMFlow、玩家 PDF section 和线索占位。
                </p>
              </div>
              <button
                className="rounded-md bg-pine px-3 py-2 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:bg-ink/25"
                disabled={busy}
                onClick={() => void compileRuntimeDefinition()}
              >
                {runtimeDefinition ? "重新生成 RuntimeDefinition" : "生成 RuntimeDefinition"}
              </button>
            </div>
            <RuntimeDefinitionPanel
              runtimeDefinition={runtimeDefinition}
              busy={busy}
              onStartFullGame={() => runtimeDefinition && void startGame(runtimeDefinition.id)}
              onStartTestGame={startRuntimeDefinitionTestGame}
            />
          </section>
        );
      case "documents":
        return (
          <section>
            <h2 className="text-lg font-semibold text-ink">Parsed Documents</h2>
            <ParsedDocumentList
              parsedDocuments={parsedDocuments}
              assets={assets}
              busy={busy}
              onSegmentDocument={segmentDocument}
            />
          </section>
        );
      case "jobs":
        return (
          <section>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-ink">Ingestion Jobs</h2>
              <button
                className="rounded-md border border-ink/15 px-3 py-2 text-sm font-semibold text-ink transition hover:bg-paper disabled:text-ink/30"
                disabled={busy}
                onClick={() => void createIngestionJob()}
              >
                创建解析任务
              </button>
            </div>
            <JobList jobs={ingestionJobs} />
          </section>
        );
      case "scriptJson":
        return (
          <section>
            <h2 className="text-lg font-semibold text-ink">scriptJson</h2>
            <button
              className="mt-4 rounded-md bg-ember px-3 py-2 text-sm font-semibold text-white transition hover:bg-ember/90 disabled:bg-ink/25"
              disabled={busy}
              onClick={() => void loadScriptJson()}
            >
              我理解剧透风险，查看 scriptJson
            </button>
            {scriptJson ? <CodeBlock value={scriptJson} /> : null}
          </section>
        );
      case "sections":
        return (
          <section>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-ink">Document Sections</h2>
                <p className="mt-2 text-sm leading-7 text-ink/64">
                  切分后的原文片段，仅供管理者检查。
                </p>
              </div>
              {!managementUnlocked ? (
                <button
                  className="rounded-md bg-ember px-3 py-2 text-xs font-semibold text-white transition hover:bg-ember/90"
                  onClick={unlockManagement}
                >
                  解锁
                </button>
              ) : null}
            </div>
            {managementUnlocked ? (
              <DocumentSectionList sections={documentSections} />
            ) : (
              <p className="mt-4 rounded-md bg-ember/10 p-3 text-sm leading-6 text-ember">
                管理模式包含角色秘密、DM 流程和最终真相。请确认管理者视角后查看。
              </p>
            )}
          </section>
        );
      default:
        return null;
    }
  }

  return (
    <div className="grid min-w-0 gap-6">
      <section className="min-w-0 space-y-6">
        <section className="rounded-lg border border-ink/10 bg-white/90 p-5 shadow-panel">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-ink">基础信息</h2>
              <p className="mt-2 text-sm leading-7 text-ink/64">
                {detail.isDefaultDemo ? "默认 demo 剧本包" : "自定义剧本包"} · 创建于{" "}
                {formatDate(detail.createdAt)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <StoryBoardOption enabled={boardEnabled} onChange={setBoardEnabled} disabled={busy} />
              <button
                className="rounded-md bg-pine px-3 py-2 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:bg-ink/25"
                disabled={busy}
                onClick={() => void startGame()}
              >
                从此剧本开始游戏
              </button>
              <button
                className="rounded-md border border-ink/15 px-3 py-2 text-sm font-semibold text-ink transition hover:bg-paper"
                disabled={busy}
                onClick={() => void rerunValidation()}
              >
                重新校验
              </button>
            </div>
          </div>
          <ValidationPanel validation={detail.validation} />
          {errorText ? <p className="mt-3 text-sm leading-6 text-ember">{errorText}</p> : null}
        </section>

        <RecoverableGameSessionsPanel
          sessions={recoverableGameSessions}
          busy={busy}
          onContinue={(gameId) => router.push(`/games/${gameId}`)}
          onRefresh={() => void refreshDetail()}
        />

        <WorkflowBoard
          runtimeDefinition={runtimeDefinition}
          dmFlow={dmFlow}
          roleActBooklets={roleActBooklets}
          documentSections={documentSections}
          onOpen={setActivePanel}
        />

        <OperationModal
          title={activePanel ? formatActivePanelTitle(activePanel) : ""}
          open={Boolean(activePanel)}
          onClose={() => setActivePanel(null)}
        >
          {renderActivePanel()}
        </OperationModal>

        {false ? (
          <>
        <section className="rounded-lg border border-ink/10 bg-white/90 p-5 shadow-panel">
          <h2 className="text-lg font-semibold text-ink">上传资料</h2>
          <p className="mt-2 text-sm leading-6 text-ink/60">
            角色剧本推荐同时上传玩家阅读 PDF 和 AI 解析 DOCX。PDF 用于玩家读本展示和分幕页码；DOCX 用于 AI 文本解析，减少 PDF 换行错乱。只传 PDF 也能继续，但 AI 文本可能不稳定；只传 DOCX 时无法提供页面式读本展示。
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-[150px_150px_170px_1fr_auto]">
            <select
              className="h-10 rounded-md border border-ink/15 bg-paper px-3 text-sm text-ink outline-none focus:border-pine"
              value={assetKind}
              onChange={(event) => setAssetKind(event.target.value)}
            >
              <option value="DM_MANUAL">DM 手册</option>
              <option value="ROLE_BOOKLET">角色本</option>
              <option value="CLUE">线索</option>
              <option value="IMAGE">图片</option>
              <option value="OTHER">其他</option>
            </select>
            <select
              className="h-10 rounded-md border border-ink/15 bg-paper px-3 text-sm text-ink outline-none focus:border-pine disabled:text-ink/30"
              disabled={assetKind !== "ROLE_BOOKLET"}
              value={assetPurpose}
              onChange={(event) => setAssetPurpose(event.target.value)}
            >
              <option value="PLAYER_DISPLAY">玩家 PDF</option>
              <option value="AI_TEXT_SOURCE">AI DOCX</option>
              <option value="BOTH">兼用</option>
            </select>
            <input
              className="h-10 rounded-md border border-ink/15 bg-paper px-3 py-2 text-sm text-ink disabled:text-ink/30"
              disabled={assetKind !== "ROLE_BOOKLET"}
              placeholder="角色名，角色本必填"
              value={roleName}
              onChange={(event) => setRoleName(event.target.value)}
            />
            <input
              className="h-10 rounded-md border border-ink/15 bg-paper px-3 py-2 text-sm text-ink"
              type="file"
              accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
            />
            <button
              className="rounded-md bg-pine px-4 py-2 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:bg-ink/25"
              disabled={busy}
              onClick={() => void uploadAsset()}
            >
              上传
            </button>
          </div>
          <AssetList
            assets={assets}
            parsedDocuments={parsedDocuments}
            busy={busy}
            onParseAsset={parseAsset}
            onDeleteAsset={deleteAsset}
          />
        </section>

        <section className="rounded-lg border border-ink/10 bg-white/90 p-5 shadow-panel">
          <h2 className="text-lg font-semibold text-ink">角色剧本分幕</h2>
          <p className="mt-2 text-sm leading-6 text-ink/60">
            角色剧本不做自动幕标题切分。请按玩家阅读 PDF 的真实页码输入每一幕起始页；DOCX 作为 AI 文本源，可用统一每幕结束语切分出每幕 AI 可读文本。
          </p>
          <RoleBookletManager
            detailId={detail.id}
            assets={assets}
            parsedDocuments={parsedDocuments}
            sections={documentSections}
            busy={busy}
            onBusyChange={setBusy}
            onError={setErrorText}
            onRefresh={refreshDetail}
          />
        </section>

        <section className="rounded-lg border border-ink/10 bg-white/90 p-5 shadow-panel">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-ink">角色结构化解析</h2>
              <p className="mt-2 text-sm leading-6 text-ink/60">
                从每个角色每一幕的 AI 文本源生成 RoleActBooklet。本区域是管理调试视图，可能包含角色秘密；玩家读本页面不会访问这些结果。
              </p>
            </div>
            <button
              className="rounded-md bg-pine px-3 py-2 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:bg-ink/25"
              disabled={busy}
              onClick={() => void parseAllRoleActBooklets()}
            >
              解析全部角色本
            </button>
          </div>
          <RoleActBookletManager
            sections={documentSections}
            roleActBooklets={roleActBooklets}
            busy={busy}
            onParseOne={parseOneRoleActBooklet}
          />
        </section>

        <section className="rounded-lg border border-ink/10 bg-white/90 p-5 shadow-panel">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-ink">生成可运行剧本</h2>
              <p className="mt-2 text-sm leading-6 text-ink/60">
                将 RoleActBooklet、DMFlow、玩家 PDF section 和线索占位编译成 RuntimeDefinition。本阶段只生成管理数据，不替换当前 demo runtime。
              </p>
            </div>
            <button
              className="rounded-md bg-pine px-3 py-2 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:bg-ink/25"
              disabled={busy}
              onClick={() => void compileRuntimeDefinition()}
            >
              {runtimeDefinition ? "重新生成 RuntimeDefinition" : "生成 RuntimeDefinition"}
            </button>
          </div>
          <RuntimeDefinitionPanel
            runtimeDefinition={runtimeDefinition}
            busy={busy}
            onStartFullGame={() => runtimeDefinition && void startGame(runtimeDefinition.id)}
            onStartTestGame={startRuntimeDefinitionTestGame}
          />
        </section>

        <section className="rounded-lg border border-ink/10 bg-white/90 p-5 shadow-panel">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-ink">DM 手册结构化解析</h2>
              <p className="mt-2 text-sm leading-6 text-ink/60">
                从 dm_opening、dm_act、dm_ending section 生成 DMFlow。本区域属于管理模式，玩家页面不会访问完整 DMFlow、结局揭示或禁止公开内容。
              </p>
            </div>
            <button
              className="rounded-md bg-pine px-3 py-2 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:bg-ink/25"
              disabled={busy}
              onClick={() => void parseAllDMFlow()}
            >
              解析全部 DM 手册
            </button>
          </div>
          <DMFlowManager
            sections={documentSections}
            dmFlow={dmFlow}
            busy={busy}
            onParseOne={parseOneDMSection}
          />
        </section>

        <section className="rounded-lg border border-ink/10 bg-white/90 p-5 shadow-panel">
          <h2 className="text-lg font-semibold text-ink">Parsed Documents</h2>
          <ParsedDocumentList
            parsedDocuments={parsedDocuments}
            assets={assets}
            busy={busy}
            onSegmentDocument={segmentDocument}
          />
        </section>

        <section className="rounded-lg border border-ink/10 bg-white/90 p-5 shadow-panel">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-ink">Ingestion Jobs</h2>
            <button
              className="rounded-md border border-ink/15 px-3 py-2 text-sm font-semibold text-ink transition hover:bg-paper disabled:text-ink/30"
              disabled={busy}
              onClick={() => void createIngestionJob()}
            >
              创建解析任务
            </button>
          </div>
          <JobList jobs={ingestionJobs} />
        </section>
          </>
        ) : null}
      </section>

      <aside className="hidden space-y-6">
        <section className="rounded-lg border border-ember/20 bg-white/90 p-5 shadow-panel">
          <h2 className="text-lg font-semibold text-ink">管理模式</h2>
          <p className="mt-2 text-sm leading-7 text-ink/64">
            完整 scriptJson 可能包含角色秘密、DM 流程和最终真相。玩家模式不会显示这些内容。
          </p>
          <button
            className="mt-4 rounded-md bg-ember px-3 py-2 text-sm font-semibold text-white transition hover:bg-ember/90 disabled:bg-ink/25"
            disabled={busy}
            onClick={() => void loadScriptJson()}
          >
            我理解剧透风险，查看 scriptJson
          </button>
          {scriptJson ? (
            <pre className="mt-4 max-h-[520px] overflow-auto rounded-md bg-ink p-4 text-xs leading-5 text-white">
              {scriptJson}
            </pre>
          ) : null}
        </section>

        <section className="rounded-lg border border-ember/20 bg-white/90 p-5 shadow-panel">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-ink">Document Sections</h2>
              <p className="mt-2 text-sm leading-7 text-ink/64">
                这里会显示切分后的原文片段，仅供管理者检查。
              </p>
            </div>
            {!managementUnlocked ? (
              <button
                className="rounded-md bg-ember px-3 py-2 text-xs font-semibold text-white transition hover:bg-ember/90"
                onClick={unlockManagement}
              >
                解锁
              </button>
            ) : null}
          </div>
          {managementUnlocked ? (
            <>
              <DocumentSectionList sections={documentSections} />
            </>
          ) : (
            <p className="mt-4 rounded-md bg-ember/10 p-3 text-sm leading-6 text-ember">
              管理模式包含角色秘密、DM 流程和最终真相。请确认管理者视角后查看。
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}

function ValidationPanel({ validation }: { validation: SafeDetail["validation"] }) {
  return (
    <div className="mt-4 rounded-md bg-paper/70 p-4">
      <div className="flex items-center gap-2">
        <ValidationBadge status={validation.status} />
        <p className="text-sm text-ink/64">{validation.issues.length} 项校验信息</p>
      </div>
      {validation.issues.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {validation.issues.map((issue, index) => (
            <li key={`${issue.path}_${index}`} className="text-sm leading-6 text-ink/72">
              <span className={issue.level === "error" ? "font-semibold text-ember" : "font-semibold text-brass"}>
                {issue.level}
              </span>{" "}
              {issue.path}: {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function WorkflowBoard({
  runtimeDefinition,
  dmFlow,
  roleActBooklets,
  documentSections,
  onOpen
}: {
  runtimeDefinition: RuntimeDefinitionView | null;
  dmFlow: DMFlowView | null;
  roleActBooklets: RoleActBookletView[];
  documentSections: DocumentSectionView[];
  onOpen: (panel: ActivePanel) => void;
}) {
  const roleNames = Array.from(
    new Set(
      [
        ...roleActBooklets.map((booklet) => booklet.roleName),
        ...documentSections.map((section) => section.roleName).filter(Boolean)
      ] as string[]
    )
  ).sort((left, right) => left.localeCompare(right, "zh-CN"));

  return (
    <section className="rounded-lg border border-ink/10 bg-white/90 p-5 shadow-panel">
      <div>
        <h2 className="text-lg font-semibold text-ink">制作工作台</h2>
        <p className="mt-2 text-sm leading-6 text-ink/60">
          建议按顺序操作：上传资料、逐个角色完成分幕、解析角色本、解析 DM 手册、生成可运行剧本。结果查看都在弹窗中进行，避免页面被长文本撑宽。
        </p>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <WorkflowCard index="1" title="上传资料" meta="PDF / DOCX / DM 手册" onClick={() => onOpen("upload")} />
        <WorkflowCard index="2" title="角色分幕" meta={`${roleNames.length} 个角色`} onClick={() => onOpen("roleSplit")} />
        <WorkflowCard index="3" title="角色解析" meta={`${roleActBooklets.length} 个结果`} onClick={() => onOpen("roleParse")} />
        <WorkflowCard index="4" title="DM 解析" meta={dmFlow ? formatDMFlowParseStatus(dmFlow.parseStatus) : "未解析"} onClick={() => onOpen("dmFlow")} />
        <WorkflowCard index="5" title="生成 Runtime" meta={runtimeDefinition ? formatRuntimeDefinitionStatus(runtimeDefinition.validationReport.status) : "未生成"} onClick={() => onOpen("runtime")} />
        <WorkflowCard index="6" title="文档切分" meta={`${documentSections.length} 个 section`} onClick={() => onOpen("documents")} />
        <WorkflowCard index="7" title="解析任务" meta="Ingestion Jobs" onClick={() => onOpen("jobs")} />
        <WorkflowCard index="8" title="管理查看" meta="scriptJson / sections" onClick={() => onOpen("sections")} />
      </div>
      {roleNames.length > 0 ? (
        <div className="mt-5">
          <p className="text-sm font-semibold text-ink">角色模块</p>
          <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {roleNames.map((roleName) => {
              const parsedCount = roleActBooklets.filter((booklet) => booklet.roleName === roleName).length;
              const sectionCount = documentSections.filter((section) => section.roleName === roleName).length;

              return (
                <button
                  key={roleName}
                  className="rounded-md border border-ink/10 bg-paper p-3 text-left transition hover:border-pine/35 hover:bg-white"
                  onClick={() => onOpen("roleSplit")}
                >
                  <p className="text-sm font-semibold text-ink">{roleName}</p>
                  <p className="mt-1 text-xs leading-5 text-ink/55">
                    section {sectionCount} · 解析 {parsedCount}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function WorkflowCard({
  index,
  title,
  meta,
  onClick
}: {
  index: string;
  title: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button
      className="rounded-md border border-ink/10 bg-paper p-4 text-left transition hover:border-pine/35 hover:bg-white"
      onClick={onClick}
    >
      <p className="text-xs font-semibold text-pine">{index}</p>
      <p className="mt-2 text-sm font-semibold text-ink">{title}</p>
      <p className="mt-1 text-xs leading-5 text-ink/55">{meta}</p>
    </button>
  );
}

function OperationModal({
  title,
  open,
  onClose,
  children
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/35 p-3 md:p-6">
      <div className="mx-auto flex h-full w-full max-w-[1280px] min-w-0 flex-col overflow-hidden rounded-lg bg-white shadow-panel">
        <div className="flex items-center justify-between gap-3 border-b border-ink/10 px-5 py-4">
          <h2 className="min-w-0 truncate text-lg font-semibold text-ink">{title}</h2>
          <button
            className="rounded-md border border-ink/15 px-3 py-2 text-sm font-semibold text-ink transition hover:bg-paper"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
        <div className="min-w-0 flex-1 overflow-auto p-5">{children}</div>
      </div>
    </div>
  );
}

function CodeBlock({ value }: { value: string }) {
  return (
    <pre className="mt-3 max-h-[520px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-ink p-4 text-xs leading-5 text-white">
      {value}
    </pre>
  );
}

function AssetList({
  assets,
  parsedDocuments,
  busy,
  onParseAsset,
  onDeleteAsset
}: {
  assets: AssetView[];
  parsedDocuments: ParsedDocumentView[];
  busy: boolean;
  onParseAsset: (asset: AssetView) => void;
  onDeleteAsset: (asset: AssetView) => void;
}) {
  if (assets.length === 0) {
    return <p className="mt-4 text-sm text-ink/55">还没有上传资料。</p>;
  }

  return (
    <div className="mt-4 divide-y divide-ink/10 rounded-md border border-ink/10">
      {assets.map((asset) => {
        const parsedDocument = parsedDocuments.find(
          (candidate) => candidate.uploadedAssetId === asset.id
        );
        const isSupported = isSupportedTextAsset(asset);

        return (
          <div
            key={asset.id}
            className="grid gap-2 p-3 text-sm md:grid-cols-[120px_1fr_100px_120px_120px_190px]"
          >
            <p className="font-semibold text-ink">{asset.kind}</p>
            <div className="min-w-0">
              <p className="truncate text-ink/70">{asset.originalName}</p>
              <p className="mt-1 text-xs text-ink/45">{formatAssetPurpose(asset.assetPurpose)}</p>
              {!isSupported ? (
                <p className="mt-1 text-xs text-ink/45">当前阶段仅支持 DOCX 和 PDF 文本抽取。</p>
              ) : null}
              {parsedDocument?.errorMessage ? (
                <p className="mt-1 text-xs leading-5 text-ember">
                  {parsedDocument.errorMessage}
                </p>
              ) : null}
            </div>
            <p className="text-ink/55">{asset.roleName ?? "-"}</p>
            <p className="text-ink/55">{formatBytes(asset.sizeBytes)}</p>
            <p className="text-ink/55">{parsedDocument?.parseStatus ?? asset.parseStatus}</p>
            <div className="flex flex-wrap gap-2">
              {isSupported ? (
                <button
                  className="rounded-md border border-ink/15 px-3 py-2 text-xs font-semibold text-ink transition hover:bg-paper disabled:text-ink/30"
                  disabled={busy}
                  onClick={() => onParseAsset(asset)}
                >
                  解析文本
                </button>
              ) : (
                <p className="text-xs leading-5 text-ink/45">不支持</p>
              )}
              <button
                className="rounded-md border border-ember/20 px-3 py-2 text-xs font-semibold text-ember transition hover:bg-ember/10 disabled:text-ink/30"
                disabled={busy}
                onClick={() => onDeleteAsset(asset)}
              >
                删除
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RoleBookletManager({
  detailId,
  assets,
  parsedDocuments,
  sections,
  busy,
  onBusyChange,
  onError,
  onRefresh
}: {
  detailId: string;
  assets: AssetView[];
  parsedDocuments: ParsedDocumentView[];
  sections: DocumentSectionView[];
  busy: boolean;
  onBusyChange: (value: boolean) => void;
  onError: (value: string | null) => void;
  onRefresh: () => Promise<void>;
}) {
  const roleGroups = buildRoleBookletGroups(assets, parsedDocuments, sections);

  if (roleGroups.length === 0) {
    return <p className="mt-4 text-sm leading-6 text-ink/55">还没有角色剧本。上传 ROLE_BOOKLET 后会在这里按角色聚合。</p>;
  }

  return (
    <div className="mt-4 space-y-4">
      {roleGroups.map((group) => (
        <RoleBookletCard
          key={`${group.roleName}:${group.bookKey}`}
          detailId={detailId}
          group={group}
          busy={busy}
          onBusyChange={onBusyChange}
          onError={onError}
          onRefresh={onRefresh}
        />
      ))}
    </div>
  );
}

type RoleBookletGroup = {
  bookKey: string;
  roleName: string;
  displayAsset: AssetView | null;
  textAsset: AssetView | null;
  displayDocument: ParsedDocumentView | null;
  textDocument: ParsedDocumentView | null;
  displaySections: DocumentSectionView[];
  aiSections: DocumentSectionView[];
};

function RoleBookletCard({
  detailId,
  group,
  busy,
  onBusyChange,
  onError,
  onRefresh
}: {
  detailId: string;
  group: RoleBookletGroup;
  busy: boolean;
  onBusyChange: (value: boolean) => void;
  onError: (value: string | null) => void;
  onRefresh: () => Promise<void>;
}) {
  const [rows, setRows] = useState(() => {
    if (group.displaySections.length > 0) {
      return group.displaySections.map((section) => ({
        actIndex: section.actIndex ?? 1,
        pageStart: section.pageStart ?? 1,
        title: section.title
      }));
    }

    return [
      { actIndex: 1, pageStart: 1, title: "第一幕" },
      { actIndex: 2, pageStart: 2, title: "第二幕" },
      { actIndex: 3, pageStart: 3, title: "第三幕" }
    ];
  });
  const [expectedActCount, setExpectedActCount] = useState(
    group.displaySections.length > 0 ? String(group.displaySections.length) : ""
  );
  const [commonEndMarker, setCommonEndMarker] = useState("");
  const aiStatus = getAiTextStatus(group);
  const pageCount = group.displayDocument?.pageCount ?? 0;

  function updateRow(index: number, field: "actIndex" | "pageStart" | "title", value: string) {
    setRows((current) =>
      current.map((row, rowIndex) =>
        rowIndex === index
          ? {
              ...row,
              [field]: field === "title" ? value : Number(value)
            }
          : row
      )
    );
  }

  function addRow() {
    setRows((current) => [
      ...current,
      {
        actIndex: current.length + 1,
        pageStart: pageCount ? Math.min(pageCount, current.length + 1) : current.length + 1,
        title: `第${current.length + 1}幕`
      }
    ]);
  }

  function renumberActs() {
    setRows((current) =>
      current.map((row, index) => ({
        ...row,
        actIndex: index + 1
      }))
    );
  }

  async function submitManualActs() {
    if (!group.displayAsset) {
      onError("请先上传玩家阅读 PDF，才能设置正式分幕页码。");
      return;
    }

    onBusyChange(true);
    onError(null);

    try {
      const response = await fetch(
        `/api/script-packages/${detailId}/role-booklets/${encodeURIComponent(group.roleName)}/manual-acts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            roleName: group.roleName,
            displayAssetId: group.displayAsset.id,
            textAssetId: group.textAsset?.id ?? null,
            actStartPages: rows
          })
        }
      );
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "角色剧本分幕失败。"));
      }

      if (typeof payload.segmentationError === "string" && payload.segmentationError) {
        onError(payload.segmentationError);
      }

      await onRefresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : "角色剧本分幕失败。");
    } finally {
      onBusyChange(false);
    }
  }

  async function submitTextActs() {
    if (!group.textAsset) {
      onError("请先上传 AI 文本 DOCX。");
      return;
    }

    onBusyChange(true);
    onError(null);

    try {
      const response = await fetch(
        `/api/script-packages/${detailId}/role-booklets/${encodeURIComponent(group.roleName)}/manual-text-acts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            roleName: group.roleName,
            textAssetId: group.textAsset.id,
            expectedActCount: expectedActCount.trim() ? Number(expectedActCount) : null,
            startActIndex: rows[0]?.actIndex ?? 1,
            commonEndMarker
          })
        }
      );
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "DOCX AI 文本切分失败。"));
      }

      onError(`DOCX AI 文本切分完成，匹配到 ${payload.matchCount ?? "-"} 次结束语。`);
      await onRefresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : "DOCX AI 文本切分失败。");
    } finally {
      onBusyChange(false);
    }
  }

  return (
    <article className="rounded-md border border-ink/10 bg-paper/70 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-ink">{group.roleName}{group.bookKey !== "legacy" ? ` · ${group.bookKey}` : ""}</h3>
          <p className="mt-1 text-xs leading-5 text-ink/55">
            玩家阅读 PDF：{group.displayAsset ? group.displayAsset.originalName : "未上传"} · AI 解析 DOCX：{group.textAsset ? group.textAsset.originalName : "未上传"}
          </p>
          <p className="mt-1 text-xs leading-5 text-ink/55">
            PDF 页数：{pageCount || "请先解析 PDF"} · 分幕状态：{group.displaySections.length > 0 ? "已设置" : "未设置"} · AI 文本状态：{aiStatus}
          </p>
        </div>
      </div>
      {!group.displayAsset ? (
        <p className="mt-3 rounded-sm bg-brass/10 p-2 text-xs leading-5 text-brass">
          缺少 PDF，无法提供页面式玩家读本展示。请上传玩家阅读 PDF。
        </p>
      ) : null}
      {!group.textAsset ? (
        <p className="mt-3 rounded-sm bg-brass/10 p-2 text-xs leading-5 text-brass">
          未上传 DOCX，后续 AI 会尝试使用 PDF 抽取文本，可能受换行错乱影响，建议补传 DOCX。
        </p>
      ) : null}
      {group.displayDocument?.qualityStatus === "FAILED" && !group.textAsset ? (
        <p className="mt-3 rounded-sm bg-ember/10 p-2 text-xs leading-5 text-ember">
          PDF 文本质量未通过且没有 DOCX，不能进入后续 AI 结构化解析。
        </p>
      ) : null}
      <p className="mt-3 text-xs leading-5 text-ink/55">
        幕号表示第几幕，通常填 1、2、3；PDF 起始页才是玩家读本里的页码。
      </p>
      <div className="mt-4 grid grid-cols-[88px_120px_1fr] gap-2 text-xs font-semibold text-ink/55">
        <p>幕号</p>
        <p>PDF 起始页</p>
        <p>标题</p>
      </div>
      <div className="mt-2 space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="grid grid-cols-[88px_120px_1fr] gap-2">
            <input
              aria-label="幕号，不是页码"
              className="h-9 rounded-md border border-ink/15 bg-white px-2 text-xs text-ink"
              min={1}
              type="number"
              value={row.actIndex}
              onChange={(event) => updateRow(index, "actIndex", event.target.value)}
            />
            <input
              aria-label="PDF 起始页"
              className="h-9 rounded-md border border-ink/15 bg-white px-2 text-xs text-ink"
              min={1}
              max={pageCount || undefined}
              type="number"
              value={row.pageStart}
              onChange={(event) => updateRow(index, "pageStart", event.target.value)}
            />
            <input
              className="h-9 rounded-md border border-ink/15 bg-white px-2 text-xs text-ink"
              value={row.title}
              onChange={(event) => updateRow(index, "title", event.target.value)}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="rounded-md border border-ink/15 px-3 py-2 text-xs font-semibold text-ink transition hover:bg-white disabled:text-ink/30"
          disabled={busy}
          onClick={addRow}
        >
          添加一幕
        </button>
        <button
          className="rounded-md border border-ink/15 px-3 py-2 text-xs font-semibold text-ink transition hover:bg-white disabled:text-ink/30"
          disabled={busy}
          onClick={renumberActs}
        >
          按顺序重编号
        </button>
        <button
          className="rounded-md bg-pine px-3 py-2 text-xs font-semibold text-white transition hover:bg-pine/90 disabled:bg-ink/25"
          disabled={busy || !group.displayAsset}
          onClick={() => void submitManualActs()}
        >
          保存分幕页码
        </button>
      </div>
      {group.displaySections.length > 0 ? (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {group.displaySections.map((section) => (
            <div key={section.id} className="rounded-sm bg-white/75 p-2 text-xs leading-5 text-ink/65">
              {section.title} · 第 {section.pageStart ?? "-"}-{section.pageEnd ?? "-"} 页
            </div>
          ))}
        </div>
      ) : null}
      {group.aiSections.length > 0 ? (
        <div className="mt-3 rounded-sm bg-white/70 p-3 text-xs leading-5 text-ink/60">
          <p className="font-semibold text-ink">AI 文本源状态</p>
          {group.aiSections.map((section) => (
            <p key={section.id} className="mt-1">
              {section.title}：
              {section.text
                ? group.textAsset
                  ? "DOCX 已切分"
                  : "使用 PDF fallback 文本"
                : "使用 DOCX，待统一结束语切分"}
            </p>
          ))}
        </div>
      ) : null}
      {group.textAsset ? (
        <section className="mt-4 rounded-md border border-ink/10 bg-white/70 p-3">
          <p className="text-sm font-semibold text-ink">DOCX AI 文本分幕</p>
          <p className="mt-2 text-xs leading-5 text-ink/55">
            多数角色本每一幕结尾会使用相同提示语。请填写这个统一结束语，例如“请等待 DM 指示”。系统会在 DOCX 文本中查找该结束语出现的位置，并按出现顺序切分每一幕。最后一幕没有结束语也可以：如果预期 6 幕、匹配到 5 次，最后一幕会从第 5 次结束语后切到文件末尾。
          </p>
          {group.textDocument?.normalizedText ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-semibold text-pine">
                查看 DOCX normalizedText 预览
              </summary>
              <pre className="mt-2 max-h-[220px] overflow-auto rounded-md bg-paper p-3 text-xs leading-5 text-ink/70">
                {group.textDocument.normalizedText.slice(0, 5000)}
              </pre>
            </details>
          ) : (
            <p className="mt-3 rounded-sm bg-brass/10 p-2 text-xs leading-5 text-brass">
              请先在上传资料列表里解析该 DOCX，生成 normalizedText 后再切分。
            </p>
          )}
          <div className="mt-3 grid gap-2 md:grid-cols-[120px_1fr_auto]">
            <input
              className="h-9 rounded-md border border-ink/15 bg-white px-2 text-xs text-ink"
              min={1}
              placeholder="预期幕数，可选"
              type="number"
              value={expectedActCount}
              onChange={(event) => setExpectedActCount(event.target.value)}
            />
            <input
              className="h-9 rounded-md border border-ink/15 bg-white px-2 text-xs text-ink"
              placeholder="统一每幕结束语，例如：请合上剧本，等待下一阶段。"
              value={commonEndMarker}
              onChange={(event) => setCommonEndMarker(event.target.value)}
            />
            <button
              className="rounded-md bg-pine px-3 py-2 text-xs font-semibold text-white transition hover:bg-pine/90 disabled:bg-ink/25"
              disabled={busy || !group.textDocument?.normalizedText}
              onClick={() => void submitTextActs()}
            >
              切分 AI 文本
            </button>
          </div>
          {group.aiSections.some((section) => section.text.trim()) ? (
            <div className="mt-3 grid gap-2">
              {group.aiSections
                .filter((section) => section.text.trim())
                .map((section) => (
                  <details key={section.id} className="rounded-sm bg-paper p-2">
                    <summary className="cursor-pointer text-xs font-semibold text-ink">
                      {section.title} · {section.text.length} 字
                    </summary>
                    <p className="mt-2 line-clamp-6 whitespace-pre-line text-xs leading-5 text-ink/65">
                      {section.text}
                    </p>
                  </details>
                ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </article>
  );
}

function RoleActBookletManager({
  sections,
  roleActBooklets,
  busy,
  onParseOne
}: {
  sections: DocumentSectionView[];
  roleActBooklets: RoleActBookletView[];
  busy: boolean;
  onParseOne: (section: DocumentSectionView) => void;
}) {
  const aiSections = sections
    .filter((section) => section.sectionType === "role_act" && section.sectionPurpose === "AI_TEXT_SOURCE")
    .sort(
      (left, right) =>
        (left.roleName ?? "").localeCompare(right.roleName ?? "", "zh-CN") ||
        (left.actIndex ?? 0) - (right.actIndex ?? 0)
    );
  const displayOnlySections = sections
    .filter((section) => section.sectionType === "role_act" && section.sectionPurpose === "PLAYER_DISPLAY")
    .filter(
      (section) =>
        !aiSections.some(
          (aiSection) =>
            aiSection.roleName === section.roleName && aiSection.actIndex === section.actIndex
        )
    );

  if (aiSections.length === 0 && displayOnlySections.length === 0) {
    return (
      <p className="mt-4 text-sm leading-6 text-ink/55">
        还没有可解析的角色 AI 文本源。请先上传并解析 DOCX，再用统一结束语切分出 AI 文本 section。
      </p>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      {displayOnlySections.length > 0 ? (
        <div className="rounded-md border border-brass/20 bg-brass/5 p-3">
          <p className="text-sm font-semibold text-brass">缺少 AI 文本源</p>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {displayOnlySections.map((section) => (
              <p key={section.id} className="text-xs leading-5 text-ink/60">
                {section.roleName ?? "-"} · 第 {section.actIndex ?? "-"} 幕：无法结构化解析，请上传 DOCX 或等待 OCR 支持。
              </p>
            ))}
          </div>
        </div>
      ) : null}
      {aiSections.map((section) => {
        const booklet = roleActBooklets.find(
          (candidate) => candidate.sourceSectionId === section.id
        );
        const status = booklet?.parseStatus ?? "未解析";
        const hasText = section.text.trim().length > 0;

        return (
          <article key={section.id} className="rounded-md border border-ink/10 bg-paper/70 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-ink">
                  {section.roleName ?? "-"} · 第 {section.actIndex ?? "-"} 幕
                </p>
                <p className="mt-1 text-xs leading-5 text-ink/55">
                  来源：{section.uploadedAsset.originalName} · 状态：{formatBookletParseStatus(status)}
                </p>
              </div>
              <button
                className="rounded-md border border-ink/15 px-3 py-2 text-xs font-semibold text-ink transition hover:bg-white disabled:text-ink/30"
                disabled={busy || !hasText}
                onClick={() => onParseOne(section)}
              >
                {booklet ? "重新解析" : "解析"}
              </button>
            </div>
            {!hasText ? (
              <p className="mt-3 rounded-sm bg-brass/10 p-2 text-xs leading-5 text-brass">
                该 AI 文本源没有正文。请先使用统一结束语切分 DOCX。
              </p>
            ) : null}
            {booklet?.parseError ? (
              <p className="mt-3 rounded-sm bg-ember/10 p-2 text-xs leading-5 text-ember">
                {booklet.parseError}
              </p>
            ) : null}
            {booklet ? <RoleActBookletDetail booklet={booklet} /> : null}
          </article>
        );
      })}
    </div>
  );
}

function DMFlowManager({
  sections,
  dmFlow,
  busy,
  onParseOne
}: {
  sections: DocumentSectionView[];
  dmFlow: DMFlowView | null;
  busy: boolean;
  onParseOne: (section: DocumentSectionView) => void;
}) {
  const dmSections = sections
    .filter((section) => ["dm_opening", "dm_act", "dm_ending"].includes(section.sectionType))
    .sort(
      (left, right) =>
        dmSectionOrder(left.sectionType) - dmSectionOrder(right.sectionType) ||
        (left.actIndex ?? 0) - (right.actIndex ?? 0) ||
        left.orderIndex - right.orderIndex
    );

  if (dmSections.length === 0) {
    return (
      <p className="mt-4 text-sm leading-6 text-ink/55">
        还没有可解析的 DM 主流程 section。请先上传并解析 DM 手册。
      </p>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      <h3 className="text-sm font-semibold">历史 section 解析记录</h3>
      <div className="grid gap-2 md:grid-cols-2">
        {dmSections.map((section) => {
          const result = dmFlow?.sectionResults.find(
            (candidate) => candidate.sourceSectionId === section.id
          );
          const warningCount = result?.warningCount ?? 0;

          return (
            <article key={section.id} className="rounded-md border border-ink/10 bg-paper/70 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-ink">{formatDMSectionTitle(section)}</p>
                  <p className="mt-1 text-xs leading-5 text-ink/55">
                    {section.title} · {formatDMSectionParseStatus(result?.status)}
                    {warningCount > 0 ? ` · warning ${warningCount}` : ""}
                  </p>
                </div>
                <button
                  className="rounded-md border border-ink/15 px-3 py-2 text-xs font-semibold text-ink transition hover:bg-white disabled:text-ink/30"
                  disabled={busy || !section.text.trim()}
                  onClick={() => onParseOne(section)}
                >
                  生成范围语义候选
                </button>
              </div>
              {result?.parseError ? (
                <p className="mt-3 rounded-sm bg-ember/10 p-2 text-xs leading-5 text-ember">
                  {result.parseError}
                </p>
              ) : null}
              {result?.warnings.length ? (
                <ArrayBlock title="warnings" items={result.warnings} />
              ) : null}
            </article>
          );
        })}
      </div>

      {dmFlow ? <DMFlowDetail dmFlow={dmFlow} /> : null}
    </div>
  );
}

function RuntimeDefinitionPanel({
  runtimeDefinition,
  busy,
  onStartFullGame,
  onStartTestGame
}: {
  runtimeDefinition: RuntimeDefinitionView | null;
  busy: boolean;
  onStartFullGame: () => void;
  onStartTestGame: () => void;
}) {
  if (!runtimeDefinition) {
    return (
      <p className="mt-4 text-sm leading-6 text-ink/55">
        还没有生成 RuntimeDefinition。请先完成角色结构化解析和 DM 手册结构化解析。
      </p>
    );
  }

  const report = runtimeDefinition.validationReport;

  return (
    <div className="mt-4 space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-md bg-paper p-3">
          <p className="text-xs font-semibold text-ink/50">状态</p>
          <p className="mt-1 text-sm font-semibold text-ink">
            {formatRuntimeDefinitionStatus(report.status)}
          </p>
        </div>
        <div className="rounded-md bg-paper p-3">
          <p className="text-xs font-semibold text-ink/50">版本</p>
          <p className="mt-1 text-sm font-semibold text-ink">v{runtimeDefinition.version}</p>
        </div>
        <div className="rounded-md bg-paper p-3">
          <p className="text-xs font-semibold text-ink/50">最近编译</p>
          <p className="mt-1 text-sm font-semibold text-ink">
            {formatDate(runtimeDefinition.compiledAt)}
          </p>
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        <RuntimeCount label="roles" value={runtimeDefinition.definition.roles.length} />
        <RuntimeCount label="acts" value={runtimeDefinition.definition.acts.length} />
        <RuntimeCount label="roleBooklets" value={runtimeDefinition.definition.roleBooklets.length} />
        <RuntimeCount
          label="dmFlow actFlows"
          value={runtimeDefinition.definition.dmFlow?.actFlows.length ?? 0}
        />
        <RuntimeCount label="playerDisplay" value={runtimeDefinition.definition.playerDisplay.length} />
        <RuntimeCount label="clues" value={runtimeDefinition.definition.clues.length} />
      </div>
      <p className="rounded-md bg-paper p-3 text-xs leading-5 text-ink/70">
        endingMode: {runtimeDefinition.definition.endingMode}
      </p>
      <ValidationProvenance stored={runtimeDefinition.storedValidationReport} current={report} />

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-pine/20 bg-pine/5 p-3">
        <p className="text-xs leading-5 text-ink/70">
          明确使用当前 RuntimeDefinition 创建一局完整新游戏；已有游戏和旧版本不会变更。
        </p>
        <button
          className="rounded-md bg-pine px-3 py-2 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:bg-ink/25"
          disabled={busy}
          onClick={onStartFullGame}
        >
          用 v{runtimeDefinition.version} 开始完整新游戏
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-brass/30 bg-brass/10 p-3">
        <p className="text-xs leading-5 text-ink/70">
          用当前 RuntimeDefinition 启动第一幕测试局。只校验本次可用角色和第一幕，不要求所有角色、所有幕都已完成。
        </p>
        <button
          className="rounded-md bg-pine px-3 py-2 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:bg-ink/25"
          disabled={busy}
          onClick={onStartTestGame}
        >
          从该 RuntimeDefinition 开始测试游戏
        </button>
      </div>

      <RuntimeIssueList title="errors" issues={report.errors} />
      {runtimeDefinition.definition.acts.map(act => act.control
        ? <ManualControlDetails key={act.actIndex} control={act.control} />
        : <p key={act.actIndex} className="text-xs">第 {act.actIndex} 幕 · legacy control（未推断新 policy）</p>)}
      <RuntimeIssueList title="warnings" issues={report.warnings} />

      <details className="rounded-md bg-paper p-3">
        <summary className="cursor-pointer text-xs font-semibold text-pine">
          查看完整 definitionJson
        </summary>
        <CodeBlock value={JSON.stringify(runtimeDefinition.definition, null, 2)} />
      </details>
    </div>
  );
}

function RecoverableGameSessionsPanel({
  sessions,
  busy,
  onContinue,
  onRefresh
}: {
  sessions: RecoverableGameSessionSummary[];
  busy: boolean;
  onContinue: (gameId: string) => void;
  onRefresh: () => void;
}) {
  return (
    <section className="rounded-lg border border-ink/10 bg-white/90 p-5 shadow-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">继续最近测试游戏</h2>
          <p className="mt-2 text-sm leading-6 text-ink/60">
            开发环境重启后，只要数据库和本地文件没有删除，可以从这里回到未结束的 GameSession。
          </p>
        </div>
        <button
          className="rounded-md border border-ink/15 px-3 py-2 text-sm font-semibold text-ink transition hover:bg-paper disabled:text-ink/30"
          disabled={busy}
          onClick={onRefresh}
        >
          刷新列表
        </button>
      </div>

      {sessions.length === 0 ? (
        <p className="mt-4 rounded-md bg-paper p-3 text-sm leading-6 text-ink/55">
          当前剧本包没有未结束的测试游戏。
        </p>
      ) : (
        <div className="mt-4 grid gap-3">
          {sessions.map((session) => (
            <article
              key={session.gameId}
              className="grid gap-3 rounded-md border border-ink/10 bg-paper/70 p-3 md:grid-cols-[minmax(0,1fr)_auto]"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">
                  {session.gameId}
                </p>
                <p className="mt-1 text-xs leading-5 text-ink/60">
                  {formatGamePhase(session.currentPhase)} ·{" "}
                  {session.currentActIndex ? `第 ${session.currentActIndex} 幕` : session.currentActId} ·{" "}
                  {session.testMode ? "testMode" : "demo"}
                </p>
                <p className="mt-1 text-xs leading-5 text-ink/60">
                  用户角色：{session.userRoleName ?? "未选"} · 参与角色：{" "}
                  {session.activeRoleNames.length ? session.activeRoleNames.join("、") : "-"}
                </p>
                <p className="mt-1 text-xs leading-5 text-ink/55">
                  更新：{formatDate(session.updatedAt)} · cursor{" "}
                  {session.dmFlowCursor.nodeId ?? "-"} · waitingFor{" "}
                  {session.dmFlowCursor.waitingFor ?? "-"} · triggered{" "}
                  {session.dmFlowCursor.triggeredRuleCount}
                </p>
              </div>
              <button
                className="self-center rounded-md bg-pine px-3 py-2 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:bg-ink/25"
                disabled={busy}
                onClick={() => onContinue(session.gameId)}
              >
                继续
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function RuntimeCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-paper p-3">
      <p className="text-xs font-semibold text-ink/50">{label}</p>
      <p className="mt-1 text-lg font-semibold text-ink">{value}</p>
    </div>
  );
}

function RuntimeIssueList({
  title,
  issues
}: {
  title: string;
  issues: RuntimeValidationIssueView[];
}) {
  return (
    <section>
      <p className="text-xs font-semibold text-ink">{title}</p>
      {issues.length === 0 ? (
        <p className="mt-1 rounded-sm bg-paper p-2 text-xs text-ink/45">[]</p>
      ) : (
        <div className="mt-1 space-y-2">
          {issues.map((issue, index) => (
            <article
              key={`${title}_${issue.code}_${index}`}
              className="rounded-md border border-ink/10 bg-paper p-3 text-xs leading-5 text-ink/70"
            >
              <p className="font-semibold text-ink">
                {issue.code}
                {issue.path ? ` · ${issue.path}` : ""}
              </p>
              <p className="mt-1">{issue.message}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function DMFlowDetail({ dmFlow }: { dmFlow: DMFlowView }) {
  return (
    <details className="rounded-md bg-white/75 p-3" open>
      <summary className="cursor-pointer text-xs font-semibold text-pine">
        查看 DMFlow 结构化结果 · {formatDMFlowParseStatus(dmFlow.parseStatus)}
      </summary>
      <div className="mt-3 space-y-4 text-xs leading-5 text-ink/70">
        <p>格式：{dmFlow.format ?? "legacy_nodes"}</p>
        {dmFlow.artifactAudit?.map(a => <SourceEvidenceDetails key={a.id} source={a.source} status={a.status} />)}
        {dmFlow.semanticActs?.map((act, i) => <details key={`${act.logicalActId}:${i}`}>
          <summary>Semantic 第 {act.actIndex} 幕 · {act.conversationPolicy.mode} · {act.conversationPolicy.source}</summary>
          <CodeBlock value={JSON.stringify(act, null, 2)} />
        </details>)}
        {dmFlow.parseError ? (
          <p className="rounded-sm bg-ember/10 p-2 text-ember">{dmFlow.parseError}</p>
        ) : null}
        <DMFlowNodeGroup title="openingNodes" nodes={dmFlow.openingNodes} />
        {dmFlow.actFlows.map((actFlow) => (
          <section key={actFlow.sourceSectionId}>
            <p className="font-semibold text-ink">
              actFlows · 第 {actFlow.actIndex} 幕{actFlow.title ? ` · ${actFlow.title}` : ""}
            </p>
            <ArrayBlock title="warnings" items={actFlow.warnings} />
            <DMFlowNodeList nodes={actFlow.nodes} />
          </section>
        ))}
        <DMFlowNodeGroup title="endingNodes" nodes={dmFlow.endingNodes} />
        <ArrayBlock title="warnings" items={dmFlow.warnings} />
      </div>
    </details>
  );
}

function DMFlowNodeGroup({ title, nodes }: { title: string; nodes: DMFlowNodeView[] }) {
  return (
    <section>
      <p className="font-semibold text-ink">{title}</p>
      <DMFlowNodeList nodes={nodes} />
    </section>
  );
}

function DMFlowNodeList({ nodes }: { nodes: DMFlowNodeView[] }) {
  if (nodes.length === 0) {
    return <p className="mt-1 rounded-sm bg-paper p-2 text-ink/45">[]</p>;
  }

  return (
    <div className="mt-2 space-y-2">
      {nodes.map((node) => (
        <article key={node.nodeId} className="min-w-0 rounded-md border border-ink/10 bg-paper p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-ink">
              {node.type}
              {node.title ? ` · ${node.title}` : ""}
            </p>
            <p className="text-ink/45">confidence: {node.confidence.toFixed(2)}</p>
          </div>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <NodeTextField title="text" text={node.text} />
            <NodeTextField title="fixedLine" text={node.fixedLine} />
            <NodeTextField title="promptGoal" text={node.promptGoal} />
            <NodeTextField title="sourceQuote" text={node.sourceQuote} />
          </div>
          <ArrayBlock title="requiredPublicPoints" items={node.requiredPublicPoints} />
          <ArrayBlock title="ifMissingPoints" items={node.ifMissingPoints} />
          <ArrayBlock title="forbiddenReveals" items={node.forbiddenReveals} />
          {node.clueRefs.length > 0 ? (
            <pre className="mt-2 max-h-[180px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-sm bg-white p-2">
              {JSON.stringify(node.clueRefs, null, 2)}
            </pre>
          ) : null}
          {node.performance ? (
            <pre className="mt-2 max-h-[180px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-sm bg-white p-2">
              {JSON.stringify(node.performance, null, 2)}
            </pre>
          ) : null}
          <ArrayBlock title="warnings" items={node.warnings} />
        </article>
      ))}
    </div>
  );
}

function NodeTextField({ title, text }: { title: string; text?: string | null }) {
  if (!text) {
    return null;
  }

  return (
    <section>
      <p className="font-semibold text-ink">{title}</p>
      <p className="mt-1 max-h-[120px] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-white p-2">
        {text}
      </p>
    </section>
  );
}

function RoleActBookletDetail({ booklet }: { booklet: RoleActBookletView }) {
  return (
    <details className="mt-3 rounded-md bg-white/75 p-3">
      <summary className="cursor-pointer text-xs font-semibold text-pine">
        查看结构化结果
      </summary>
      <div className="mt-3 space-y-3 text-xs leading-5 text-ink/70">
        <FieldBlock title="privateText" text={booklet.privateText || "无"} />
        <ArrayBlock title="mustShare" items={booklet.mustShare} />
        <ArrayBlock title="mayShare" items={booklet.mayShare} />
        <ArrayBlock title="mustNotShare" items={booklet.mustNotShare} />
        <ArrayBlock title="emotionalPoints" items={booklet.emotionalPoints} />
        <ArrayBlock title="relationshipPoints" items={booklet.relationshipPoints} />
        <ArrayBlock title="timelineFragments" items={booklet.timelineFragments} />
        <ArrayBlock title="warnings" items={booklet.warnings} />
        <p className="text-ink/45">sourceSectionId: {booklet.sourceSectionId}</p>
      </div>
    </details>
  );
}

function FieldBlock({ title, text }: { title: string; text: string }) {
  return (
    <section className="min-w-0">
      <p className="font-semibold text-ink">{title}</p>
      <p className="mt-1 max-h-[180px] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-paper p-2">
        {text}
      </p>
    </section>
  );
}

function ArrayBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <p className="font-semibold text-ink">{title}</p>
      {items.length === 0 ? (
        <p className="mt-1 rounded-sm bg-paper p-2 text-ink/45">[]</p>
      ) : (
        <ul className="mt-1 min-w-0 space-y-1 rounded-sm bg-paper p-2">
          {items.map((item, index) => (
            <li key={`${title}_${index}`} className="break-words">
              {item}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ParsedDocumentList({
  parsedDocuments,
  assets,
  busy,
  onSegmentDocument
}: {
  parsedDocuments: ParsedDocumentView[];
  assets: AssetView[];
  busy: boolean;
  onSegmentDocument: (parsedDocument: ParsedDocumentView) => void;
}) {
  if (parsedDocuments.length === 0) {
    return (
      <p className="mt-4 text-sm leading-6 text-ink/55">
        还没有 ParsedDocument。上传可复制文本 PDF 后点击“解析文本”。
      </p>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      {parsedDocuments.map((document) => {
        const asset = assets.find((candidate) => candidate.id === document.uploadedAssetId);

        return (
          <article key={document.id} className="rounded-md border border-ink/10 bg-paper/70 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-ink">
                  {asset?.originalName ?? document.uploadedAssetId}
                </p>
                <p className="mt-1 text-xs text-ink/55">
                  文本：{document.parseStatus} · 切分：{document.segmentationStatus} ·{" "}
                  {document.extractorName ?? document.sourceType} · {document.qualityStatus} ·{" "}
                  {document.pageCount || "-"} 页 · {document.charCount} 字
                  {" · "}文档 r{document.documentRevision} · 章节集 r{document.sectionSetRevision} · {document.isActive ? "active" : "stale"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {document.parseStatus === "COMPLETED" &&
                document.qualityStatus !== "FAILED" &&
                asset?.kind !== "ROLE_BOOKLET" ? (
                  <button
                    className="rounded-md border border-ink/15 px-3 py-2 text-xs font-semibold text-ink transition hover:bg-white disabled:text-ink/30"
                    disabled={busy}
                    onClick={() => onSegmentDocument(document)}
                  >
                    切分章节
                  </button>
                ) : null}
                <p className="text-xs text-ink/45">{formatDate(document.updatedAt)}</p>
              </div>
            </div>
            {document.errorMessage ? (
              <p className="mt-3 rounded-sm bg-ember/10 p-2 text-xs leading-5 text-ember">
                {document.errorMessage}
              </p>
            ) : null}
            {document.segmentationError ? (
              <p className="mt-3 rounded-sm bg-brass/10 p-2 text-xs leading-5 text-brass">
                {document.segmentationError}
              </p>
            ) : null}
            {document.qualityWarnings.length > 0 ? (
              <div className="mt-3 rounded-sm bg-brass/10 p-2 text-xs leading-5 text-brass">
                {document.qualityWarnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            ) : null}
            <div className="mt-3 grid gap-3">
              {document.pages.slice(0, 6).map((page) => (
                <section key={page.pageNumber} className="rounded-sm bg-white/70 p-3">
                  <p className="text-xs font-semibold text-ink">第 {page.pageNumber} 页</p>
                  <p className="mt-2 line-clamp-4 whitespace-pre-line text-xs leading-5 text-ink/65">
                    {page.text || "本页未抽取到文本。"}
                  </p>
                </section>
              ))}
            </div>
            {document.rawText ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-semibold text-pine">
                  查看 rawText 预览
                </summary>
                <pre className="mt-2 max-h-[260px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-white p-3 text-xs leading-5 text-ink/75">
                  {document.rawText.slice(0, 8000)}
                </pre>
              </details>
            ) : null}
            {document.normalizedText || document.extractedText ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-semibold text-pine">
                  查看 normalizedText
                </summary>
                <pre className="mt-2 max-h-[420px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-white p-3 text-xs leading-5 text-ink/75">
                  {document.normalizedText || document.extractedText}
                </pre>
              </details>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function ManualSegmentationPanel({
  parsedDocuments,
  assets,
  busy,
  onSubmit
}: {
  parsedDocuments: ParsedDocumentView[];
  assets: AssetView[];
  busy: boolean;
  onSubmit: (parsedDocument: ParsedDocumentView, input: ManualRoleActsValue) => void;
}) {
  const candidates = parsedDocuments.filter((document) => {
    const asset = assets.find((item) => item.id === document.uploadedAssetId);

    return asset?.kind === "ROLE_BOOKLET" && document.segmentationStatus === "NEEDS_MANUAL_SEGMENTATION";
  });

  if (candidates.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 space-y-3">
      {candidates.map((document) => {
        const asset = assets.find((item) => item.id === document.uploadedAssetId);

        return (
          <ManualRoleActsForm
            key={document.id}
            parsedDocument={document}
            asset={asset}
            busy={busy}
            onSubmit={onSubmit}
          />
        );
      })}
    </div>
  );
}

function ManualRoleActsForm({
  parsedDocument,
  asset,
  busy,
  onSubmit
}: {
  parsedDocument: ParsedDocumentView;
  asset?: AssetView;
  busy: boolean;
  onSubmit: (parsedDocument: ParsedDocumentView, input: ManualRoleActsValue) => void;
}) {
  const [roleName, setRoleName] = useState(asset?.roleName ?? fallbackRoleName(asset?.originalName ?? ""));
  const [rows, setRows] = useState([
    { actIndex: 1, pageStart: 1, title: "第一幕" },
    { actIndex: 2, pageStart: 2, title: "第二幕" },
    { actIndex: 3, pageStart: 3, title: "第三幕" }
  ]);

  function updateRow(index: number, field: "actIndex" | "pageStart" | "title", value: string) {
    setRows((current) =>
      current.map((row, rowIndex) => {
        if (rowIndex !== index) {
          return row;
        }

        return {
          ...row,
          [field]: field === "title" ? value : Number(value)
        };
      })
    );
  }

  function addRow() {
    setRows((current) => [
      ...current,
      {
        actIndex: current.length + 1,
        pageStart: Math.min(parsedDocument.pageCount, current.length + 1),
        title: `第 ${current.length + 1} 幕`
      }
    ]);
  }

  return (
    <div className="rounded-md border border-brass/25 bg-brass/5 p-3">
      <p className="text-sm font-semibold text-ink">
        {asset?.originalName ?? parsedDocument.id}
      </p>
      <p className="mt-1 text-xs leading-5 text-brass">
        {parsedDocument.segmentationError}
      </p>
      <p className="mt-1 text-xs text-ink/55">共 {parsedDocument.pageCount} 页</p>
      <input
        className="mt-3 h-9 w-full rounded-md border border-ink/15 bg-white px-3 text-xs text-ink"
        value={roleName}
        placeholder="角色名"
        onChange={(event) => setRoleName(event.target.value)}
      />
      <div className="mt-3 space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="grid grid-cols-[64px_72px_1fr] gap-2">
            <input
              className="h-9 rounded-md border border-ink/15 bg-white px-2 text-xs text-ink"
              min={1}
              type="number"
              value={row.actIndex}
              onChange={(event) => updateRow(index, "actIndex", event.target.value)}
            />
            <input
              className="h-9 rounded-md border border-ink/15 bg-white px-2 text-xs text-ink"
              min={1}
              max={parsedDocument.pageCount}
              type="number"
              value={row.pageStart}
              onChange={(event) => updateRow(index, "pageStart", event.target.value)}
            />
            <input
              className="h-9 rounded-md border border-ink/15 bg-white px-2 text-xs text-ink"
              value={row.title}
              onChange={(event) => updateRow(index, "title", event.target.value)}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="rounded-md border border-ink/15 px-3 py-2 text-xs font-semibold text-ink transition hover:bg-white"
          disabled={busy}
          onClick={addRow}
        >
          添加一幕
        </button>
        <button
          className="rounded-md bg-pine px-3 py-2 text-xs font-semibold text-white transition hover:bg-pine/90 disabled:bg-ink/25"
          disabled={busy}
          onClick={() =>
            onSubmit(parsedDocument, {
              roleName,
              actStartPages: rows
            })
          }
        >
          按页码切分
        </button>
      </div>
    </div>
  );
}

function DocumentSectionList({ sections }: { sections: DocumentSectionView[] }) {
  if (sections.length === 0) {
    return <p className="mt-4 text-sm leading-6 text-ink/55">还没有 DocumentSection。</p>;
  }

  return (
    <div className="mt-4 space-y-3">
      {sections.map((section) => {
        const isAiPending =
          section.sectionPurpose === "AI_TEXT_SOURCE" && !section.text.trim();

        return (
          <article key={section.id} className="rounded-md border border-ink/10 bg-paper/70 p-3">
            <p className="text-sm font-semibold text-ink">
              {section.uploadedAsset.originalName}
            </p>
            <p className="mt-1 text-xs leading-5 text-ink/55">
              {section.uploadedAsset.kind} · {section.roleName ?? section.uploadedAsset.roleName ?? "-"} ·{" "}
              {formatSectionPurpose(section.sectionPurpose)} · {section.sectionType} · {section.title}
            </p>
            <p className="mt-1 text-xs text-ink/55">章节集 r{section.sectionSetRevision} · {section.isActive ? "active" : "stale"}</p>
            {isAiPending ? (
              <p className="mt-2 rounded-sm bg-brass/10 p-2 text-xs leading-5 text-brass">
                第 {section.actIndex ?? "-"} 幕的 AI 文本源来自 DOCX，目前尚未生成正文。请在角色剧本分幕区域使用统一结束语切分 DOCX。
              </p>
            ) : (
              <>
                <p className="mt-1 text-xs text-ink/55">
                  幕号：{section.actIndex ?? "-"} · PDF 页码：{section.pageStart ?? "-"}-
                  {section.pageEnd ?? "-"}
                </p>
                <p className="mt-2 line-clamp-5 whitespace-pre-line text-xs leading-5 text-ink/65">
                  {section.text || "无文本。"}
                </p>
              </>
            )}
          </article>
        );
      })}
    </div>
  );
}

function JobList({ jobs }: { jobs: IngestionJobView[] }) {
  if (jobs.length === 0) {
    return <p className="mt-4 text-sm text-ink/55">还没有解析任务。</p>;
  }

  return (
    <div className="mt-4 space-y-3">
      {jobs.map((job) => (
        <article key={job.id} className="rounded-md border border-ink/10 bg-paper/70 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-ink">{job.status}</p>
            <p className="text-xs text-ink/50">{formatDate(job.createdAt)}</p>
          </div>
          <p className="mt-1 text-sm text-ink/60">当前步骤：{job.currentStep ?? "未开始"}</p>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {job.steps.map((step) => (
              <div key={step.id} className="rounded-sm bg-white/70 p-2">
                <p className="text-xs font-semibold text-ink">{step.stepName}</p>
                <p className="mt-1 text-xs text-ink/55">{step.status}</p>
              </div>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

function ValidationBadge({ status }: { status: ScriptPackageSummary["validation"]["status"] }) {
  const styles = {
    valid: "bg-pine/12 text-pine",
    warning: "bg-brass/12 text-brass",
    invalid: "bg-ember/12 text-ember"
  };

  return (
    <span className={`rounded-sm px-2 py-1 text-xs font-semibold ${styles[status]}`}>
      {status}
    </span>
  );
}

function stripScript(detail: ScriptPackageDetail): SafeDetail {
  const { script: _script, ...safeDetail } = detail;

  return safeDetail;
}

function formatDate(value: string | Date): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatGamePhase(phase: string): string {
  const labels: Record<string, string> = {
    role_selection: "选角",
    reading: "读本",
    ai_internal_reading: "AI 读本",
    share_round: "分享",
    free_discussion: "自由讨论",
    dm_question: "DM 提问",
    act_summary: "幕间总结",
    finished: "已结束"
  };

  return labels[phase] ?? phase;
}

function formatBytes(value: number | null): string {
  if (!value) {
    return "-";
  }

  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function isSupportedTextAsset(asset: AssetView): boolean {
  const fileName = asset.originalName.toLowerCase();

  return (
    asset.mimeType === "application/pdf" ||
    asset.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    fileName.endsWith(".pdf") ||
    fileName.endsWith(".docx")
  );
}

function buildRoleBookletGroups(
  assets: AssetView[],
  parsedDocuments: ParsedDocumentView[],
  sections: DocumentSectionView[]
): RoleBookletGroup[] {
  const roleAssets = assets.filter((asset) => asset.kind === "ROLE_BOOKLET");
  const bookKey = (asset: AssetView) => { try { return JSON.parse(asset.metadataJson ?? "{}").reading?.bookKey ?? "legacy"; } catch { return "legacy"; } };
  const groups = new Map<string, { roleName: string; bookKey: string }>();
  for (const asset of roleAssets) {
    const roleName = asset.roleName ?? fallbackRoleName(asset.originalName);
    groups.set(`${roleName}:${bookKey(asset)}`, { roleName, bookKey: bookKey(asset) });
  }
  return [...groups.values()].map(({ roleName, bookKey: key }) => {
    const candidates = roleAssets.filter(asset => (asset.roleName ?? fallbackRoleName(asset.originalName)) === roleName && bookKey(asset) === key);
    const displayAsset =
      candidates.find((asset) => isPdfAsset(asset) && asset.assetPurpose === "PLAYER_DISPLAY") ??
      candidates.find((asset) => isPdfAsset(asset) && asset.assetPurpose === "BOTH") ??
      null;
    const textAsset =
      candidates.find((asset) => isDocxAsset(asset) && asset.assetPurpose === "AI_TEXT_SOURCE") ??
      candidates.find((asset) => isDocxAsset(asset) && asset.assetPurpose === "BOTH") ??
      null;
    const displayDocument = displayAsset ? latestParsedDocument(parsedDocuments, displayAsset.id) : null;
    const textDocument = textAsset ? latestParsedDocument(parsedDocuments, textAsset.id) : null;
    const roleSections = sections.filter((section) => section.roleName === roleName && candidates.some(a => a.id === section.uploadedAssetId));

    return {
      roleName, bookKey: key,
      displayAsset,
      textAsset,
      displayDocument,
      textDocument,
      displaySections: roleSections
        .filter(
          (section) =>
            section.sectionType === "role_act" && section.sectionPurpose === "PLAYER_DISPLAY"
        )
        .sort((left, right) => (left.actIndex ?? 0) - (right.actIndex ?? 0)),
      aiSections: roleSections
        .filter(
          (section) =>
            section.sectionType === "role_act" && section.sectionPurpose === "AI_TEXT_SOURCE"
        )
        .sort((left, right) => (left.actIndex ?? 0) - (right.actIndex ?? 0))
    };
  });
}

function latestParsedDocument(
  parsedDocuments: ParsedDocumentView[],
  uploadedAssetId: string
): ParsedDocumentView | null {
  return (
    parsedDocuments
      .filter((document) => document.uploadedAssetId === uploadedAssetId)
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      )[0] ?? null
  );
}

function getAiTextStatus(group: RoleBookletGroup): string {
  if (group.textAsset) {
    return group.aiSections.some((section) => section.text.trim())
      ? "DOCX 已切分"
      : "使用 DOCX，待结束语切分";
  }

  if (group.displayDocument?.qualityStatus === "FAILED") {
    return "需要上传 DOCX";
  }

  if (group.displayAsset) {
    return "使用 PDF fallback";
  }

  return "未设置";
}

function isPdfAsset(asset: AssetView): boolean {
  return asset.mimeType === "application/pdf" || asset.originalName.toLowerCase().endsWith(".pdf");
}

function isDocxAsset(asset: AssetView): boolean {
  return (
    asset.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    asset.originalName.toLowerCase().endsWith(".docx")
  );
}

function formatAssetPurpose(value: string): string {
  const labels: Record<string, string> = {
    PLAYER_DISPLAY: "玩家阅读展示",
    AI_TEXT_SOURCE: "AI 文本解析",
    BOTH: "展示和文本兼用"
  };

  return labels[value] ?? value;
}

function formatSectionPurpose(value: string): string {
  const labels: Record<string, string> = {
    PLAYER_DISPLAY: "玩家展示",
    AI_TEXT_SOURCE: "AI 文本源",
    CONTENT: "内容"
  };

  return labels[value] ?? value;
}

function formatBookletParseStatus(value: string): string {
  const labels: Record<string, string> = {
    PENDING: "未解析",
    SUCCESS: "解析成功",
    FAILED: "解析失败",
    未解析: "未解析"
  };

  return labels[value] ?? value;
}

function formatDMSectionTitle(section: DocumentSectionView): string {
  if (section.sectionType === "dm_opening") {
    return "opening";
  }

  if (section.sectionType === "dm_ending") {
    return "ending";
  }

  return `act ${section.actIndex ?? "-"}`;
}

function formatDMSectionParseStatus(value?: string): string {
  const labels: Record<string, string> = {
    success: "解析成功",
    failed: "解析失败"
  };

  return value ? labels[value] ?? value : "未解析";
}

function formatDMFlowParseStatus(value: string): string {
  const labels: Record<string, string> = {
    PENDING: "未解析",
    SUCCESS: "解析成功",
    PARTIAL_SUCCESS: "部分成功",
    FAILED: "解析失败"
  };

  return labels[value] ?? value;
}

function formatRuntimeDefinitionStatus(value: string): string {
  const labels: Record<string, string> = {
    valid: "valid",
    warning: "warning",
    invalid: "invalid",
    draft: "未生成"
  };

  return labels[value] ?? value;
}

function formatActivePanelTitle(value: ActivePanel): string {
  const labels: Record<ActivePanel, string> = {
    upload: "上传资料",
    roleSplit: "角色剧本分幕",
    roleParse: "角色结构化解析",
    dmFlow: "DM 手册结构化解析",
    runtime: "生成可运行剧本",
    documents: "Parsed Documents",
    jobs: "Ingestion Jobs",
    scriptJson: "scriptJson",
    sections: "Document Sections"
  };

  return labels[value];
}

function dmSectionOrder(sectionType: string): number {
  if (sectionType === "dm_opening") {
    return 0;
  }

  if (sectionType === "dm_act") {
    return 1;
  }

  return 2;
}

function fallbackRoleName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");
  const cleaned = withoutExtension
    .replace(/角色本|剧本|人物本|玩家手册|player|booklet/gi, "")
    .replace(/[_\-—]+/g, " ")
    .trim();

  return cleaned || withoutExtension || "";
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();

  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: `服务器返回了无法解析的响应，状态码 ${response.status}。` };
  }
}

function getErrorMessage(payload: Record<string, unknown>, fallback: string): string {
  return typeof payload.error === "string" ? payload.error : fallback;
}

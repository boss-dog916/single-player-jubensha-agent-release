import { cookies } from "next/headers";
import { developerFromCookies } from "@/src/lib/access/localCredentials";
import { LocalAccessPanel } from "@/components/LocalAccessPanel";
import Link from "next/link";
import { ScriptPackageDetailClient } from "@/components/scripts/ScriptPackageDetailClient";
import {
  getScriptPackageDetail,
  listIngestionJobs,
  listUploadedAssets
} from "@/src/lib/services/scriptPackageService";
import { listParsedDocuments } from "@/src/lib/ingestion/parsedDocumentService";
import { listDocumentSections } from "@/src/lib/ingestion/documentSectionService";
import { getDMFlow } from "@/src/lib/services/dmFlowService";
import { listRoleActBooklets } from "@/src/lib/services/roleActBookletService";
import { getLatestScriptRuntimeDefinition } from "@/src/lib/services/scriptRuntimeDefinitionService";
import { listRecoverableGameSessions } from "@/src/lib/services/gameSessionRecoveryService";

type PageProps = {
  params: Promise<{
    scriptPackageId: string;
  }>;
};

export default async function ScriptPackageDetailPage({ params }: PageProps) {
  if (!developerFromCookies((await cookies()).toString())) return <LocalAccessPanel />;
  const { scriptPackageId } = await params;
  const [
    detail,
    assets,
    ingestionJobs,
    parsedDocuments,
    documentSections,
    roleActBooklets,
    dmFlow,
    runtimeDefinition,
    recoverableGameSessions
  ] = await Promise.all([
    getScriptPackageDetail(scriptPackageId),
    listUploadedAssets(scriptPackageId),
    listIngestionJobs(scriptPackageId),
    listParsedDocuments(scriptPackageId),
    listDocumentSections({ scriptPackageId }),
    listRoleActBooklets(scriptPackageId),
    getDMFlow(scriptPackageId),
    getLatestScriptRuntimeDefinition(scriptPackageId),
    listRecoverableGameSessions(scriptPackageId)
  ]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1440px] flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-ink/10 pb-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">
            Script Package
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-ink">{detail.title}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-ink/64">
            {detail.description ?? "暂无简介。"}
          </p>
        </div>
        <Link
          href="/scripts"
          className="rounded-md border border-ink/15 px-4 py-2 text-sm font-semibold text-ink transition hover:bg-paper"
        >
          返回剧本库
        </Link>
      </header>

      <ScriptPackageDetailClient
        initialDetail={stripScript(detail)}
        initialAssets={assets}
        initialIngestionJobs={ingestionJobs}
        initialParsedDocuments={parsedDocuments}
        initialDocumentSections={documentSections}
        initialRoleActBooklets={roleActBooklets}
        initialDMFlow={dmFlow}
        initialRuntimeDefinition={runtimeDefinition}
        initialRecoverableGameSessions={recoverableGameSessions}
      />
    </main>
  );
}

function stripScript(detail: Awaited<ReturnType<typeof getScriptPackageDetail>>) {
  const { script: _script, ...safeDetail } = detail;

  return safeDetail;
}

"use client";
import { StoryBoardOption } from "../StoryBoardOption";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ScriptPackageSummary } from "@/src/lib/services/scriptPackageService";
import type { GameRuntimeSnapshot } from "@/src/lib/services/gameRuntimeSnapshotService";

type Props = {
  initialScriptPackages: ScriptPackageSummary[];
};

export function ScriptsLibraryClient({ initialScriptPackages }: Props) {
  const router = useRouter();
  const [scriptPackages, setScriptPackages] = useState(initialScriptPackages);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [boardEnabled, setBoardEnabled] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function refreshList() {
    const response = await fetch("/api/script-packages");
    const payload = await readJsonResponse(response);

    if (!response.ok || !Array.isArray(payload.scriptPackages)) {
      throw new Error(getErrorMessage(payload, "刷新剧本库失败。"));
    }

    setScriptPackages(payload.scriptPackages as ScriptPackageSummary[]);
  }

  async function createPackage() {
    if (!title.trim()) {
      setErrorText("请先填写剧本名称。");
      return;
    }

    setCreating(true);
    setErrorText(null);

    try {
      const response = await fetch("/api/script-packages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          status: "DRAFT"
        })
      });
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "创建剧本包失败。"));
      }

      setTitle("");
      setDescription("");
      await refreshList();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "创建剧本包失败。");
    } finally {
      setCreating(false);
    }
  }

  async function startGame(scriptPackage: ScriptPackageSummary) {
    if (scriptPackage.isDefaultDemo && scriptPackage.validation.status === "invalid") {
      setErrorText("该剧本包校验未通过，不能开始游戏。请进入详情修复结构化剧本数据。");
      return;
    }

    if (
      scriptPackage.isDefaultDemo && scriptPackage.validation.status === "warning" &&
      !window.confirm("该剧本包存在 warning，仍要开始游戏吗？")
    ) {
      return;
    }

    setBusyId(scriptPackage.id);
    setErrorText(null);

    try {
      const response = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptPackageId: scriptPackage.id, publicStoryBoardEnabled: boardEnabled })
      });
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "创建游戏失败。"));
      }

      router.push(`/games/${(payload as GameRuntimeSnapshot).session.gameId}`);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "创建游戏失败。");
      setBusyId(null);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
      <div className="lg:col-span-2"><StoryBoardOption enabled={boardEnabled} onChange={setBoardEnabled} disabled={Boolean(busyId)} /></div>
      {!scriptPackages.some(scriptPackage => scriptPackage.slug?.startsWith("preset-")) ? <p role="status" className="rounded-lg border border-brass/30 bg-brass/10 p-4 text-sm text-ink/80 lg:col-span-2">尚未安装预置剧本。请在本机终端运行 npm run preset:install -- “合法资源包.zip或目录”，安装后刷新。上传与解析为实验性功能，不保证任意剧本完整可玩。</p> : null}
      <section className="rounded-lg border border-ink/10 bg-white/90 p-5 shadow-panel">
        <h2 className="text-sm font-semibold text-ink">上传自定义剧本（实验性）</h2>
        <div className="mt-4 space-y-3">
          <label className="block text-xs font-semibold text-ink/60">
            名称
            <input
              className="mt-2 h-10 w-full rounded-md border border-ink/15 bg-paper px-3 text-sm font-normal text-ink outline-none focus:border-pine"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：长夜"
            />
          </label>
          <label className="block text-xs font-semibold text-ink/60">
            简介
            <textarea
              className="mt-2 min-h-24 w-full resize-none rounded-md border border-ink/15 bg-paper p-3 text-sm font-normal leading-6 text-ink outline-none focus:border-pine"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="阶段 1 会先用结构模板创建，后续可上传资料并接入解析 Pipeline。"
            />
          </label>
          <button
            className="h-10 w-full rounded-md bg-pine px-4 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:cursor-not-allowed disabled:bg-ink/25"
            disabled={creating}
            onClick={createPackage}
          >
            {creating ? "创建中..." : "创建 ScriptPackage"}
          </button>
          {errorText ? <p className="text-sm leading-6 text-ember">{errorText}</p> : null}
        </div>
      </section>

      <section className="min-w-0">
        <div className="grid gap-4">
          {scriptPackages.map((scriptPackage) => (
            <article
              key={scriptPackage.id}
              className="rounded-lg border border-ink/10 bg-white/90 p-5 shadow-panel"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xl font-semibold text-ink">{scriptPackage.title}</h2>
                    {scriptPackage.isDefaultDemo ? <Badge label="默认 demo" tone="brass" /> : null}
                    <ValidationBadge status={scriptPackage.validation.status} />
                  </div>
                  <p className="mt-2 max-w-3xl text-sm leading-7 text-ink/64">
                    {scriptPackage.description ?? "暂无简介。"}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Link
                    href={`/scripts/${scriptPackage.id}`}
                    className="rounded-md border border-ink/15 px-3 py-2 text-sm font-semibold text-ink transition hover:bg-paper"
                  >
                    管理
                  </Link>
                  <button
                    className="rounded-md bg-pine px-3 py-2 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:cursor-not-allowed disabled:bg-ink/25"
                    disabled={busyId === scriptPackage.id}
                    onClick={() => void startGame(scriptPackage)}
                  >
                    {busyId === scriptPackage.id ? "开局中..." : "开始游戏"}
                  </button>
                </div>
              </div>

              <dl className="mt-4 grid gap-3 text-sm text-ink/68 md:grid-cols-4">
                <InfoItem label="创建时间" value={formatDate(scriptPackage.createdAt)} />
                <InfoItem label="上传资料" value={`${scriptPackage.assetCount} 个`} />
                <InfoItem
                  label="最近解析任务"
                  value={scriptPackage.latestIngestionJobStatus ?? "暂无"}
                />
                <InfoItem
                  label="校验问题"
                  value={`${scriptPackage.validation.issues.length} 项`}
                />
              </dl>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-paper/70 p-3">
      <dt className="text-xs font-semibold text-ink/45">{label}</dt>
      <dd className="mt-1 truncate font-medium text-ink">{value}</dd>
    </div>
  );
}

function Badge({ label, tone }: { label: string; tone: "brass" }) {
  return (
    <span className="rounded-sm bg-brass/12 px-2 py-1 text-xs font-semibold text-brass">
      {label}
    </span>
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

function formatDate(value: string | Date): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
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

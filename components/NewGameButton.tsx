"use client";

import { StoryBoardOption } from "./StoryBoardOption";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PlayerGameSnapshot } from "@/src/lib/access/playerView";

export function NewGameButton() {
  const router = useRouter();
  const [boardEnabled, setBoardEnabled] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  async function handleCreateGame() {
    setCreating(true);
    const response = await fetch("/api/games", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publicStoryBoardEnabled: boardEnabled })
    });
    const payload = await readJsonResponse(response);

    if (!response.ok) {
      setCreating(false);
      setError(getErrorMessage(payload, "创建未完成，请先在开发者入口解锁。")); return;
    }

    const snapshot = payload as PlayerGameSnapshot;
    router.push(`/games/${snapshot.session.gameId}`);
  }

  return (
    <div><StoryBoardOption enabled={boardEnabled} onChange={setBoardEnabled} disabled={creating} /><a className="mr-3 text-sm underline" href="/developer">开发者入口</a><button
      className="h-11 rounded-md bg-pine px-5 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:cursor-not-allowed disabled:bg-ink/25"
      disabled={creating}
      onClick={handleCreateGame}
    >
      {creating ? "正在创建..." : "新游戏"}
    </button>{error ? <p role="alert" className="mt-2 text-sm">{error}</p> : null}</div>
  );
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();

  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      error: response.ok
        ? "服务器返回了无法解析的响应。"
        : `服务器返回了无法解析的错误响应，状态码 ${response.status}。`
    };
  }
}

function getErrorMessage(payload: Record<string, unknown>, fallback: string): string {
  return typeof payload.error === "string" ? payload.error : fallback;
}

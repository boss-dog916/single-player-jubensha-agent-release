import { resolve, isAbsolute } from "node:path";

// One application baseline; API/model changes never change task budgets.
export const RUNTIME_BASELINE = {
  version: "stable-live-v1", timeoutMs: 90_000, plannerOutputTokens: 2400,
  maxOutputTokens: 2400, foregroundConcurrency: 1, backgroundConcurrency: 1,
  httpRetries: 0, storyBoardTimeoutMs: 30_000, storyBoardAttempts: 1,
  contextHardChars: 60_000, shareDraftEnabled: false
} as const;

export function applicationDatabaseUrl(raw = process.env.DATABASE_URL): string {
  const url = raw?.trim() || "file:../storage/app.db";
  if (!url.startsWith("file:")) throw new Error("DATABASE_URL must be a SQLite file: URL");
  const path = url.slice(5);
  if (!path || path.includes("?") || path.includes("#")) throw new Error("Use a SQLite file path without query/fragment");
  return `file:${isAbsolute(path) ? path : resolve(process.cwd(), "prisma", path)}`;
}

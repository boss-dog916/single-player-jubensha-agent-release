import { z } from "zod";

// Author-reviewed Runtime opt-in. Deliberately not part of the Parser contract.
export const RuntimeClueActionSchema = z.object({
  action: z.enum(["grant", "allow_share"]), clueIds: z.array(z.string().trim().min(1)).min(1).max(20)
}).strict();
export const ShareRuntimeClueSchema = z.object({
  clueId: z.string().trim().min(1), actId: z.string().min(1), requestId: z.string().min(1).max(128)
}).strict();
export type ClueScope = { definitionId: string; definitionVersion: number; actId: string };
export type ClueGrantReceipt = ClueScope & { clueId: string; roleId: string; nodeId: string; grantedAt: string };
export type ClueSharePermission = ClueScope & { clueId: string; roleId: string; nodeId: string; allowedAt: string };
export type CluePublication = ClueScope & { clueId: string; roleId: string; nodeId: string; messageId: string; requestId: string; publishedAt: string };
export type VisibleRuntimeClue = {
  clueId: string; title: string; text: string; source: string; pdfUrl?: string; visibility: "public" | "private";
  granted: boolean; grantedAt: string | null; shareAllowed: boolean; publiclyShared: boolean; messageId: string | null;
};

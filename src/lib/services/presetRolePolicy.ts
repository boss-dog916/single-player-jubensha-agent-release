import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type PresetRolePolicy = { roleName: string; reviewReason: string; reviewedFact: string; provenance: string;
  oldRestriction: string; retainedRestriction: string; reviewedIntentClause: string };

export function presetRolePolicy(): PresetRolePolicy | null {
  const path = resolve("storage/script-policies/long-night-v4.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as PresetRolePolicy : null;
}

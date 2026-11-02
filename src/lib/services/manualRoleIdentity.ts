import { z } from "zod";

const verifiedAliasSchema = z.object({
  id: z.string().min(1), alias: z.string().min(1), canonicalRoleId: z.string().min(1),
  source: z.object({ kind: z.literal("verified_manifest"), reference: z.string().min(1) }).strict()
}).strict();
const manifestIdentitySchema = z.object({
  roles: z.array(z.object({ role_id: z.string().optional(), role_name: z.string().optional(), name: z.string().optional(), displayName: z.string().optional(), aliases: z.array(z.string()).optional() })).optional(),
  verifiedAliases: z.array(verifiedAliasSchema).optional()
});
export type ManualRoleIdentity = {
  canonicalRoles: Array<{ id: string | null; displayName: string; source: "script_manifest" | "uploaded_booklet"; sourceId: string }>;
  verifiedAliases: Array<z.infer<typeof verifiedAliasSchema>>;
  unverifiedAliases: Array<{ alias: string; canonicalRoleId: string | null; sourceId: string }>;
};

export function buildManualRoleIdentity(manifest: unknown, manifestId: string, assets: Array<{ id: string; roleName: string | null }>): ManualRoleIdentity {
  const parsed = manifestIdentitySchema.parse(manifest), canonicalRoles: ManualRoleIdentity["canonicalRoles"] = [], unverifiedAliases: ManualRoleIdentity["unverifiedAliases"] = [];
  for (const [index, role] of (parsed.roles ?? []).entries()) {
    const displayName = role.role_name ?? role.displayName ?? role.name;
    if (!displayName) continue;
    const sourceId = `${manifestId}:roles:${index}`, id = role.role_id ?? null;
    canonicalRoles.push({ id, displayName, source: "script_manifest", sourceId });
    // Machine IDs and unverified language aliases are not alias evidence.
    unverifiedAliases.push(...(role.aliases ?? []).map(alias => ({ alias, canonicalRoleId: id, sourceId })));
  }
  for (const asset of assets) if (asset.roleName && !canonicalRoles.some(r => r.displayName === asset.roleName)) {
    canonicalRoles.push({ id: null, displayName: asset.roleName, source: "uploaded_booklet", sourceId: asset.id });
  }
  const verifiedAliases = parsed.verifiedAliases ?? [];
  const roleIds = canonicalRoles.map(r => r.id).filter(id => id !== null);
  if (new Set(roleIds).size !== roleIds.length || new Set(verifiedAliases.map(a => a.id)).size !== verifiedAliases.length) throw new Error("Duplicate manual role/verified alias identity");
  if (verifiedAliases.some(a => !roleIds.includes(a.canonicalRoleId))) throw new Error("Verified alias refers to an unknown canonical role ID");
  return { canonicalRoles, verifiedAliases, unverifiedAliases };
}

export function plannerRoleIdentity(source: { roleIdentity?: ManualRoleIdentity; knownRoles: Array<{ name: string; aliases: string[] }> }) {
  return {
    canonicalRoles: source.roleIdentity?.canonicalRoles ?? source.knownRoles.map(r => ({ id: null, displayName: r.name, source: "legacy_candidate" as const, sourceId: null })),
    verifiedAliases: source.roleIdentity?.verifiedAliases ?? []
  };
}

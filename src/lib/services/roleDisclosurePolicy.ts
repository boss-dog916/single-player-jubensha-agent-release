import { createHash } from "node:crypto";
import { presetRolePolicy } from "./presetRolePolicy";
import type { DiscussionUtteranceContext } from "../agents/aiPlayerDiscussionUtterance";

export const FILM_DISCLOSURE_REVIEW = "film-disclosure-user-review-20261029";
const reviewedIntentRestrictionHash = "4d7bd9221ceef51cb51616102bfbaaa7db803de8bb8cd97f8956c97ff35e1719";
const sourceHashes: Record<number, string> = {
  2: "0ad496fc8011b8ddc26431324c314bf29fff2caabeedebc1bbf87d695cddfe95",
  3: "cbbb32bb8f166f7b495c9fa19868151a9168d141e5c1f5300bf4eaa28b20bc34",
  4: "b18ae242dfbf19e948da137886e4e78bb5e823740c001bc6997b18829bb7f7be"
};
export const OLD_EXCHANGE_RESTRICTION = presetRolePolicy()?.oldRestriction ?? "";
export const RETAINED_ILLNESS_RESTRICTION = presetRolePolicy()?.retainedRestriction ?? "";
export type DisclosurePreference = { source_id: string; text: string; behavior: string };
const preferenceBehavior = "角色倾向先隐瞒，不是强制公开事项，也不单独构成硬禁令；优先分享其他经历。被具体追问、证据或情绪压力触及时可以选择承认。承认后全桌已听见，不能再当作无人知晓，也不要公开朗读未来撒谎策略。真正有效的保密限制仍优先。";

/** Only explicit soft authoring labels count as preferences. A real embargo
 * or conditional secret must never be weakened because of a vague synonym. */
export function isSoftDisclosurePreference(text: string) {
  return /^(?:暂不主动分享|不必主动分享|无需主动分享|可以暂时保留)[：:]/.test(text) &&
    !/必须|禁止|不得|不能(?:公开|透露)|解禁|直到|之前|第[一二三四五六七八九十0-9]+幕前/.test(text);
}

/** Presentation of role intentions, never a heuristic that deletes mustNotShare. */
export function isPrivateDefenseStrategy(text: string) {
  return /(?:你会如何做|你会如何回应|你会如何.*回应|不就是编造谎言|若.{0,12}(?:问|提起).{0,15}(?:否认|撒谎)|不能让.{1,12}(?:知道|察觉|意识到)|不愿.{0,10}知晓)/.test(text);
}

/** Explicit author/user-reviewed compatibility correction. Only matches the
 * exact owner's already completed originals; no game/definition/memory writes,
 * future reads, public-leak-based releases or general act-number unlocking.
 * Full originals and review provenance remain available to every consumer. */
export function roleDisclosurePolicy(context: DiscussionUtteranceContext) {
  const policy = presetRolePolicy();
  const current = context.current_role_booklet;
  const originals = context.historical_private_knowledge?.original_booklets ?? [];
  const ownBooks = [...originals, ...(current ? [current] : [])];
  const matches = (act: number) => ownBooks.some(b => b.roleName === policy?.roleName && b.actIndex === act &&
    createHash("sha256").update(b.privateText).digest("hex") === sourceHashes[act]);
  const filmReviewed = !!policy && context.role.name === policy.roleName && !!current && current.actIndex >= 4 && matches(4);
  const preferences: DisclosurePreference[] = [];
  const reviewEvidence: Array<{ id: string; actIndex: number; privateTextSha256: string; reason: string }> = [];
  if (filmReviewed) reviewEvidence.push({ id: FILM_DISCLOSURE_REVIEW, actIndex: 4, privateTextSha256: sourceHashes[4],
    reason: policy!.reviewReason });
  const annotations = <T extends { actIndex: number; privateText: string; mustShare: string[]; mayShare: string[]; mustNotShare: string[] }>(book: T, sourceId: string) => {
    const soft = book.mustNotShare.filter(isSoftDisclosurePreference);
    soft.forEach((text, i) => preferences.push({ source_id: `${sourceId}.soft_preference.${i}`, text, behavior: preferenceBehavior }));
    const optional = book.mustShare.filter(text => isPrivateDefenseStrategy(text) ||
      (filmReviewed && book.actIndex === 4 && matches(4) && /交换杀人/.test(text)));
    optional.forEach((text, i) => preferences.push({ source_id: `${sourceId}.disclosure_preference.${i}`, text, behavior: preferenceBehavior }));
    return { ...book, mustNotShare: book.mustNotShare.filter(t => !soft.includes(t)), mustShare: book.mustShare.filter(t => !optional.includes(t)),
      mayShare: [...new Set([...book.mayShare, ...optional.filter(t => !isPrivateDefenseStrategy(t))])] };
  };
  // Only exact reviewed original restrictions can change; do not reinterpret
  // arbitrary secrecy prose or discard unrelated rules sharing a keyword.
  const restriction = (text: string, actIndex?: number) => {
    if (!filmReviewed) return text;
    if ((actIndex === 3 || actIndex === undefined) && matches(3) && text === policy!.oldRestriction)
      return policy!.retainedRestriction;
    if ((actIndex === 2 || actIndex === undefined) && matches(2)) {
      if (createHash("sha256").update(text).digest("hex") === reviewedIntentRestrictionHash && text.includes(policy!.reviewedIntentClause))
        return text.replace(policy!.reviewedIntentClause, "");
    }
    return text;
  };
  return { current: current ? annotations(current, "current") : null,
    history: originals.map(b => annotations(b, b.sourceRoleActBookletId)),
    preferences, reviewEvidence, restriction,
    reviewedFacts: filmReviewed && matches(2) ? [{ id: `${FILM_DISCLOSURE_REVIEW}.own_target`,
      text: policy!.reviewedFact,
      provenance: policy!.provenance }] : [] };
}

/** Only flag a concrete audience/strategy conflict for the existing semantic
 * Checker. Past wishes and off-table recipients are not contradictions. */
export function publicDisclosureConflict(text: string, audience: Array<{ name: string; role_id: string; aliases?: string[] }>) {
  return text.split(/[。！？!?；;\n]+/).find(clause => {
    if (/(?:原本|以前|曾经|当时|过去|之前).*(?:不想|不能|不敢|否认)|(?:现在|如今|已经).*(?:承认|坦白|知道|听见)/.test(clause)) return false;
    if (/(?:若|如果|有人).{0,25}(?:问|提起|追问).{0,25}(?:我会|我就|我要).{0,15}(?:否认|撒谎|诬陷|编造)/.test(clause)) return true;
    return audience.some(role => [role.role_id, role.name, ...role.aliases ?? []].some(name => name.length >= 2 &&
      (clause.includes(`不能让${name}知道`) || clause.includes(`不能让${name}察觉`) || clause.includes(`不能让${name}意识到`))));
  });
}

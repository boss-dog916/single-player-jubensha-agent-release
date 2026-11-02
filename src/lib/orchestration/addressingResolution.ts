export type PublicRole = { role_id: string; name: string; aliases?: string[] };
export function publicDiscussionRoster(roles: PublicRole[], messages: Array<{ speaker_role_id: string | null; speaker_type: string; content: string }>): PublicRole[] {
  return roles.map(role => ({ ...role, aliases: [...(role.aliases ?? []), ...messages.filter(m => m.speaker_role_id === role.role_id &&
    ["user", "ai_player"].includes(m.speaker_type)).flatMap(m => [...m.content.matchAll(/(?:^|[。！!；;，,])(?:是的，)?我(?:叫|就是|是)([\u4e00-\u9fff]{2,4})[，,。！!；;\s]/g)].map(x => x[1]))] }));
}
export type Addressing = {
  addressingMode: "direct" | "group" | "open" | "none";
  directTargets: string[];
  referencedRoles: string[];
  excludedTargets: string[];
  topic: string;
};
export type AddressingResolution = Addressing & {
  source: "heuristic" | "planner";
  needsPlanner: boolean;
  controlMessage: boolean;
  reason: string;
};

function escaped(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function aliasPattern(alias: string) { return [...alias].map(escaped).join("\\s*"); }
function aliases(role: PublicRole) { return [role.name, role.role_id, ...(role.aliases ?? [])].filter(Boolean); }
export function mentionsRole(text: string, role: PublicRole): boolean {
  return aliases(role).some((alias) =>
    /^[A-Za-z0-9_-]+$/.test(alias)
      ? new RegExp(`(^|[^A-Za-z0-9_-])${escaped(alias)}($|[^A-Za-z0-9_-])`, "i").test(text)
      : new RegExp(aliasPattern(alias), "i").test(text));
}

// Only recognize overt surface structures; semantic ambiguity stays in the existing Planner.
export function resolveAddressing(text: string, roles: PublicRole[]): AddressingResolution {
  const content = text.trim();
  const controlMessage = /^(继续|下一位|DM\s*继续|没了|我说完了)[。.!！\s]*$/i.test(content);
  const mentioned = roles.filter((role) => mentionsRole(content, role));
  const groupInvitation = /^(?:你们|大家|各位|其他人)(?:先说|先讲|说说|的想法|怎么看)|谁还没(?:说|讲|分享)/.test(content);
  const question = groupInvitation || /[?？]|吗|呢|怎么看|有没有|谁|哪位|问一下|问问|解释一下|补充|说一下|说说/.test(content);
  const group = /大家|各位|你们|其他人|其他几个人|别人|还有谁|有没有人|有没有谁|谁还|都醒了|都记起来|自己是谁|有这种感觉|只有我/.test(content);
  const vocative = question && !group ? mentioned.find(role => aliases(role).some(alias =>
    new RegExp(`^${aliasPattern(alias)}[，,]`, "i").test(content))) : undefined;
  const directTargets = mentioned.filter((role) => aliases(role).some((alias) =>
    (role === vocative) || new RegExp(`(^|[，,。！!？?\\s])${aliasPattern(alias)}[，,\\s]*(你|能|可以|请|说一下|说说|回答|回应)`, "i").test(content) ||
    new RegExp(`(我问一下|我想问问|问一下)\\s*${aliasPattern(alias)}(?:[，,。？?\\s]|$)`, "i").test(content)
  )).map((role) => role.role_id);
  const referencedRoles = mentioned.map((role) => role.role_id).filter((id) => !directTargets.includes(id));
  const excludedTargets = mentioned.filter((role) =>
    new RegExp(`除了\\s*${escaped(role.name)}`).test(content) ||
    (mentioned.length === 1 && group && /其他人|其他几个人|别人/.test(content) &&
      new RegExp(`${escaped(role.name)}(?:刚才|刚刚|之前|刚|也|曾经)?(?:说|提到|的话|的说法)`).test(content))
  ).map((role) => role.role_id);
  const explicitOpening = directTargets.length === 1 && mentioned.some(role => role.role_id === directTargets[0] &&
    aliases(role).some(alias => new RegExp(`^${aliasPattern(alias)}`, "i").test(content)));
  const ambiguous = !controlMessage && !explicitOpening && (mentioned.length > 1 ||
    (mentioned.length > 0 && (group || directTargets.length === 0)) ||
    /他[们]?说|她[们]?说|你怎么看/.test(content) && mentioned.length === 0);
  return {
    addressingMode: controlMessage ? "none" : directTargets.length ? "direct" : group && question ? "group" : question ? "open" : "none",
    directTargets: controlMessage ? [] : directTargets,
    referencedRoles: controlMessage ? [] : referencedRoles,
    excludedTargets: controlMessage ? [] : excludedTargets,
    topic: content.slice(0, 180),
    source: "heuristic", needsPlanner: ambiguous, controlMessage,
    reason: controlMessage ? "控制消息，不选择回应者" : ambiguous ? "只作预分析，由现有 Planner 判断语义" : "明确表层结构"
  };
}

export function sanitizeAddressing(value: Addressing, roles: PublicRole[]): Addressing {
  const valid = new Set(roles.map((role) => role.role_id));
  const ids = (items: string[]) => [...new Set(items)].filter((id) => valid.has(id));
  return { ...value, directTargets: ids(value.directTargets), referencedRoles: ids(value.referencedRoles),
    excludedTargets: ids(value.excludedTargets), topic: value.topic.slice(0, 180) };
}

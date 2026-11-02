export function updateMatchingDraft(draft: Record<string, string>, roleId: string, optionId: string) {
  const next = { ...draft }, previous = next[roleId] ?? "";
  const other = optionId ? Object.keys(next).find(r => r !== roleId && next[r] === optionId) : undefined;
  next[roleId] = optionId;
  if (other) next[other] = previous; // Swap, or clear the other row if this row was empty.
  return next;
}
export function completeMatchingDraft(draft: Record<string, string>, roles: string[], options: string[]) {
  const selected = roles.map(r => draft[r]);
  return roles.length === options.length && selected.every(o => options.includes(o)) && new Set(selected).size === roles.length;
}

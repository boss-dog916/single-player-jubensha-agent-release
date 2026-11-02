// Self-knowledge, not an omniscient identity table. Only the owner's already
// readable sources may enter here; a later revelation cannot change this anchor.
export function currentIdentityAnchor(booklets: Array<{ actIndex: number; privateText: string; mustShare: string[] }>, roleId: string) {
  for (const b of [...booklets].sort((a, z) => z.actIndex - a.actIndex)) {
    for (const text of [...b.mustShare, ...b.privateText.split(/\n/)]) {
      const match = text.trim().match(/^你(?:的名字(?:叫|是)|叫)([\u4e00-\u9fff]{2,4})[，,。\s]/);
      if (match) return { role_id: roleId, self_name: match[1], source_act: b.actIndex,
        perspective: "当前已读阶段的自我认知；私本叙述中的‘你’指本人。这个姓名不是另一个人，也不是对后续真实身份的断言。" };
    }
  }
  return { role_id: roleId, self_name: null, source_act: null, perspective: "身份尚不确定，不推断后续身份。" };
}

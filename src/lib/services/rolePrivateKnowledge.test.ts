import { describe, expect, it } from "vitest";
import { buildHistoricalPrivateKnowledge, type PrivateBookletSource } from "./rolePrivateKnowledge";
import { createEmptyRoleMemory } from "./roleMemoryService";

const source = (actIndex: number, roleName = "本人"): PrivateBookletSource => ({
  actId: `act_${actIndex}`, actIndex, roleName, definitionId: "frozen-v1", sourceRoleActBookletId: `book-${roleName}-${actIndex}`,
  privateText: "2010年，我可能在北站看见姐姐，并不能确定。\n铜钥匙藏在蓝盒里，不能说。\n我在河边捡到一把旧伞。",
  mustShare: ["2010年，我可能在北站看见姐姐，并不能确定。"], mayShare: [], mustNotShare: ["铜钥匙藏在蓝盒里，不能说。"],
  relationshipPoints: [], timelineFragments: [], emotionalPoints: []
});

describe("source-preserving bounded historical private knowledge", () => {
  it("uses only the owner's earlier completed reading receipts, never future/current or another role", () => {
    const memory = createEmptyRoleMemory();
    memory.internal_readings = { act_1: { status: "completed" }, act_2: { status: "failed" }, act_4: { status: "completed" } };
    const result = buildHistoricalPrivateKnowledge({ booklets: [source(1), source(1, "别人"), source(2), source(3), source(4)],
      roleNames: ["本人"], currentActIndex: 3, memory, query: "河边旧伞在哪里？" });
    expect(result.summary.every(e => e.source.bookletId === "book-本人-1")).toBe(true);
    expect(result.relevant_original_passages.map(p => p.text)).toContain("我在河边捡到一把旧伞。");
    expect(result.relevant_original_passages.find(p => p.text.includes("旧伞"))?.permission).toBe("unclassified");
    expect(result.restrictions).toHaveLength(1);
    for (const e of [...result.summary, ...result.relevant_original_passages])
      expect(source(1).privateText.slice(e.source.start!, e.source.end!)).toBe(e.text);
  });
  it("does not rewrite uncertainty, people or dates; annotations have no fabricated raw location", () => {
    const b = source(1); b.timelineFragments = ["剧本注记：不确定的见闻"]; const memory = createEmptyRoleMemory();
    memory.internal_readings = { act_1: { status: "completed" } };
    const result = buildHistoricalPrivateKnowledge({ booklets: [b], roleNames: ["本人"], currentActIndex: 2, memory, query: "北站姐姐" });
    expect(result.summary[0].text).toBe(b.mustShare[0]);
    expect(result.summary.find(e => e.source.field === "timelineFragments")).toMatchObject({ permission: "unclassified", source: { start: null, end: null } });
    expect(result.restrictions[0].mustNotShare).toEqual(b.mustNotShare);
  });
  it("bounds history without copying every original or dropping secrecy when summary is full", () => {
    const booklets = Array.from({ length: 12 }, (_, i) => {
      const b = source(i + 1); b.mustShare = Array.from({ length: 20 }, (_, j) => `第${j}段。` + "原文".repeat(80));
      b.privateText = b.mustShare.join("\n") + "\n" + b.privateText; return b;
    });
    const memory = createEmptyRoleMemory(); memory.internal_readings = Object.fromEntries(booklets.map(b => [b.actId, { status: "completed" as const }]));
    const result = buildHistoricalPrivateKnowledge({ booklets, roleNames: ["本人"], currentActIndex: 13, memory, query: "原文北站" });
    expect(result.summary.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(4000);
    expect(result.summary.length).toBeLessThanOrEqual(36);
    expect(result.relevant_original_passages.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(2400);
    expect(result.relevant_original_passages.length).toBeLessThanOrEqual(3);
    expect(result.restrictions).toHaveLength(12);
  });
});

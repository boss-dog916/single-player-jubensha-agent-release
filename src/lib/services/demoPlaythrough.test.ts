import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { chatSubmissionType } from "@/components/playerInteraction";

let root: string, prisma: typeof import("@/src/lib/db/prisma").prisma;
let llm: typeof import("@/src/lib/llm/llmClient");
let post: typeof import("@/app/api/games/[gameId]/route").POST;
let read: typeof import("@/app/api/games/[gameId]/ai-internal-reading/route").POST;
let cookie: string, gameId: string;
const network = vi.fn(() => { throw new Error("Real network forbidden in demo regression"); });
const ctx = () => ({ params: Promise.resolve({ gameId }) });
const req = (body: unknown) => new NextRequest(`http://localhost/api/games/${gameId}`, {
  method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body)
});
async function settle() {
  await (await import("./postShareTaskService")).drainPostShareTasks(gameId);
  await (await import("./conversationService")).drainConversation(gameId);
}
async function event(body: unknown) {
  await settle();
  const response = await post(req(body), ctx());
  const result = await response.json();
  expect(response.status, JSON.stringify({ body, result })).toBe(200);
  await settle();
  return result;
}
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "rain-lantern-mock-")); writeFileSync(join(root, "test.db"), "");
  vi.stubEnv("DATABASE_URL", `file:${join(root, "test.db")}`); vi.stubEnv("LONG_NIGHT_PLAYTEST_DIR", "");
  vi.stubEnv("LOCAL_ACCESS_SIGNING_KEY", "demo-test-signing-key-".repeat(3)); vi.stubEnv("SHARE_DRAFT_ENABLED", "false");
  vi.stubGlobal("fetch", network);
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: process.env, stdio: "pipe" });
  prisma = (await import("@/src/lib/db/prisma")).prisma;
  llm = await import("@/src/lib/llm/llmClient"); llm.setLlmClientForTests((await import("@/src/lib/llm/mockLlmClient")).createMockLlmClient());
  post = (await import("@/app/api/games/[gameId]/route")).POST;
  read = (await import("@/app/api/games/[gameId]/ai-internal-reading/route")).POST;
}, 30000);
afterAll(async () => {
  if (gameId) await settle();
  expect(network).not.toHaveBeenCalled(); llm?.setLlmClientForTests(null); await prisma?.$disconnect();
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true });
});

it("finishes all three acts through player APIs, with no model needed for demo reading", async () => {
  const scripts = await (await import("./playerLibraryService")).listPlayableScripts();
  const created = await (await import("@/app/api/player/games/route")).POST(req({ scriptPackageId: scripts[0].id }));
  expect(created.status).toBe(201); gameId = (await created.json()).gameId; cookie = created.headers.get("set-cookie")!.split(";")[0];
  await event({ type: "SELECT_ROLE", roleId: "role_d" });
  const service = await import("./gameService"), packages = await import("./scriptPackageService");
  const originalScriptJson = (await prisma.scriptPackage.findUniqueOrThrow({ where: { id: scripts[0].id } })).scriptJson;
  for (let act = 1; act <= 3; act++) {
    expect((await service.getGameSession(gameId)).currentPhase).toBe("reading");
    const script = await packages.getScriptForGameSession(gameId), booklet = script.acts[act - 1];
    expect(new Set(booklet.share_order)).toEqual(new Set(script.roles.map(r => r.role_id)));
    const before = await prisma.agentRun.count({ where: { gameSessionId: gameId, runKind: "llm" } });
    const reading = await read(req({}), ctx()); expect(reading.status).toBe(200);
    expect(await prisma.agentRun.count({ where: { gameSessionId: gameId, runKind: "llm" } })).toBe(before);
    for (const roleId of (await service.getGameSession(gameId)).aiRoleIds) {
      const memory = await (await import("./roleMemoryService")).getRoleMemory(gameId, roleId);
      expect(memory.internal_readings?.[`act_${act}`]?.status).toBe("completed");
      const text = booklet.booklets.find(b => b.role_id === roleId)!.private_text;
      expect(memory.private_memory_so_far.some(m => m.includes(text))).toBe(true);
      expect(memory.private_memory_so_far.some(m => m.includes(booklet.booklets.find(b => b.role_id === "role_d")!.private_text))).toBe(false);
      if (act < 3) expect(JSON.stringify(memory)).not.toContain(script.acts[act].booklets.find(b => b.role_id === roleId)!.private_text);
    }
    const receiptCount = await prisma.agentRun.count({ where: { gameSessionId: gameId, agentType: "ai_player_internal_reading", actId: `act_${act}` } });
    await read(req({}), ctx());
    expect(await prisma.agentRun.count({ where: { gameSessionId: gameId, agentType: "ai_player_internal_reading", actId: `act_${act}` } })).toBe(receiptCount);
    await event({ type: "USER_FINISHED_READING" });
    for (let turn = 0; turn < 4; turn++) {
      const session = await service.getGameSession(gameId);
      expect(session.currentPhase).toBe("share_round");
      const roleId = booklet.share_order[session.currentShareIndex];
      if (roleId === "role_d") {
        if (act === 1) {
          const content = "林安，你昨晚看到了什么？";
          await event({ type: chatSubmissionType({ canShare: true, content }), content, clientMessageId: "temporary-question-during-share" });
          expect((await service.getGameSession(gameId)).currentShareIndex).toBe(session.currentShareIndex);
        }
        const content = booklet.booklets.find(b => b.role_id === roleId)!.must_share.join("；");
        const submission = { type: chatSubmissionType({ canShare: true, content }), content, actId: session.currentActId, shareIndex: session.currentShareIndex };
        expect(submission.type).toBe("USER_SHARE");
        await event(submission);
        const count = await prisma.message.count({ where: { gameSessionId: gameId, speakerType: "user", speechAct: "share" } });
        const repeated = await post(req(submission), ctx());
        expect(repeated.status).toBe(409);
        expect(await prisma.message.count({ where: { gameSessionId: gameId, speakerType: "user", speechAct: "share" } })).toBe(count);
      } else await event({ type: "AI_SHARE" });
    }
    expect((await service.getGameSession(gameId)).currentPhase).toBe("free_discussion");
    if (act === 1) {
      await prisma.conversationState.update({ where: { gameSessionId: gameId }, data: {
        status: "failed", stage: "idle", errorMessage: "addressing_conflict: role_a wants to answer itself but names a different addressee"
      } });
      const base = (await import("@/src/lib/llm/mockLlmClient")).createMockLlmClient();
      let injected = 0;
      llm.setLlmClientForTests({ ...base, generateStructured: input => {
        if (input.agentType !== "ai_player_reaction_planner" || input.roleId !== "role_a") return base.generateStructured(input);
        injected++;
        return base.generateStructured({ ...input, mockOutput: {
          role_id: "role_a", wants_to_speak: true, trigger_type: "direct_question_to_self", relevance_score: 5,
          urgency_score: 4, emotional_intensity_score: 2, boundary_risk: "low", target_role_ids: ["role_d"], speech_act: "answer",
          reason: "夏月声明自己是林安的女朋友。", brief_intent: "确认关系。",
          addressing: { addressingMode: "direct", directTargets: ["role_d"], referencedRoles: [], excludedTargets: [], topic: "身份关系" }
        } });
      } });
      await event({ type: "USER_DISCUSSION", content: "我是林安女朋友", clientMessageId: "witnessed-demo-introduction" });
      expect(injected).toBeGreaterThan(0);
      expect(await prisma.conversationState.findUniqueOrThrow({ where: { gameSessionId: gameId } })).toMatchObject({ status: "idle", errorMessage: null });
      expect(await prisma.agentRun.count({ where: { gameSessionId: gameId, status: "failed", errorMessage: { contains: "addressing_conflict:" } } })).toBe(0);
      llm.setLlmClientForTests(base);
    }
    await event({ type: "USER_DISCUSSION", content: "请林安说说你这一幕记得的事情。", clientMessageId: `demo-act-${act}` });
    await event({ type: "NEXT_ACT" });
  }
  expect((await service.getGameSession(gameId)).currentPhase).toBe("finished");
  expect((await prisma.scriptPackage.findUniqueOrThrow({ where: { id: scripts[0].id } })).scriptJson).toBe(originalScriptJson);
  expect(await prisma.agentRun.count({ where: { gameSessionId: gameId, agentType: "ai_player_internal_reading", runKind: "llm" } })).toBe(0);
}, 60000);

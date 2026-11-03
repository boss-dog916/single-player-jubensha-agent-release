import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { issueCredential, playerCookieName, developerCookieName, playerGameIdsFromCookies } from "./localCredentials";
import { toPlayerSnapshot } from "./playerView";

vi.mock("@/src/lib/agents/dmFlowRunner", () => ({ runDmFlowStep: vi.fn(async () => ({})) }));
let pageCookie = "";
vi.mock("next/headers", () => ({ cookies: async () => ({ toString: () => pageCookie }) }));
let root: string, prisma: typeof import("@/src/lib/db/prisma").prisma;
let catalog: typeof import("@/src/lib/services/playerLibraryService"), create: typeof import("@/app/api/player/games/route").POST;
let getGame: typeof import("@/app/api/games/[gameId]/route").GET, postGame: typeof import("@/app/api/games/[gameId]/route").POST;
let first: string, second: string, cookie1: string, cookie2: string;
const network = vi.fn(() => { throw new Error("External requests forbidden"); });
const context = (id: string) => ({ params: Promise.resolve({ gameId: id }) });
const request = (url: string, cookie = "", body?: unknown) => new NextRequest(`http://localhost${url}`, {
  method: body === undefined ? "GET" : "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jubensha-player-entry-"));
  writeFileSync(join(root, "test.db"), "");
  vi.stubEnv("DATABASE_URL", `file:${join(root, "test.db")}`); vi.stubEnv("LONG_NIGHT_PLAYTEST_DIR", "");
  vi.stubEnv("LOCAL_ACCESS_SIGNING_KEY", "only-for-local-tests-".repeat(3)); vi.stubEnv("LOCAL_DEVELOPER_TOKEN", "owner-credential-test-".repeat(3));
  vi.stubGlobal("fetch", network);
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: process.env, stdio: "pipe" });
  prisma = (await import("@/src/lib/db/prisma")).prisma;
  catalog = await import("@/src/lib/services/playerLibraryService");
  create = (await import("@/app/api/player/games/route")).POST;
  ({ GET: getGame, POST: postGame } = await import("@/app/api/games/[gameId]/route"));
}, 30000);
afterAll(async () => { expect(network).not.toHaveBeenCalled(); await prisma?.$disconnect(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it("lists only public playable summaries and creates a fresh browser's own game", async () => {
  const [scripts, concurrent] = await Promise.all([catalog.listPlayableScripts(), catalog.listPlayableScripts()]);
  expect(concurrent).toEqual(scripts);
  expect(scripts.length).toBeGreaterThan(0);
  expect(Object.keys(scripts[0]).sort()).toEqual(["id", "title", "runtimeDefinitionId", "version", "kind", "roleCount", "actCount"].sort());
  expect(JSON.stringify(scripts)).not.toMatch(/private_text|privateText|mustNotShare|definitionJson|GroupMatchingKey|sourceMetaJson/);
  const a = await create(request("/api/player/games", "", { scriptPackageId: scripts[0].id }));
  expect(a.status).toBe(201); first = (await a.json()).gameId; cookie1 = a.headers.get("set-cookie")!.split(";")[0];
  expect(a.headers.get("set-cookie")).toContain("HttpOnly");
  expect(cookie1).not.toContain("jubensha_developer");
  const b = await create(request("/api/player/games", "", { scriptPackageId: scripts[0].id }));
  second = (await b.json()).gameId; cookie2 = b.headers.get("set-cookie")!.split(";")[0];
  expect(first).not.toBe(second);
  const own = await getGame(request(`/api/games/${first}`, cookie1), context(first));
  expect(own.status).toBe(200); const view = await own.json();
  expect(view.session.currentPhase).toBe("role_selection"); expect(view.userBooklet).toBeNull();
  expect(view).not.toHaveProperty("recentAgentRuns"); expect(view).not.toHaveProperty("roleMemories");
});
it("rejects debug scope overrides, unplayable packages and cross-origin creation", async () => {
  const script = (await catalog.listPlayableScripts())[0], before = await prisma.gameSession.count();
  for (const options of [{ testMode: true }, { actRange: { start: 2 } }, { roleNames: ["other"] }, { runtimeMode: "runtime_manual_debug" }, { id: first }])
    expect((await create(request("/api/player/games", "", { scriptPackageId: script.id, ...options }))).status).toBe(400);
  const draft = await prisma.scriptPackage.create({ data: { title: "PRIVATE-CANDIDATE", status: "DRAFT", scriptJson: "{}" } });
  expect((await catalog.listPlayableScripts()).some(s => s.id === draft.id)).toBe(false);
  expect((await create(request("/api/player/games", "", { scriptPackageId: draft.id }))).status).toBe(404);
  expect((await create(new NextRequest("http://localhost/api/player/games", { method: "POST", headers: { origin: "https://other.invalid" }, body: "{}" }))).status).toBe(403);
  expect(await prisma.gameSession.count()).toBe(before);
});
it("lists saves only from signed per-game grants, never from game IDs or developer privilege alone", async () => {
  expect(await catalog.listBrowserGames("")).toEqual([]);
  expect((await catalog.listBrowserGames(cookie1)).map(g => g.id)).toEqual([first]);
  const fake = `${playerCookieName(second)}=${cookie1.slice(cookie1.indexOf("=") + 1)}`;
  expect(playerGameIdsFromCookies(fake)).toEqual([]);
  const dev = `${developerCookieName()}=${issueCredential("developer")}`;
  expect(await catalog.listBrowserGames(dev)).toEqual([]);
  expect((await catalog.listBrowserGames(`${cookie1}; ${cookie2}`)).length).toBe(2);
});
it("allows role selection but never another game's data, PDF, management or debug", async () => {
  const selected = await postGame(request(`/api/games/${first}`, cookie1, { type: "SELECT_ROLE", roleId: "role_a" }), context(first));
  expect(selected.status).toBe(200);
  const view = await selected.json(); expect(view.session.userRoleId).toBe("role_a"); expect(view.userBooklet.role_id).toBe("role_a");
  const script = (await import("@/src/lib/script/loadScript")).loadScript();
  for (const book of script.acts[0].booklets.filter(b => b.role_id !== "role_a")) expect(JSON.stringify(view)).not.toContain(book.private_text);
  expect((await getGame(request(`/api/games/${second}`, cookie1), context(second))).status).toBe(401);
  const debug = (await import("@/app/api/games/[gameId]/debug/route")).GET;
  expect((await debug(request(`/api/games/${first}/debug`, cookie1), context(first))).status).toBe(401);
  const pdf = (await import("@/app/api/games/[gameId]/player-display/pdf/route")).GET;
  expect((await pdf(request(`/api/games/${second}/player-display/pdf`, cookie1), context(second))).status).toBe(401);
  const management = (await import("@/app/api/script-packages/route")).GET;
  expect((await management(request("/api/script-packages", cookie1))).status).toBe(401);
});
it("keeps developer login and debug behind the existing credential", async () => {
  const login = (await import("@/app/api/access/developer/route")).POST;
  const logged = await login(request("/api/access/developer", "", { token: process.env.LOCAL_DEVELOPER_TOKEN }));
  expect(logged.status).toBe(200); const dev = logged.headers.get("set-cookie")!.split(";")[0];
  const debug = (await import("@/app/api/games/[gameId]/debug/route")).GET;
  expect((await debug(request(`/api/games/${first}/debug`, dev), context(first))).status).toBe(200);
});
it("renders the player layout without Debug or an empty debug column and makes the PDF hint readable", async () => {
  const snapshot = toPlayerSnapshot(await (await import("@/src/lib/services/gameRuntimeSnapshotService")).getGameRuntimeSnapshot(first));
  const { GameLayout } = await import("@/components/GameLayout");
  const html = renderToStaticMarkup(<GameLayout initialSnapshot={snapshot} developerMode={false} />);
  expect(html).not.toMatch(/DebugPanel|DEBUG|预览玩家视角|返回开发者视角/);
  expect(html).toContain("lg:grid-cols-[280px_minmax(0,1fr)]");
  const sharing = { ...snapshot, session: { ...snapshot.session, currentPhase: "share_round" as const,
    currentShareIndex: snapshot.game.acts[0].share_order.indexOf(snapshot.session.userRoleId!) } };
  const sharingHtml = renderToStaticMarkup(<GameLayout initialSnapshot={sharing} />);
  expect(sharingHtml).not.toContain("发送我的分享");
  expect(sharingHtml).toContain("本条发言用途"); expect(sharingHtml).toContain("发送后完成本轮分享");
  expect(sharingHtml.match(/>发送<\/button>/g)).toHaveLength(1);
  const reading = { ...snapshot, playerPdfReading: { status: "available", roleName: "原创角色", roleId: "role_a", actIndex: 1,
    actTitle: "阅读示例", sectionId: "s", assetId: "a", originalName: "fixture.pdf", pdfUrl: "/mock.pdf", pageStart: 1, pageEnd: 1 } } as typeof snapshot;
  const pdf = renderToStaticMarkup(<GameLayout initialSnapshot={reading} />);
  expect(pdf).toContain("pdf-reader-hint"); expect(pdf).toContain("浏览器内置 PDF 预览若无法显示");
  const css = readFileSync("app/globals.css", "utf8"); expect(css).toMatch(/\.pdf-reader-hint\s*\{[^}]*#fbf7ef[^}]*#374151/);
});

it("opens the demo booklet page with only the player's current and past text chapters", async () => {
  const { default: Page } = await import("@/app/games/[gameId]/player-booklet/page");
  const { getPlayerPdfBookletForReading, getPlayerDisplaySectionForReading } = await import("@/src/lib/services/playerPdfReadingService");
  const { PlayerBookletReader } = await import("@/components/PlayerBookletReader");
  const script = (await import("@/src/lib/script/loadScript")).loadScript();
  pageCookie = cookie1;
  const page = await Page({ ...context(first), searchParams: Promise.resolve({ actIndex: "99" }) });
  const html = renderToStaticMarkup(page);
  expect(html).toContain(script.acts[0].booklets.find(b => b.role_id === "role_a")!.private_text);
  expect(html).toContain("返回游戏"); expect(html).toContain('href="#booklet-act-1"');
  expect(html).not.toContain("booklet-act-2"); expect(html).not.toContain("<iframe");
  for (const booklet of script.acts.flatMap(a => a.booklets).filter(b => b.role_id !== "role_a"))
    expect(html).not.toContain(booklet.private_text);
  await expect(getPlayerPdfBookletForReading(second)).rejects.toMatchObject({ statusCode: 403 });
  await expect(getPlayerDisplaySectionForReading({ gameSessionId: first })).rejects.toMatchObject({ statusCode: 404 });
  await prisma.gameSession.update({ where: { id: first }, data: { currentActId: "act_2" } });
  const reader = await getPlayerPdfBookletForReading(first);
  expect(reader.currentActIndex).toBe(2); expect(reader.chapters.map(c => c.actIndex)).toEqual([1, 2]);
  expect(reader.chapters[1].text).toBe(script.acts[1].booklets.find(b => b.role_id === "role_a")!.private_text);
  expect(reader.chapters.some(c => c.actIndex === 3)).toBe(false);
  pageCookie = cookie2;
  const denied = renderToStaticMarkup(await Page({ ...context(first), searchParams: Promise.resolve({}) }));
  expect(denied).toContain("此浏览器没有本局访问凭证");
  for (const chapter of reader.chapters) expect(denied).not.toContain(chapter.text!);
  const pdf = renderToStaticMarkup(<PlayerBookletReader gameId={first} initialActIndex={1}
    reader={{ roleId: "role_a", roleName: "原创角色", currentActIndex: 1, chapters: [{ actIndex: 1, actTitle: "PDF示例", documents: [{
      sectionId: "section", assetId: "asset", originalName: "fixture.pdf", pdfUrl: `/api/games/${first}/player-display/pdf`,
      pageStart: 1, pageEnd: 1, readingOrder: 0, required: true, completed: false
    }] }] }} />);
  expect(pdf).toContain("<iframe"); expect(pdf).toContain(`/api/games/${first}/player-display/pdf#page=1`);
});

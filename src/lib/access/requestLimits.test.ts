import { describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { assertJsonLimits, boundedRequest, MAX_JSON_BYTES, MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_REQUEST_BYTES, RequestInputError, validateUploadForm } from "./requestLimits";
import { developerRoute, playerRoute } from "./routes";

vi.mock("./localCredentials", () => ({
  isDeveloperRequest: (r: Request) => r.headers.get("authorization") === "Bearer owner",
  isGameRequest: (r: Request) => ["Bearer owner", "Bearer player"].includes(r.headers.get("authorization") ?? ""),
  safeMutation: (r: Request) => r.headers.get("origin") !== "https://other.invalid",
  developerSecret: () => "local-test-owner", cookieOptions: () => ({}), developerCookieName: () => "test-owner", issueCredential: () => "test-grant"
}));
vi.mock("@/src/lib/services/dmFlowService", () => ({ parseDMFlowForScriptPackage: vi.fn() }));
vi.mock("@/src/lib/services/manualSemanticParseService", () => ({ parseManualSemanticCandidate: vi.fn() }));

const jsonRequest = (value: unknown, headers: Record<string, string> = {}) => new NextRequest("http://localhost/api/test", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value)
});

describe("bounded external input before business handlers", () => {
  it("preserves valid JSON, unicode, headers and the NextRequest interface", async () => {
    const value = { content: "保留原始发言", items: [1, 2] };
    const r = await boundedRequest(jsonRequest(value, { authorization: "Bearer owner" }));
    expect(r).toBeInstanceOf(NextRequest); expect(await r.json()).toEqual(value);
    expect(r.headers.get("authorization")).toBe("Bearer owner");
  });
  it("rejects an advertised oversized body before parsing", async () => {
    await expect(boundedRequest(jsonRequest({}, { "content-length": String(MAX_JSON_BYTES + 1) }))).rejects.toMatchObject({ status: 413 });
  });
  it("bounds real streamed bytes when Content-Length is missing or falsely small", async () => {
    for (const headers of [{}, { "content-length": "1" }]) {
      const r = new Request("http://localhost/api/test", { method: "POST", headers,
        body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_JSON_BYTES)); c.enqueue(new Uint8Array(1)); c.close(); } }), duplex: "half" } as RequestInit);
      await expect(boundedRequest(r)).rejects.toMatchObject({ status: 413 });
    }
  });
  it("rejects malformed JSON without returning input or stack traces", async () => {
    const r = new Request("http://localhost/api/test", { method: "POST", body: "{PRIVATE-INPUT" });
    await expect(boundedRequest(r)).rejects.toMatchObject({ status: 400, message: "请求必须为有效JSON。" });
  });
  it("accepts empty optional bodies", async () => {
    expect(await (await boundedRequest(new Request("http://localhost/api/test", { method: "POST" }))).text()).toBe("");
  });
  it("rejects oversized collections, deep nesting and aggregate node growth before Zod", () => {
    expect(() => assertJsonLimits(Array(1001).fill(0))).toThrow(RequestInputError);
    let deep: unknown = 0; for (let i = 0; i < 34; i++) deep = { nested: deep };
    expect(() => assertJsonLimits(deep)).toThrow(RequestInputError);
    expect(() => assertJsonLimits(Array.from({ length: 11 }, () => Array(1000).fill(0)))).toThrow(RequestInputError);
    expect(() => assertJsonLimits({ items: Array(1000).fill(1) })).not.toThrow();
  });
  it("only enables the larger multipart limit at the upload boundary", async () => {
    const form = new FormData(); form.set("file", new File(["pdf"], "test.pdf"));
    const req = () => new Request("http://localhost/api/test", { method: "POST", body: form });
    await expect(boundedRequest(req())).rejects.toMatchObject({ status: 415 });
    const accepted = await boundedRequest(req(), { allowMultipart: true });
    const parsed = await accepted.formData(); expect((parsed.get("file") as File).name).toBe("test.pdf");
    expect(() => validateUploadForm(parsed)).not.toThrow();
    await expect(boundedRequest(new Request("http://localhost/api/test", { method: "POST", headers: {
      "content-type": "multipart/form-data; boundary=test", "content-length": String(MAX_UPLOAD_REQUEST_BYTES + 1)
    } }), { allowMultipart: true })).rejects.toMatchObject({ status: 413 });
  });
  it("checks file bytes, field count and metadata before storage", () => {
    const huge = new File(["small fixture"], "large.pdf"); Object.defineProperty(huge, "size", { value: MAX_UPLOAD_FILE_BYTES + 1 });
    const f = new FormData(); f.set("file", huge); expect(() => validateUploadForm(f)).toThrow(RequestInputError);
    const fields = new FormData(); for (let i = 0; i < 17; i++) fields.set(`k${i}`, "v");
    expect(() => validateUploadForm(fields)).toThrow(RequestInputError);
    const metadata = new FormData(); metadata.set("metadataJson", "中".repeat(22000));
    expect(() => validateUploadForm(metadata)).toThrow(RequestInputError);
    const two = new FormData(); two.set("file", new File(["a"], "a.pdf")); two.set("extra", new File(["b"], "b.pdf"));
    expect(() => validateUploadForm(two)).toThrow(RequestInputError);
  });
  it("keeps developer auth and origin checks ahead of handler execution", async () => {
    const handler = vi.fn(async () => NextResponse.json({ private: "OWNER-ONLY" }));
    const route = developerRoute(handler);
    expect((await route(jsonRequest({}))).status).toBe(401);
    expect((await route(jsonRequest({}, { authorization: "Bearer owner", origin: "https://other.invalid" }))).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect((await route(jsonRequest({ x: Array(1001).fill(1) }, { authorization: "Bearer owner" }))).status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
    expect((await route(jsonRequest({}, { authorization: "Bearer owner" }))).status).toBe(200);
  });
  it("keeps player sanitization while returning bounded-input failures clearly", async () => {
    const handler = vi.fn(async () => NextResponse.json({ status: "ok", agentRuns: ["PRIVATE-PROMPT"], input: "SECRET" }));
    const route = playerRoute(handler), context = { params: Promise.resolve({ gameId: "game" }) };
    expect((await route(jsonRequest({}), context)).status).toBe(401);
    expect((await route(jsonRequest(Array(1001).fill(0), { authorization: "Bearer player" }), context)).status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
    const response = await route(jsonRequest({}, { authorization: "Bearer player" }), context);
    expect(await response.json()).toEqual({ status: "ok" });
  });
  it("limits the unauthenticated developer-login body", async () => {
    const { POST } = await import("@/app/api/access/developer/route");
    expect((await POST(jsonRequest({ token: "x".repeat(5000) }))).status).toBe(413);
  });
  it("rejects excessive actIndices before invoking either parsing pipeline", async () => {
    const { POST } = await import("@/app/api/script-packages/[scriptPackageId]/dm-flow/parse-all/route");
    const { parseManualSemanticCandidate } = await import("@/src/lib/services/manualSemanticParseService");
    const r = await POST(jsonRequest({ scope: { actIndices: Array(65).fill(1) } }, { authorization: "Bearer owner" }),
      { params: Promise.resolve({ scriptPackageId: "fixture" }) });
    expect(r.status).toBe(400); expect(parseManualSemanticCandidate).not.toHaveBeenCalled();
  });
});

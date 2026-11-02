import "server-only";
import { NextResponse } from "next/server";
import { isDeveloperRequest, isGameRequest, safeMutation } from "./localCredentials";
import { playerResponse } from "./playerView";
import { boundedRequest, inputErrorResponse, RequestInputError } from "./requestLimits";

type Handler<A extends [Request, ...unknown[]]> = (...args: A) => Promise<Response>;
const deny = (status = 401) => NextResponse.json({ error: status === 403 ? "无权执行此操作。" : "需要有效访问凭证。" },
  { status, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
export function developerRoute<A extends [Request, ...any[]]>(handler: Handler<A>): Handler<A> {
  return async (...args) => {
    if (!args[0] || !isDeveloperRequest(args[0])) return deny();
    if (!safeMutation(args[0])) return deny(403);
    try {
      const path = new URL(args[0].url).pathname;
      args[0] = await boundedRequest(args[0], { allowMultipart: args[0].method === "POST" && /^\/api\/script-packages\/[^/]+\/assets\/?$/.test(path) }) as A[0];
      const response = await handler(...args);
      response.headers.set("Cache-Control", "private, no-store"); response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    } catch (error) {
      if (error instanceof RequestInputError) return inputErrorResponse(error);
      throw error;
    }
  };
}
export function playerRoute<A extends [Request, { params: Promise<{ gameId: string }> }]>(handler: Handler<A>): Handler<A> {
  return async (...args) => {
    const gameId = (await args[1].params).gameId;
    if (!args[0] || !isGameRequest(args[0], gameId)) return deny();
    if (!safeMutation(args[0])) return deny(403);
    try {
      args[0] = await boundedRequest(args[0]) as A[0];
      const response = await handler(...args);
      // The PDF endpoint enforces its own section/role scope; no JSON debug body.
      if (response.headers.get("content-type")?.includes("application/pdf")) {
        response.headers.set("Cache-Control", "private, no-store"); response.headers.set("Referrer-Policy", "no-referrer"); return response;
      }
      const body = await response.json();
      const safe = playerResponse(body, response.status);
      // Player-display metadata has no snapshot envelope; whitelist explicitly.
      if ("pdfUrl" in body && "pageStart" in body) Object.assign(safe, { status: body.status, roleId: body.roleId, roleName: body.roleName,
        actIndex: body.actIndex, actTitle: body.actTitle, originalName: body.originalName, pageStart: 1, pageEnd: body.pageEnd - body.pageStart + 1,
        pdfUrl: body.pdfUrl, rangeRestriction: "server_page_slice" });
      return NextResponse.json(safe, { status: response.status, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
    } catch (error) {
      if (error instanceof RequestInputError) return inputErrorResponse(error);
      return NextResponse.json({ error: "操作未完成，请稍后重试。" }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
    }
  };
}

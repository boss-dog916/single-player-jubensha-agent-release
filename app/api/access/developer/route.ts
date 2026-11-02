import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { cookieOptions, developerSecret, developerCookieName, issueCredential, safeMutation } from "@/src/lib/access/localCredentials";
import { boundedRequest, inputErrorResponse, RequestInputError } from "@/src/lib/access/requestLimits";
export async function POST(request: Request) {
  if (!safeMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403 });
  let token = "";
  try { const body = await (await boundedRequest(request, { jsonBytes: 4096 })).json(); if (typeof body.token === "string" && body.token.length <= 512) token = body.token; }
  catch (error) { if (error instanceof RequestInputError) return inputErrorResponse(error); }
  const a = Buffer.from(token), b = Buffer.from(developerSecret());
  if (a.length !== b.length || !timingSafeEqual(a, b)) return NextResponse.json({ error: "开发者凭证无效。" }, { status: 401 });
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(developerCookieName(), issueCredential("developer"), cookieOptions(request, 43_200));
  return response;
}
export async function DELETE(request: Request) {
  if (!safeMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403 });
  const response = NextResponse.json({ ok: true }); response.cookies.set(developerCookieName(), "", cookieOptions(request, 0)); return response;
}

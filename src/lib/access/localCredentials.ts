import "server-only";
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";

export const DEVELOPER_COOKIE = "jubensha_developer";
export const playerCookieName = (gameId: string) => `jubensha_player_${cookieNamespace()}_${gameId}`;
export const developerCookieName = () => `${DEVELOPER_COOKIE}_${cookieNamespace()}`;
const cookieNamespace = () => createHash("sha256").update(signingSecret()).digest("hex").slice(0, 12);
const validGameId = (s: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(s);
export function accessDirectory() {
  if (process.env.LOCAL_ACCESS_STATE_DIR) return resolve(process.env.LOCAL_ACCESS_STATE_DIR);
  if (process.env.LONG_NIGHT_PLAYTEST_DIR) return join(resolve(process.env.LONG_NIGHT_PLAYTEST_DIR), "access-control");
  if (process.env.NODE_ENV === "test" && process.env.DATABASE_URL?.startsWith("file:")) {
    const db = resolve(process.env.DATABASE_URL.slice(5));
    return join(dirname(db), `${basename(db)}.access-control`);
  }
  return resolve("storage/local-access");
}
function secret(name: string, envName: string) {
  const configured = process.env[envName];
  if (configured !== undefined) {
    if (configured.length < 32) throw new Error(`${envName} must contain at least 32 characters`);
    return configured;
  }
  const root = accessDirectory(); mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, name);
  try { writeFileSync(path, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const value = readFileSync(path, "utf8").trim();
  if (value.length < 32) throw new Error("Invalid local credential file; restore or rotate local credentials");
  return value;
}
export const developerSecret = () => secret("developer-token", "LOCAL_DEVELOPER_TOKEN");
const signingSecret = () => secret("signing-key", "LOCAL_ACCESS_SIGNING_KEY");
function equal(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
type Grant = { purpose: "developer" | "entry" | "player"; gameId?: string; exp: number; nonce: string };
export function issueCredential(purpose: Grant["purpose"], gameId?: string) {
  if (gameId !== undefined && !validGameId(gameId)) throw new Error("Invalid game ID");
  const ttl = purpose === "entry" ? 600 : purpose === "developer" ? 43_200 : 604_800;
  const payload = Buffer.from(JSON.stringify({ purpose, gameId, exp: Math.floor(Date.now() / 1000) + ttl,
    nonce: randomBytes(16).toString("base64url") })).toString("base64url");
  return `${payload}.${createHmac("sha256", signingSecret()).update(payload).digest("base64url")}`;
}
export function verifyCredential(token: string | undefined, purpose: Grant["purpose"], gameId?: string) {
  if (!token || token.length > 2048) return false;
  try {
    const [payload, mac, extra] = token.split(".");
    if (extra !== undefined || !mac || !equal(mac, createHmac("sha256", signingSecret()).update(payload).digest("base64url"))) return false;
    const grant = JSON.parse(Buffer.from(payload, "base64url").toString()) as Grant;
    return grant.purpose === purpose && grant.gameId === gameId && Number.isInteger(grant.exp) && grant.exp > Date.now() / 1000;
  } catch { return false; }
}
function cookie(header: string, name: string) {
  return header.split(";").map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
}
export function developerFromCookies(header: string) { return Boolean(header) && verifyCredential(cookie(header, developerCookieName()), "developer"); }
export function gameFromCookies(header: string, gameId: string) {
  return validGameId(gameId) && Boolean(header) && (developerFromCookies(header) || verifyCredential(cookie(header, playerCookieName(gameId)), "player", gameId));
}
export function isDeveloperRequest(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) return authorization.startsWith("Bearer ") && equal(authorization.slice(7), developerSecret());
  return developerFromCookies(request.headers.get("cookie") ?? "");
}
export function isGameRequest(request: Request, gameId: string) {
  if (!validGameId(gameId)) return false;
  const authorization = request.headers.get("authorization");
  if (authorization !== null) return isDeveloperRequest(request) || authorization.startsWith("Bearer ") && verifyCredential(authorization.slice(7), "player", gameId);
  return gameFromCookies(request.headers.get("cookie") ?? "", gameId);
}
export function safeMutation(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  // Next's local server can normalize request.url to localhost while the
  // browser uses 127.0.0.1. Host is the actual request authority; never trust
  // arbitrary forwarded-host headers to widen the accepted origin.
  try {
    const url = new URL(request.url), host = request.headers.get("host");
    const expected = host ? new URL(`${url.protocol}//${host}`).origin : url.origin;
    return origin === null || origin === expected;
  } catch { return false; }
}
export function cookieOptions(request: Request, maxAge: number) {
  return { httpOnly: true, sameSite: "strict" as const, secure: new URL(request.url).protocol === "https:", path: "/", maxAge };
}

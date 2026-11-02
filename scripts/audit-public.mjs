import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const git = (...args) => execFileSync("git", ["-c", "core.quotepath=false", ...args], { encoding: "utf8", maxBuffer: 100_000_000 });
const riskyPath = p => /(^|\/)(storage|artifacts|\.next[^/]*|node_modules)\/|(^|\/)\.env(?!\.example$)|\.(?:db(?:-.*)?|sqlite3?|pdf|docx|log|pem|key|zip)$|fixtures\/(?:longNight|manualActivity(?:LongNight|WildBodhisattva|Sources)|manualSourceSemanticGroundTruth|manualAssemblyResolutions)/i.test(p);
const secrets = existsSync(".env") ? [...readFileSync(".env", "utf8").matchAll(/^\s*([A-Z_]*(?:API_KEY|TOKEN|SIGNING_KEY))\s*=\s*["']?([^\r\n"']+)/gm)]
  .map(match => ({ name: match[1], value: match[2].trim() })).filter(secret => secret.value.length >= 20) : [];
const report = { trackedFiles: 0, riskyTrackedPaths: [], historicalRiskPaths: [], currentSecretMatches: [], historicalSecretMatches: [], suspectedKeyBlobs: [], historyScannedBlobs: 0, historyUnscannedBlobs: 0 };
try {
  const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
  report.trackedFiles = tracked.length; report.riskyTrackedPaths = tracked.filter(riskyPath);
  for (const path of tracked) if (existsSync(path)) {
    const bytes = readFileSync(path);
    for (const secret of secrets) if (bytes.includes(secret.value)) report.currentSecretMatches.push({ path, credentialName: secret.name });
  }
  report.historicalRiskPaths = [...new Set(git("log", "--all", "--name-only", "--format=").split("\n").filter(riskyPath))];
  const objects = git("rev-list", "--objects", "--all").split("\n").filter(Boolean).map(line => line.split(" ")[0]);
  const metadata = execFileSync("git", ["cat-file", "--batch-check"], { input: objects.join("\n") + "\n", encoding: "utf8", maxBuffer: 5_000_000 }).trim().split("\n").map(line => line.split(" "));
  const blobs = metadata.filter(([, type, size]) => type === "blob" && Number(size) <= 8_000_000);
  report.historyUnscannedBlobs = metadata.filter(([, type, size]) => type === "blob" && Number(size) > 8_000_000).length;
  const total = blobs.reduce((sum, [, , size]) => sum + Number(size) + 100, 0);
  if (total > 250_000_000) throw new Error("历史超过本轮250MB扫描范围，请单独进行凭证扫描");
  const batch = execFileSync("git", ["cat-file", "--batch"], { input: blobs.map(([id]) => id).join("\n") + "\n", maxBuffer: Math.max(total, 1_000_000) });
  let cursor = 0;
  while (cursor < batch.length) {
    const end = batch.indexOf(10, cursor); if (end < 0) break;
    const [id, , size] = batch.subarray(cursor, end).toString().split(" ");
    const bytes = batch.subarray(end + 1, end + 1 + Number(size)); cursor = end + Number(size) + 2;
    report.historyScannedBlobs++;
    for (const secret of secrets) if (bytes.includes(secret.value)) report.historicalSecretMatches.push({ blob: id, credentialName: secret.name });
    if (/sk-[A-Za-z0-9_-]{28,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(bytes.toString("utf8"))) report.suspectedKeyBlobs.push(id);
  }
  const output = process.argv[2];
  if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 }); }
  console.log(JSON.stringify(output ? Object.fromEntries(Object.entries(report).map(([key, value]) => [key, Array.isArray(value) ? value.length : value])) : report, null, 2));
  if (report.riskyTrackedPaths.length || report.historicalRiskPaths.length || report.currentSecretMatches.length || report.historicalSecretMatches.length || report.historyUnscannedBlobs) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }

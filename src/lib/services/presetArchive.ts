import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

// Small bounded ZIP adapter; installation still goes through the original
// preset manifest, checksums, Runtime validation and transaction importer.
const MAX_BYTES = 1024 * 1024 * 1024;
export function extractPresetZip(bytes: Buffer, destination: string) {
  if (bytes.length > MAX_BYTES) throw new Error("资源ZIP超过1GB限制");
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || end < bytes.length - 65557) throw new Error("无效的ZIP目录");
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16), total = 0;
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || count === 65535 || count > 10000 || cursor + centralSize > end) throw new Error("不支持分卷、ZIP64或超量文件ZIP");
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("ZIP目录损坏");
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const packed = bytes.readUInt32LE(cursor + 20), unpacked = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16, offset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8").replace(/\\/g, "/");
    cursor += 46 + nameLength + extra + comment;
    const parts = name.replace(/\/$/, "").split("/");
    if (!name || name.startsWith("/") || parts.some(part => !part || part === "." || part === ".." || /[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part)) ||
      (mode & 0xf000) === 0xa000 || flags & 1 || seen.has(name.toLowerCase())) throw new Error("ZIP含不安全路径、链接、重复文件或加密条目");
    seen.add(name.toLowerCase()); total += unpacked;
    if (total > MAX_BYTES || ![0, 8].includes(method) || offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error("ZIP资源过大或格式不支持");
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    if (start + packed > bytes.length) throw new Error("ZIP文件已截断");
    const target = resolve(destination, ...parts);
    if (!target.startsWith(resolve(destination) + sep)) throw new Error("ZIP路径越界");
    if (name.endsWith("/")) { mkdirSync(target, { recursive: true }); continue; }
    const compressed = bytes.subarray(start, start + packed);
    const data = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.min(unpacked + 1, MAX_BYTES) });
    if (data.length !== unpacked) throw new Error("ZIP解压长度不匹配");
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, data, { flag: "wx", mode: 0o600 });
  }
}

export async function withPresetSource<T>(source: string, operation: (directory: string) => Promise<T>) {
  const path = resolve(source);
  if (!existsSync(path)) throw new Error("资源包不存在，请提供本地ZIP或目录路径");
  let temporary: string | undefined;
  try {
    let root = path;
    if (!lstatSync(path).isDirectory()) {
      if (!path.toLowerCase().endsWith(".zip")) throw new Error("资源包应为ZIP或包含bundle.json的目录");
      temporary = mkdtempSync(join(tmpdir(), "jubensha-preset-")); root = temporary;
      extractPresetZip(readFileSync(path), root);
    }
    if (!existsSync(join(root, "bundle.json"))) {
      const children = readdirSync(root).filter(name => !name.startsWith(".") && name !== "__MACOSX");
      if (children.length !== 1 || !lstatSync(join(root, children[0])).isDirectory()) throw new Error("资源包缺少bundle.json（允许一层外包装目录）");
      root = join(root, children[0]);
    }
    const manifest = realpathSync(join(root, "bundle.json"));
    if (!manifest.startsWith(realpathSync(root) + sep)) throw new Error("资源包清单链接越界");
    return await operation(root);
  } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
}

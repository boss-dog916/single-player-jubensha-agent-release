import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { extractPresetZip, withPresetSource } from "./presetArchive";
const directories: string[] = [];
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "preset-archive-test-")); directories.push(root); return root; };
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Original synthetic ZIP, with central-directory sizes as used by Windows ZIP.
function zip(name: string, text = '{"format":"fixture"}', symlink = false) {
  const filename = Buffer.from(name), data = Buffer.from(text), packed = deflateRawSync(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
  if (symlink) central.writeUInt32LE((0xa000 << 16) >>> 0, 38);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + packed.length, 16);
  return Buffer.concat([local, filename, packed, central, filename, end]);
}
it.each(["bundle.json", "资源包/bundle.json"])("opens a standard ZIP with optional outer directory: %s", async name => {
  const root = temporary(), path = join(root, "package.zip"); writeFileSync(path, zip(name));
  let extracted = "";
  expect(await withPresetSource(path, async directory => { extracted = directory; return JSON.parse(readFileSync(join(directory, "bundle.json"), "utf8")).format; })).toBe("fixture");
  expect(existsSync(extracted)).toBe(false);
});
it("supports directories without deleting the supplied source", async () => {
  const root = temporary(); writeFileSync(join(root, "bundle.json"), "{}");
  expect(await withPresetSource(root, async directory => directory)).toBe(root);
  expect(existsSync(join(root, "bundle.json"))).toBe(true);
});
it.each(["../escape", "/absolute", "C:/escape", "folder/../../escape", "folder\\..\\escape"])("rejects unsafe ZIP paths %s", name => {
  expect(() => extractPresetZip(zip(name), temporary())).toThrow();
});
it("rejects symlinks and damaged ZIPs", () => {
  expect(() => extractPresetZip(zip("bundle.json", "{}", true), temporary())).toThrow();
  expect(() => extractPresetZip(Buffer.from("not a ZIP"), temporary())).toThrow();
});
it("reports missing bundles and cleans up failed ZIP installation", async () => {
  const root = temporary(); mkdirSync(join(root, "empty"));
  await expect(withPresetSource(join(root, "empty"), async () => {})).rejects.toThrow("缺少bundle.json");
  const path = join(root, "package.zip"); writeFileSync(path, zip("bundle.json"));
  let extracted = "";
  await expect(withPresetSource(path, async directory => { extracted = directory; throw new Error("invalid preset"); })).rejects.toThrow("invalid preset");
  expect(existsSync(extracted)).toBe(false);
});

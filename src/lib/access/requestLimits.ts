import { NextRequest, NextResponse } from "next/server";

export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_FILE_BYTES + MAX_JSON_BYTES;
export const MAX_ARRAY_ITEMS = 1000;

export class RequestInputError extends Error {
  constructor(message: string, readonly status = 413) { super(message); }
}
export function inputErrorResponse(error: RequestInputError) {
  return NextResponse.json({ error: error.message }, { status: error.status,
    headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
}

// Check collection sizes before Zod 3 starts accumulating per-element issues.
export function assertJsonLimits(value: unknown) {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 10000 || item.depth > 32) throw new RequestInputError("请求结构过大或嵌套过深。");
    if (item.value && typeof item.value === "object") {
      if (Array.isArray(item.value) && item.value.length > MAX_ARRAY_ITEMS)
        throw new RequestInputError("单个请求数组最多包含1000项。");
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
}

// Bound the actual stream, not only the optional/untrusted Content-Length.
// Rebuild a NextRequest so existing json/text/formData handlers stay unchanged.
export async function boundedRequest(request: Request, options: { allowMultipart?: boolean; jsonBytes?: number } = {}) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return request;
  const multipart = /^multipart\/form-data\b/i.test(request.headers.get("content-type") ?? "");
  if (multipart && !options.allowMultipart) throw new RequestInputError("此接口不接受文件上传。", 415);
  const limit = multipart ? MAX_UPLOAD_REQUEST_BYTES : options.jsonBytes ?? MAX_JSON_BYTES;
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
    throw new RequestInputError("请求长度无效。", 400);
  if (length !== null && Number(length) > limit) {
    void request.body?.cancel().catch(() => {});
    throw new RequestInputError("请求体超过允许大小。");
  }
  const reader = request.body?.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new RequestInputError("请求体超过允许大小。");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  if (!multipart && size) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      if (text.trim()) assertJsonLimits(JSON.parse(text));
    } catch (error) {
      if (error instanceof RequestInputError) throw error;
      throw new RequestInputError("请求必须为有效JSON。", 400);
    }
  }
  return new NextRequest(request.url, { method: request.method, headers: request.headers, body: size ? body : undefined });
}

export function validateUploadForm(form: FormData) {
  let fields = 0, files = 0;
  for (const value of form.values()) {
    if (++fields > 16) throw new RequestInputError("上传表单字段过多。");
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > 64 * 1024) throw new RequestInputError("上传元数据过大。");
    } else {
      if (++files > 1 || value.size > MAX_UPLOAD_FILE_BYTES) throw new RequestInputError("每次仅允许上传一个不超过100MiB的文件。");
    }
  }
}

import { open, stat } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function root() { return path.resolve(process.cwd(), "../.."); }
function safeName(value: string) { return value.replace(/[^a-zA-Z0-9_.-]/g, "_"); }
function contentType(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  return "video/mp4";
}

export async function GET(request: Request, context: { params: Promise<{ filename: string }> }): Promise<Response> {
  if (process.env.VV_MODE !== "local") return new Response("Not found", { status: 404 });
  const { filename: raw } = await context.params;
  const filename = safeName(decodeURIComponent(raw));
  const filePath = path.join(root(), "storage", "local", "videos", filename);
  let info;
  try { info = await stat(filePath); } catch { return new Response("Not found", { status: 404 }); }
  const range = request.headers.get("range");
  const headers = new Headers({ "Accept-Ranges": "bytes", "Content-Type": contentType(filename), "Cache-Control": "no-store" });
  if (!range) {
    const handle = await open(filePath, "r");
    const buffer = Buffer.alloc(info.size);
    await handle.read(buffer, 0, info.size, 0);
    await handle.close();
    headers.set("Content-Length", String(info.size));
    return new Response(buffer, { status: 200, headers });
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return new Response("Invalid range", { status: 416 });
  const start = match[1] ? Number(match[1]) : 0;
  const end = Math.min(match[2] ? Number(match[2]) : info.size - 1, info.size - 1);
  if (start < 0 || start > end || start >= info.size) return new Response("Range not satisfiable", { status: 416 });
  const length = end - start + 1;
  const handle = await open(filePath, "r");
  const buffer = Buffer.alloc(length);
  await handle.read(buffer, 0, length, start);
  await handle.close();
  headers.set("Content-Length", String(length));
  headers.set("Content-Range", `bytes ${start}-${end}/${info.size}`);
  return new Response(buffer, { status: 206, headers });
}

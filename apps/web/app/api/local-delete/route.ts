import { unlink } from "node:fs/promises";
import path from "node:path";
export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  if (process.env.VV_MODE !== "local") return Response.json({ error: "Local delete is disabled." }, { status: 404 });
  const body = await request.json();
  const url = String(body?.url || "");
  const filename = decodeURIComponent(url.split("/").pop() || "").replace(/[^a-zA-Z0-9_.-]/g, "_");
  if (!filename) return Response.json({ error: "Invalid local video URL." }, { status: 400 });
  const filePath = path.join(path.resolve(process.cwd(), "../.."), "storage", "local", "videos", filename);
  try { await unlink(filePath); } catch {}
  return Response.json({ ok: true });
}

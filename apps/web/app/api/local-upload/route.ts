import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function root() { return path.resolve(process.cwd(), "../.."); }
function safeName(value: string) { return value.replace(/[^a-zA-Z0-9_.-]/g, "_"); }

export async function POST(request: Request): Promise<Response> {
  if (process.env.VV_MODE !== "local") return Response.json({ error: "Local upload is disabled." }, { status: 404 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Video file is required." }, { status: 400 });
  const matchId = safeName(String(form.get("match_id") || Date.now()));
  const filename = `${matchId}-${safeName(file.name || "video.mov")}`;
  const dir = path.join(root(), "storage", "local", "videos");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), Buffer.from(await file.arrayBuffer()));
  const origin = new URL(request.url).origin;
  return Response.json({
    ok: true,
    filename,
    pathname: `storage/local/videos/${filename}`,
    url: `${origin}/api/local-video/${encodeURIComponent(filename)}`,
    size: file.size,
  });
}

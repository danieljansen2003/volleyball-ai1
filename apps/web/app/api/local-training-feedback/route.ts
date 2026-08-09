import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function dir() { return path.join(path.resolve(process.cwd(), "../.."), "storage", "local", "training-feedback"); }

export async function POST(request: Request): Promise<Response> {
  if (process.env.VV_MODE !== "local") return Response.json({ error: "Local feedback is disabled." }, { status: 404 });
  const body = await request.json();
  await mkdir(dir(), { recursive: true });
  const id = `${Date.now()}-${crypto.randomUUID().replace(/-/g, "")}`;
  const file = `${id}.json`;
  await writeFile(path.join(dir(), file), JSON.stringify(body, null, 2));
  return Response.json({ ok: true, file, count: (await readdir(dir())).filter((x) => x.endsWith(".json")).length });
}

export async function GET(): Promise<Response> {
  if (process.env.VV_MODE !== "local") return Response.json({ error: "Local feedback is disabled." }, { status: 404 });
  await mkdir(dir(), { recursive: true });
  const names = (await readdir(dir())).filter((x) => x.endsWith(".json")).sort().reverse();
  const recent = [];
  for (const name of names.slice(0, 100)) {
    try { recent.push(JSON.parse(await readFile(path.join(dir(), name), "utf8"))); } catch {}
  }
  return Response.json({ ok: true, count: names.length, records: recent });
}

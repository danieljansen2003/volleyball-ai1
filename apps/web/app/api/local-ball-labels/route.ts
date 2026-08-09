import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const root = () => path.resolve(process.cwd(), "../..");
const base = () => path.join(root(), "storage", "local", "ball-labels");

export async function POST(request: Request): Promise<Response> {
  if (process.env.VV_MODE !== "local") return Response.json({ error: "Local ball labels are disabled." }, { status: 404 });
  const form = await request.formData();
  const image = form.get("image");
  if (!(image instanceof File)) return Response.json({ error: "Frame image is required." }, { status: 400 });
  const sampleId = String(form.get("sample_id") || Date.now()).replace(/[^a-zA-Z0-9_.-]/g, "_");
  const x = Number(form.get("x")); const y = Number(form.get("y"));
  const w = Number(form.get("width")); const h = Number(form.get("height"));
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return Response.json({ error: "Invalid ball box." }, { status: 400 });
  const images = path.join(base(), "images"); const labels = path.join(base(), "labels"); const meta = path.join(base(), "meta");
  await Promise.all([mkdir(images,{recursive:true}), mkdir(labels,{recursive:true}), mkdir(meta,{recursive:true})]);
  await writeFile(path.join(images, `${sampleId}.jpg`), Buffer.from(await image.arrayBuffer()));
  const cx = Math.max(0, Math.min(1, x + w / 2)); const cy = Math.max(0, Math.min(1, y + h / 2));
  await writeFile(path.join(labels, `${sampleId}.txt`), `0 ${cx.toFixed(8)} ${cy.toFixed(8)} ${w.toFixed(8)} ${h.toFixed(8)}\n`);
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) if (key !== "image") metadata[key] = String(value);
  await writeFile(path.join(meta, `${sampleId}.json`), JSON.stringify(metadata, null, 2));
  const count = (await readdir(labels)).filter((n) => n.endsWith(".txt")).length;
  return Response.json({ ok: true, sample_id: sampleId, count });
}

export async function GET(): Promise<Response> {
  if (process.env.VV_MODE !== "local") return Response.json({ error: "Local ball labels are disabled." }, { status: 404 });
  const labels = path.join(base(), "labels"); const meta = path.join(base(), "meta");
  await Promise.all([mkdir(labels,{recursive:true}), mkdir(meta,{recursive:true})]);
  const names = (await readdir(labels)).filter((n) => n.endsWith(".txt")).sort();
  const samples = [];
  for (const name of names.slice(-100)) {
    const id = name.slice(0, -4);
    try { samples.push({ sample_id: id, ...(JSON.parse(await readFile(path.join(meta, `${id}.json`), "utf8"))) }); }
    catch { samples.push({ sample_id: id }); }
  }
  return Response.json({ ok: true, count: names.length, samples });
}

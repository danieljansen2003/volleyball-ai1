import { list, put } from "@vercel/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const matchId = String(body?.match_id ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
    const touchId = String(body?.touch_id ?? Date.now()).replace(/[^a-zA-Z0-9_-]/g, "_");
    const pathname = `training-feedback/${matchId}/${Date.now()}-${touchId}.json`;
    const blob = await put(pathname, JSON.stringify(body, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: true,
    });
    return Response.json({ ok: true, url: blob.url, pathname: blob.pathname });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not save training feedback." },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<Response> {
  try {
    const result = await list({ prefix: "training-feedback/", limit: 1000 });
    return Response.json({
      ok: true,
      count: result.blobs.length,
      blobs: result.blobs.map((blob) => ({
        url: blob.url,
        pathname: blob.pathname,
        size: blob.size,
        uploadedAt: blob.uploadedAt,
      })),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not list training feedback." },
      { status: 500 },
    );
  }
}

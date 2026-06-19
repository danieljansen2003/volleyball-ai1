import { del } from "@vercel/blob";

export async function POST(request: Request): Promise<Response> {
  try {
    const { url } = (await request.json()) as { url?: string };
    if (!url) return Response.json({ error: "Missing blob URL" }, { status: 400 });
    await del(url);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Delete failed" },
      { status: 400 },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const aiWorkerUrl = process.env.AI_WORKER_URL;

  if (!aiWorkerUrl) {
    return Response.json(
      {
        error:
          "AI_WORKER_URL is not configured. Deploy apps/ai-worker and add AI_WORKER_URL to Vercel environment variables.",
      },
      { status: 501 },
    );
  }

  const body = await request.json();

  try {
    const response = await fetch(`${aiWorkerUrl.replace(/\/$/, "")}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));
    return Response.json(data, { status: response.status });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Could not reach AI worker",
      },
      { status: 502 },
    );
  }
}

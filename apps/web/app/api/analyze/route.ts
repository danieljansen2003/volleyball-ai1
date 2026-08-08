export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

function workerBaseUrl(): string | null {
  const value = process.env.AI_WORKER_URL;
  return value ? value.replace(/\/$/, "") : null;
}

async function proxyJson(url: string, init?: RequestInit): Promise<Response> {
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(init?.headers || {}),
      },
    });

    const text = await response.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        return Response.json(
          { error: "AI worker returned invalid JSON.", preview: text.slice(0, 500) },
          { status: 502 },
        );
      }
    }

    if (!response.ok) {
      const detail =
        typeof data === "object" && data !== null && "detail" in data
          ? String((data as { detail?: unknown }).detail)
          : `AI worker failed with HTTP ${response.status}.`;
      return Response.json({ error: detail, worker_response: data }, { status: response.status });
    }

    return Response.json(data, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not reach AI worker." },
      { status: 502 },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const base = workerBaseUrl();
  if (!base) {
    return Response.json({ error: "AI_WORKER_URL is not configured." }, { status: 501 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON request." }, { status: 400 });
  }

  return proxyJson(`${base}/jobs/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function GET(request: Request): Promise<Response> {
  const base = workerBaseUrl();
  if (!base) {
    return Response.json({ error: "AI_WORKER_URL is not configured." }, { status: 501 });
  }

  const jobId = new URL(request.url).searchParams.get("job_id");
  if (!jobId || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    return Response.json({ error: "A valid job_id is required." }, { status: 400 });
  }

  return proxyJson(`${base}/jobs/${encodeURIComponent(jobId)}`);
}

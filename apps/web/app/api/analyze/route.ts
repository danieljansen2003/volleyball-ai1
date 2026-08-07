export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const configuredUrl = process.env.AI_WORKER_URL;

  if (!configuredUrl) {
    return Response.json(
      {
        error:
          "AI_WORKER_URL is not configured in the Vercel environment variables.",
      },
      { status: 501 },
    );
  }

  const aiWorkerUrl = configuredUrl.replace(/\/$/, "");

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      {
        error: "The frontend sent invalid JSON to /api/analyze.",
      },
      { status: 400 },
    );
  }

  console.log("[analyze-proxy] Sending request to:", aiWorkerUrl);

  const controller = new AbortController();

  // Don't allow the request to hang forever.
  const timeout = setTimeout(() => {
    controller.abort();
  }, 55_000);

  try {
    const startedAt = Date.now();

    const workerResponse = await fetch(`${aiWorkerUrl}/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });

    const elapsedMs = Date.now() - startedAt;

    console.log(
      `[analyze-proxy] Worker responded in ${elapsedMs}ms with status ${workerResponse.status}`,
    );

    const rawText = await workerResponse.text();

    if (!rawText) {
      return Response.json(
        {
          error: "AI worker returned an empty response.",
          worker_status: workerResponse.status,
        },
        { status: 502 },
      );
    }

    let data: unknown;

    try {
      data = JSON.parse(rawText);
    } catch {
      console.error(
        "[analyze-proxy] Worker returned non-JSON:",
        rawText.slice(0, 1000),
      );

      return Response.json(
        {
          error: "AI worker returned a response that was not valid JSON.",
          worker_status: workerResponse.status,
          preview: rawText.slice(0, 500),
        },
        { status: 502 },
      );
    }

    if (!workerResponse.ok) {
      console.error(
        "[analyze-proxy] Worker error:",
        workerResponse.status,
        data,
      );

      return Response.json(
        {
          error:
            typeof data === "object" &&
            data !== null &&
            "detail" in data
              ? String((data as { detail?: unknown }).detail)
              : `AI worker failed with status ${workerResponse.status}.`,
          worker_status: workerResponse.status,
          worker_response: data,
        },
        { status: workerResponse.status },
      );
    }

    console.log("[analyze-proxy] Returning AI result to browser.");

    return Response.json(data, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error("[analyze-proxy] AI request timed out.");

      return Response.json(
        {
          error:
            "AI worker took longer than 55 seconds. The worker may still be processing the video.",
        },
        { status: 504 },
      );
    }

    console.error("[analyze-proxy] Could not reach AI worker:", error);

    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not reach AI worker.",
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
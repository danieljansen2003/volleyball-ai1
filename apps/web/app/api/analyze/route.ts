import { list, put } from "@vercel/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const JOB_PREFIX = "ai-jobs/";
const RESULT_PREFIX = "ai-job-results/";
const MAX_QUEUE_SCAN = 200;

function workerToken(): string | null {
  return process.env.LOCAL_AI_WORKER_TOKEN?.trim() || null;
}

function authorized(request: Request): boolean {
  const expected = workerToken();
  if (!expected) return false;
  const value = request.headers.get("authorization") || "";
  return value === `Bearer ${expected}`;
}

function safeJobId(value: string | null): string | null {
  if (!value || !/^[a-zA-Z0-9_-]+$/.test(value)) return null;
  return value;
}

function jobPath(jobId: string): string {
  return `${JOB_PREFIX}${jobId}.json`;
}

type StoredJob = {
  job_id: string;
  status: "queued" | "processing" | "complete" | "failed";
  progress: number;
  message: string;
  model_version: string;
  created_at: number;
  updated_at: number;
  error: string | null;
  payload: unknown;
  result_chunk_count?: number;
  result_url?: string | null;
  worker?: string | null;
};

async function readBlobJson<T>(url: string): Promise<T> {
  // Overwritten Blob URLs can be cached at the CDN. Add a cache-buster so
  // status reads always see the newest small job document.
  const separator = url.includes("?") ? "&" : "?";
  const response = await fetch(`${url}${separator}vv=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not read blob (${response.status}).`);
  return (await response.json()) as T;
}

async function findJobBlob(jobId: string) {
  const pathname = jobPath(jobId);
  const result = await list({ prefix: pathname, limit: 10 });
  return result.blobs.find((blob) => blob.pathname === pathname) || null;
}

async function loadJob(jobId: string): Promise<StoredJob | null> {
  const blob = await findJobBlob(jobId);
  if (!blob) return null;
  return readBlobJson<StoredJob>(blob.url);
}

async function saveJob(job: StoredJob): Promise<void> {
  await put(jobPath(job.job_id), JSON.stringify(job), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

async function publicJob(job: StoredJob) {
  let result: unknown = null;
  if (job.status === "complete" && job.result_url) {
    result = await readBlobJson<unknown>(job.result_url);
  } else if (job.status === "complete" && (job.result_chunk_count || 0) > 0) {
    // Backward compatibility with jobs created by the earlier chunked worker.
    const prefix = `${RESULT_PREFIX}${job.job_id}/`;
    const chunks = await list({ prefix, limit: 1000 });
    const ordered = chunks.blobs
      .filter((blob) => blob.pathname.endsWith(".txt"))
      .sort((a, b) => a.pathname.localeCompare(b.pathname));
    const parts = await Promise.all(
      ordered.map(async (blob) => {
        const response = await fetch(blob.url, { cache: "no-store" });
        if (!response.ok) throw new Error("Could not read AI result chunk.");
        return response.text();
      }),
    );
    result = JSON.parse(parts.join(""));
  }

  return {
    job_id: job.job_id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    model_version: job.model_version,
    created_at: job.created_at,
    updated_at: job.updated_at,
    error: job.error,
    result,
  };
}

async function oldestQueuedJob(): Promise<StoredJob | null> {
  const blobs = await list({ prefix: JOB_PREFIX, limit: MAX_QUEUE_SCAN });
  const candidates: StoredJob[] = [];
  for (const blob of blobs.blobs) {
    if (!blob.pathname.endsWith(".json")) continue;
    try {
      const job = await readBlobJson<StoredJob>(blob.url);
      if (job.status === "queued") candidates.push(job);
    } catch {
      // Skip malformed/stale queue entries.
    }
  }
  candidates.sort((a, b) => a.created_at - b.created_at);
  return candidates[0] || null;
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON request." }, { status: 400 });
  }

  const payload = body as { court_points?: unknown[] };
  if (!Array.isArray(payload?.court_points) || payload.court_points.length !== 4) {
    return Response.json(
      { error: "Select and confirm exactly four court corners before analysis." },
      { status: 400 },
    );
  }

  const now = Date.now() / 1000;
  const jobId = `${Date.now()}-${crypto.randomUUID().replace(/-/g, "")}`;
  const job: StoredJob = {
    job_id: jobId,
    status: "queued",
    progress: 0,
    message: "Queued for your local Mac AI worker",
    model_version: "local-mac-worker-v1",
    created_at: now,
    updated_at: now,
    error: null,
    payload: body,
    worker: null,
  };

  await saveJob(job);
  return Response.json(await publicJob(job), { status: 202 });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const isWorker = url.searchParams.get("worker") === "1";

  if (isWorker) {
    if (!authorized(request)) {
      return Response.json({ error: "Unauthorized local worker." }, { status: 401 });
    }
    const job = await oldestQueuedJob();
    return Response.json({ ok: true, job });
  }

  const jobId = safeJobId(url.searchParams.get("job_id"));
  if (!jobId) return Response.json({ error: "A valid job_id is required." }, { status: 400 });
  const job = await loadJob(jobId);
  if (!job) return Response.json({ error: "Analysis job not found." }, { status: 404 });
  return Response.json(await publicJob(job), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function PATCH(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ error: "Unauthorized local worker." }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON request." }, { status: 400 });
  }

  const jobId = safeJobId(String(body?.job_id || ""));
  if (!jobId) return Response.json({ error: "A valid job_id is required." }, { status: 400 });
  const job = await loadJob(jobId);
  if (!job) return Response.json({ error: "Analysis job not found." }, { status: 404 });

  const now = Date.now() / 1000;
  const action = String(body?.action || "");

  if (action === "claim") {
    if (job.status !== "queued") {
      return Response.json({ error: `Job is already ${job.status}.` }, { status: 409 });
    }
    job.status = "processing";
    job.progress = 1;
    job.message = "Local Mac worker claimed job";
    job.worker = String(body?.worker || "local-mac");
  } else if (action === "progress") {
    job.status = "processing";
    job.progress = Math.max(0, Math.min(99, Number(body?.progress || 0)));
    job.message = String(body?.message || "Processing locally");
  } else if (action === "complete_result") {
    // Low-traffic local-worker path: upload the entire compact result once.
    // A typical short VolleyVision result is well below Vercel's request limit.
    const result = body?.result;
    if (!result || typeof result !== "object") {
      return Response.json({ error: "A result object is required." }, { status: 400 });
    }
    const serialized = JSON.stringify(result);
    if (serialized.length > 3_500_000) {
      return Response.json(
        { error: "AI result is too large for single-request upload." },
        { status: 413 },
      );
    }
    const resultBlob = await put(`${RESULT_PREFIX}${jobId}.json`, serialized, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    job.result_url = resultBlob.url;
    job.status = "complete";
    job.progress = 100;
    job.message = String(body?.message || "Local AI analysis complete");
    job.model_version = String(body?.model_version || job.model_version);
    job.error = null;
  } else if (action === "result_chunk") {
    const index = Number(body?.index);
    const total = Number(body?.total);
    const data = String(body?.data || "");
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(total) || total <= 0 || !data) {
      return Response.json({ error: "Invalid result chunk." }, { status: 400 });
    }
    const name = `${RESULT_PREFIX}${jobId}/chunk-${String(index).padStart(6, "0")}.txt`;
    await put(name, data, {
      access: "public",
      contentType: "text/plain",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    job.result_chunk_count = total;
    job.message = `Uploading AI result ${index + 1}/${total}`;
    job.progress = Math.max(job.progress, 99);
  } else if (action === "complete") {
    job.status = "complete";
    job.progress = 100;
    job.message = String(body?.message || "Local AI analysis complete");
    job.model_version = String(body?.model_version || job.model_version);
    job.error = null;
  } else if (action === "failed") {
    job.status = "failed";
    job.progress = 100;
    job.message = "Local AI analysis failed";
    job.error = String(body?.error || "Unknown local worker error");
  } else {
    return Response.json({ error: "Unknown worker action." }, { status: 400 });
  }

  job.updated_at = now;
  await saveJob(job);
  return Response.json({ ok: true, job: await publicJob(job) });
}

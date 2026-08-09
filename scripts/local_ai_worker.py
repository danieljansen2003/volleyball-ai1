#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import platform
import socket
import sys
import time
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
AI_WORKER_ROOT = PROJECT_ROOT / "apps" / "ai-worker"
if str(AI_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(AI_WORKER_ROOT))

load_dotenv(PROJECT_ROOT / ".env.local-worker")

from app.main import MODEL_VERSION, _run_analysis  # noqa: E402
from app.schemas import AnalyzeRequest  # noqa: E402
from app.action_learner import ActionLearner  # noqa: E402


def normalize_url(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    if not value.startswith(("http://", "https://")):
        value = "https://" + value
    return value.rstrip("/")


def auth_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def next_job(base: str, token: str) -> dict[str, Any] | None:
    response = requests.get(
        f"{base}/api/analyze",
        params={"worker": "1"},
        headers=auth_headers(token),
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    job = data.get("job")
    return job if isinstance(job, dict) else None


def patch(
    base: str,
    token: str,
    payload: dict[str, Any],
    timeout: int | float = 30,
) -> dict[str, Any]:
    response = requests.patch(
        f"{base}/api/analyze",
        headers=auth_headers(token),
        json=payload,
        timeout=timeout,
    )
    if not response.ok:
        body = response.text[:1000]
        raise requests.HTTPError(
            f"{response.status_code} Server Error for url: {response.url}; body={body}",
            response=response,
        )
    return response.json()


# Vercel Blob is used as a durable queue, not as a live telemetry bus.
# Keep network writes extremely low: claim once and upload the final result once.
def process_job(base: str, token: str, job: dict[str, Any], worker_name: str) -> None:
    job_id = str(job["job_id"])
    payload = job.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("Queued job is missing its analysis payload.")

    patch(base, token, {"action": "claim", "job_id": job_id, "worker": worker_name})
    req = AnalyzeRequest.model_validate(payload)
    last_printed = {"percent": -1}

    def progress(percent: int, message: str) -> None:
        if percent == last_printed["percent"]:
            return
        last_printed["percent"] = percent
        print(f"[local-worker] {percent:3d}% {message}", flush=True)

    print(f"[local-worker] Processing job {job_id}", flush=True)
    result = _run_analysis(req, progress_hook=progress)
    learner = ActionLearner()
    result = learner.apply(result)
    learned = result.get("action_learning", {})
    print(
        f"[local-worker] Action learner: {learned.get('reviewed_examples', 0)} reviewed examples, "
        f"{learned.get('labels_overridden', 0)} labels overridden",
        flush=True,
    )
    serialized_size = len(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
    print(
        f"[local-worker] Uploading final result once ({serialized_size / 1024:.1f} KB)...",
        flush=True,
    )
    patch(
        base,
        token,
        {
            "action": "complete_result",
            "job_id": job_id,
            "message": result.get("message", "Local AI analysis complete"),
            "model_version": result.get("model_version", MODEL_VERSION),
            "result": result,
        },
        timeout=120,
    )
    print(f"[local-worker] Job {job_id} complete.\n", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run VolleyVision AI jobs on this Mac instead of Render."
    )
    parser.add_argument("--url", default=os.getenv("VOLLEYVISION_URL", ""))
    parser.add_argument("--token", default=os.getenv("LOCAL_AI_WORKER_TOKEN", ""))
    parser.add_argument(
        "--poll",
        type=float,
        default=float(os.getenv("LOCAL_AI_POLL_SECONDS", "3")),
    )
    args = parser.parse_args()

    base = normalize_url(args.url)
    token = args.token.strip()
    if not base:
        raise SystemExit("Set VOLLEYVISION_URL in .env.local-worker or pass --url.")
    if not token:
        raise SystemExit("Set LOCAL_AI_WORKER_TOKEN in .env.local-worker or pass --token.")

    worker_name = f"{socket.gethostname()}-{platform.machine()}"
    print("VolleyVision local AI worker", flush=True)
    print(f"Web app: {base}", flush=True)
    print(f"Worker:  {worker_name}", flush=True)
    print(
        "AI runs locally. When pointed at localhost, videos/jobs/labels stay on this Mac. Press Ctrl+C to stop.\n",
        flush=True,
    )

    while True:
        try:
            job = next_job(base, token)
            if not job:
                time.sleep(max(1.0, args.poll))
                continue
            try:
                process_job(base, token, job, worker_name)
            except Exception as exc:
                job_id = str(job.get("job_id", ""))
                print(
                    f"[local-worker] Job failed: {type(exc).__name__}: {exc}",
                    flush=True,
                )
                if job_id:
                    try:
                        patch(
                            base,
                            token,
                            {
                                "action": "failed",
                                "job_id": job_id,
                                "error": f"{type(exc).__name__}: {exc}",
                            },
                        )
                    except Exception as patch_exc:
                        print(
                            f"[local-worker] Could not report failure: {patch_exc}",
                            flush=True,
                        )
        except KeyboardInterrupt:
            print("\nVolleyVision local worker stopped.", flush=True)
            return
        except Exception as exc:
            print(
                f"[local-worker] Queue check failed: {type(exc).__name__}: {exc}",
                flush=True,
            )
            time.sleep(max(3.0, args.poll))


if __name__ == "__main__":
    main()

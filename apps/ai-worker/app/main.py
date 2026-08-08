from __future__ import annotations

import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.pipeline.rally_detector import _download_video
from app.player_tracker import PlayerTracker
from app.schemas import AnalyzeRequest, AnalyzeResponse, CourtPoint

MODEL_VERSION = "court-player-tracker-jobs-v0.2"
JOB_TTL_SECONDS = 6 * 60 * 60

app = FastAPI(title="VolleyVision AI Worker", version="0.3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

player_tracker = PlayerTracker()
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="volleyvision-analysis")
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()


class TrackRequest(BaseModel):
    video_path: str
    court_points: Optional[list[CourtPoint]] = None


def _now() -> float:
    return time.time()


def _cleanup_jobs() -> None:
    cutoff = _now() - JOB_TTL_SECONDS
    with _jobs_lock:
        expired = [
            job_id
            for job_id, job in _jobs.items()
            if job.get("updated_at", 0) < cutoff
            and job.get("status") in {"complete", "failed"}
        ]
        for job_id in expired:
            _jobs.pop(job_id, None)


def _set_job(job_id: str, **changes: Any) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job.update(changes)
        job["updated_at"] = _now()


def _job_public(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "progress": job.get("progress", 0),
        "message": job.get("message", ""),
        "model_version": MODEL_VERSION,
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
        "error": job.get("error"),
        "result": job.get("result") if job["status"] == "complete" else None,
    }


def _validate_request(req: AnalyzeRequest) -> None:
    if not req.court_points or len(req.court_points) != 4:
        raise HTTPException(
            status_code=400,
            detail="Select and confirm exactly four court corners before analysis.",
        )


def _run_analysis(req: AnalyzeRequest, progress_hook=None) -> dict[str, Any]:
    _validate_request(req)
    max_mb = int(os.getenv("MAX_VIDEO_DOWNLOAD_MB", "2048"))

    if progress_hook:
        progress_hook(3, "Downloading video")

    video_path = _download_video(req.video_url, max_mb=max_mb)
    if not video_path:
        raise RuntimeError(
            "The AI worker could not download the video. Check Render logs for [video-download]."
        )

    try:
        court_points = [point.model_dump() for point in req.court_points or []]

        def tracker_progress(current: int, total: int, message: str) -> None:
            if not progress_hook:
                return
            ratio = current / max(1, total)
            progress_hook(min(94, 8 + int(ratio * 86)), message)

        tracking = player_tracker.track(
            video_path,
            court_points=court_points,
            progress_callback=tracker_progress,
        )

        if progress_hook:
            progress_hook(97, "Finalizing tracking result")

        message = (
            "Court-filtered player tracking complete. "
            f"{tracking['unique_track_count']} persistent track IDs, "
            f"{tracking['detections_kept']} accepted detections, and "
            f"{tracking['detections_removed_outside_court']} off-court detections removed. "
            "Automatic serve/pass/set/attack labels are not generated yet because a trained "
            "ball/action model is not present."
        )

        return {
            "status": "complete",
            "message": message,
            "rallies": [],
            "model_version": MODEL_VERSION,
            "tracking": tracking,
        }
    finally:
        try:
            os.remove(video_path)
        except OSError:
            pass


def _process_job(job_id: str, payload: dict[str, Any]) -> None:
    try:
        req = AnalyzeRequest.model_validate(payload)
        _set_job(job_id, status="processing", progress=1, message="Starting AI worker")

        def progress(percent: int, message: str) -> None:
            _set_job(
                job_id,
                status="processing",
                progress=max(0, min(99, percent)),
                message=message,
            )

        result = _run_analysis(req, progress_hook=progress)
        _set_job(
            job_id,
            status="complete",
            progress=100,
            message=result["message"],
            result=result,
        )
    except Exception as exc:
        print(f"[analysis-job] {job_id} failed: {type(exc).__name__}: {exc}", flush=True)
        _set_job(
            job_id,
            status="failed",
            progress=100,
            message="AI analysis failed",
            error=f"{type(exc).__name__}: {exc}",
        )


@app.get("/health")
def health():
    _cleanup_jobs()
    return {
        "ok": True,
        "service": "volleyvision-ai-worker",
        "model_version": MODEL_VERSION,
        "tracking_device": player_tracker.device,
        "queued_jobs": sum(
            1 for job in _jobs.values() if job.get("status") in {"queued", "processing"}
        ),
    }


@app.post("/track")
def track_players(req: TrackRequest):
    path = Path(req.video_path).expanduser().resolve()
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Video not found: {path}")
    court_points = [point.model_dump() for point in req.court_points] if req.court_points else None
    try:
        return player_tracker.track(str(path), court_points=court_points)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Player tracking failed: {exc}") from exc


@app.post("/jobs/analyze", status_code=202)
def create_analysis_job(req: AnalyzeRequest):
    _cleanup_jobs()
    _validate_request(req)
    job_id = uuid.uuid4().hex
    now = _now()
    job = {
        "job_id": job_id,
        "status": "queued",
        "progress": 0,
        "message": "Queued for analysis",
        "created_at": now,
        "updated_at": now,
        "error": None,
        "result": None,
    }
    with _jobs_lock:
        _jobs[job_id] = job
    _executor.submit(_process_job, job_id, req.model_dump(mode="json"))
    return _job_public(job)


@app.get("/jobs/{job_id}")
def get_analysis_job(job_id: str):
    _cleanup_jobs()
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Analysis job not found or expired.")
        snapshot = dict(job)
    return _job_public(snapshot)


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest):
    """Synchronous compatibility endpoint. The web app should use /jobs/analyze."""
    try:
        return AnalyzeResponse.model_validate(_run_analysis(req))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

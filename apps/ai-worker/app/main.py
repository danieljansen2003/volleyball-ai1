import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.pipeline.rally_detector import _download_video
from app.player_tracker import PlayerTracker
from app.schemas import (
    AnalyzeRequest,
    AnalyzeResponse,
    CourtPoint,
)


MODEL_VERSION = "court-player-tracker-v0.1"


app = FastAPI(
    title="VolleyVision AI Worker",
    version="0.2.0",
)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


player_tracker = PlayerTracker()


class TrackRequest(BaseModel):
    video_path: str
    court_points: Optional[list[CourtPoint]] = None


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "volleyvision-ai-worker",
        "model_version": MODEL_VERSION,
        "tracking_device": player_tracker.device,
    }


@app.post("/track")
def track_players(req: TrackRequest):
    try:
        path = (
            Path(req.video_path)
            .expanduser()
            .resolve()
        )

        if not path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"Video not found: {path}",
            )

        court_points = (
            [
                point.model_dump()
                for point in req.court_points
            ]
            if req.court_points
            else None
        )

        return player_tracker.track(
            str(path),
            court_points=court_points,
        )

    except HTTPException:
        raise

    except Exception as exc:
        print(
            "[track-endpoint] "
            f"{type(exc).__name__}: {exc}",
            flush=True,
        )

        raise HTTPException(
            status_code=500,
            detail=f"Player tracking failed: {exc}",
        ) from exc


@app.post(
    "/analyze",
    response_model=AnalyzeResponse,
)
def analyze(req: AnalyzeRequest):
    """
    Real analysis stage 1:

    1. Download the actual uploaded match video.
    2. Read the user's selected court polygon.
    3. Run YOLO person detection + ByteTrack.
    4. Remove detections whose feet are outside the court.
    5. Remove extremely short tracks.
    6. Return real tracking data.

    Volleyball action recognition is intentionally NOT generated yet.
    """

    if not req.court_points:
        raise HTTPException(
            status_code=400,
            detail=(
                "Court calibration is required. "
                "Select and confirm the four court corners "
                "before running AI analysis."
            ),
        )

    if len(req.court_points) != 4:
        raise HTTPException(
            status_code=400,
            detail=(
                "Exactly four court points are required."
            ),
        )

    max_mb = int(
        os.getenv(
            "MAX_VIDEO_DOWNLOAD_MB",
            "2048",
        )
    )

    print(
        "[analyze] Starting real player tracking "
        f"for match_id={req.match_id}",
        flush=True,
    )

    video_path = _download_video(
        req.video_url,
        max_mb=max_mb,
    )

    if not video_path:
        raise HTTPException(
            status_code=502,
            detail=(
                "The AI worker could not download the video. "
                "Check Render logs for the "
                "[video-download] error."
            ),
        )

    try:
        court_points = [
            point.model_dump()
            for point in req.court_points
        ]

        tracking = player_tracker.track(
            video_path,
            court_points=court_points,
        )

        message = (
            "Real court-filtered player tracking completed. "
            f"Detected {tracking['unique_track_count']} "
            "persistent track IDs. "
            f"Removed "
            f"{tracking['detections_removed_outside_court']} "
            "person detections outside the selected court. "
            "Serve/pass/set/attack recognition is intentionally "
            "disabled until the ball and action models are trained."
        )

        print(
            "[analyze] Complete: "
            f"tracks={tracking['unique_track_count']} "
            f"kept={tracking['detections_kept']} "
            f"outside_removed="
            f"{tracking['detections_removed_outside_court']}",
            flush=True,
        )

        return AnalyzeResponse(
            status="complete",
            message=message,

            # Important:
            # Stop generating fake rallies at this stage.
            rallies=[],

            model_version=MODEL_VERSION,
            tracking=tracking,
        )

    except HTTPException:
        raise

    except Exception as exc:
        print(
            "[analyze] Tracking failed with "
            f"{type(exc).__name__}: {exc}",
            flush=True,
        )

        raise HTTPException(
            status_code=500,
            detail=(
                "Court-filtered player tracking failed: "
                f"{exc}"
            ),
        ) from exc

    finally:
        try:
            os.remove(video_path)

            print(
                "[analyze] Temporary video deleted.",
                flush=True,
            )

        except OSError as exc:
            print(
                "[analyze] Could not delete "
                f"temporary video: {exc}",
                flush=True,
            )
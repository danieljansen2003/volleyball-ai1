from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.pipeline.rally_detector import MODEL_VERSION, build_rallies
from app.player_tracker import PlayerTracker
from app.schemas import AnalyzeRequest, AnalyzeResponse

app = FastAPI(title="VolleyVision AI Worker", version="0.1.0")

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


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "volleyvision-ai-worker",
        "model_version": MODEL_VERSION,
    }


@app.post("/track")
def track_players(req: TrackRequest):
    try:
        path = Path(req.video_path).expanduser().resolve()

        if not path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"Video not found: {path}",
            )

        return player_tracker.track(str(path))

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Player tracking failed: {exc}",
        ) from exc


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest):
    rallies, message = build_rallies(
        match_id=req.match_id,
        video_url=req.video_url,
        duration_seconds=req.duration_seconds,
        first_serve_seconds=req.first_serve_seconds,
    )

    return AnalyzeResponse(
        status="complete",
        message=message,
        rallies=rallies,
        model_version=MODEL_VERSION,
    )
from typing import Any, List, Optional

from pydantic import BaseModel, Field


class CourtPoint(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class AnalyzeRequest(BaseModel):
    match_id: int
    title: str = "Match"
    opponent: str = "Opponent"
    video_url: str
    duration_seconds: float = 0
    first_serve_seconds: Optional[float] = None
    court_points: Optional[List[CourtPoint]] = None
    court_frame_time: Optional[float] = None


class Touch(BaseModel):
    id: int
    rally_id: int
    start_time: float
    end_time: float
    action: str
    player: str = "Needs review"
    outcome: str = "needs review"
    notes: str = "AI worker estimate; confirm manually."
    confidence: float = Field(ge=0, le=1)
    source: str = "manual"
    reviewed: bool = False
    track_id: Optional[int] = None
    ball_frame: Optional[int] = None
    features: Optional[dict[str, float]] = None


class Rally(BaseModel):
    id: int
    match_id: int
    start_time: float
    end_time: float
    phase: str
    result: str
    confidence: float = Field(ge=0, le=1)
    touches: List[Touch]


class AnalyzeResponse(BaseModel):
    status: str
    message: str
    rallies: List[Rally]
    model_version: str
    tracking: Optional[dict[str, Any]] = None
    action_diagnostics: Optional[dict[str, Any]] = None
    action_diagnostics: Optional[dict[str, Any]] = None

from pydantic import BaseModel, Field
from typing import List, Optional


class AnalyzeRequest(BaseModel):
    match_id: int
    title: str = "Match"
    opponent: str = "Opponent"
    video_url: str
    duration_seconds: float = 0
    first_serve_seconds: Optional[float] = None


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

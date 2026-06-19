from pydantic import BaseModel
from datetime import datetime

class EventCreate(BaseModel):
    start_time: float
    end_time: float
    label: str
    player: str = ""
    outcome: str = ""
    notes: str = ""
    confidence: float = 1.0

class EventOut(EventCreate):
    id: int
    match_id: int
    class Config:
        from_attributes = True

class MatchOut(BaseModel):
    id: int
    title: str
    opponent: str
    status: str
    duration_seconds: float
    created_at: datetime
    events: list[EventOut] = []
    class Config:
        from_attributes = True

class ClipRequest(BaseModel):
    event_ids: list[int]
    output_name: str = "highlight.mp4"

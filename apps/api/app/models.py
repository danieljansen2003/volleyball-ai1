from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from datetime import datetime
from .database import Base

class Match(Base):
    __tablename__ = "matches"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True)
    opponent = Column(String, default="")
    video_path = Column(String)
    status = Column(String, default="uploaded")
    duration_seconds = Column(Float, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    events = relationship("Event", back_populates="match", cascade="all, delete-orphan")

class Event(Base):
    __tablename__ = "events"
    id = Column(Integer, primary_key=True, index=True)
    match_id = Column(Integer, ForeignKey("matches.id"))
    start_time = Column(Float)
    end_time = Column(Float)
    label = Column(String)
    player = Column(String, default="")
    outcome = Column(String, default="")
    notes = Column(Text, default="")
    confidence = Column(Float, default=0.0)
    match = relationship("Match", back_populates="events")

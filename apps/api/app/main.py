import os
import shutil
from fastapi import FastAPI, UploadFile, File, Form, Depends, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from .database import Base, engine, get_db, SessionLocal
from .models import Match, Event
from .schemas import MatchOut, EventCreate, EventOut, ClipRequest
from .ai_pipeline import process_match
from .video_tools import make_highlight_clip

Base.metadata.create_all(bind=engine)

app = FastAPI(title="VolleyVision AI API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = "storage/uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

def run_processing(match_id: int):
    db = SessionLocal()
    try:
        process_match(db, match_id)
    finally:
        db.close()

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/matches", response_model=MatchOut)
def upload_match(
    background_tasks: BackgroundTasks,
    title: str = Form(...),
    opponent: str = Form(""),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    filename = file.filename or "upload.mp4"
    safe_name = filename.replace("/", "_").replace("..", "_")
    path = os.path.join(UPLOAD_DIR, safe_name)
    with open(path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    match = Match(title=title, opponent=opponent, video_path=path, status="uploaded")
    db.add(match)
    db.commit()
    db.refresh(match)
    background_tasks.add_task(run_processing, match.id)
    return match

@app.get("/matches", response_model=list[MatchOut])
def list_matches(db: Session = Depends(get_db)):
    return db.query(Match).order_by(Match.created_at.desc()).all()


@app.delete("/matches/{match_id}")
def delete_match(match_id: int, db: Session = Depends(get_db)):
    match = db.query(Match).filter(Match.id == match_id).first()
    if not match:
        raise HTTPException(404, "Match not found")
    video_path = match.video_path
    db.delete(match)
    db.commit()
    if video_path and os.path.exists(video_path):
        try:
            os.remove(video_path)
        except OSError:
            pass
    return {"deleted": True}

@app.get("/matches/{match_id}", response_model=MatchOut)
def get_match(match_id: int, db: Session = Depends(get_db)):
    match = db.query(Match).filter(Match.id == match_id).first()
    if not match:
        raise HTTPException(404, "Match not found")
    return match

@app.get("/matches/{match_id}/video")
def get_video(match_id: int, db: Session = Depends(get_db)):
    match = db.query(Match).filter(Match.id == match_id).first()
    if not match:
        raise HTTPException(404, "Match not found")
    return FileResponse(match.video_path, media_type="video/mp4")

@app.post("/matches/{match_id}/events", response_model=EventOut)
def create_event(match_id: int, payload: EventCreate, db: Session = Depends(get_db)):
    match = db.query(Match).filter(Match.id == match_id).first()
    if not match:
        raise HTTPException(404, "Match not found")
    event = Event(match_id=match_id, **payload.model_dump())
    db.add(event)
    db.commit()
    db.refresh(event)
    return event

@app.delete("/events/{event_id}")
def delete_event(event_id: int, db: Session = Depends(get_db)):
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        raise HTTPException(404, "Event not found")
    db.delete(event)
    db.commit()
    return {"deleted": True}

@app.post("/clips")
def create_clip(payload: ClipRequest, db: Session = Depends(get_db)):
    try:
        path = make_highlight_clip(db, payload.event_ids, payload.output_name)
    except Exception as exc:
        raise HTTPException(400, str(exc))
    return {"clip_url": f"/clips/{os.path.basename(path)}"}

@app.get("/clips/{filename}")
def download_clip(filename: str):
    path = os.path.join("storage/clips", filename)
    if not os.path.exists(path):
        raise HTTPException(404, "Clip not found")
    return FileResponse(path, media_type="video/mp4", filename=filename)

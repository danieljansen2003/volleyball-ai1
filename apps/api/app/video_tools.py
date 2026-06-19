import os
import subprocess
import uuid
from sqlalchemy.orm import Session
from .models import Event

CLIP_DIR = "storage/clips"


def _run_ffmpeg(args: list[str]):
    subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def make_highlight_clip(db: Session, event_ids: list[int], output_name: str) -> str:
    os.makedirs(CLIP_DIR, exist_ok=True)
    events = db.query(Event).filter(Event.id.in_(event_ids)).order_by(Event.start_time).all()
    if not events:
        raise ValueError("No events found. Wait for processing to finish or add manual tags first.")

    job_id = uuid.uuid4().hex[:8]
    temp_files = []
    for idx, event in enumerate(events):
        source = event.match.video_path
        out = os.path.join(CLIP_DIR, f"temp_{job_id}_{idx}.mp4")
        duration = max(0.5, event.end_time - event.start_time)
        # Re-encode each segment so concat works reliably across browsers/codecs.
        _run_ffmpeg([
            "ffmpeg", "-y", "-ss", str(max(0, event.start_time)), "-i", source,
            "-t", str(duration),
            "-vf", "scale=1280:-2,fps=30,format=yuv420p",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out
        ])
        temp_files.append(out)

    concat_file = os.path.join(CLIP_DIR, f"concat_{job_id}.txt")
    with open(concat_file, "w", encoding="utf-8") as f:
        for path in temp_files:
            f.write(f"file '{os.path.abspath(path).replace(chr(92), '/')}'\n")

    safe_name = output_name.replace("/", "_").replace("..", "_")
    if not safe_name.lower().endswith(".mp4"):
        safe_name += ".mp4"
    final_path = os.path.join(CLIP_DIR, safe_name)
    _run_ffmpeg([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_file,
        "-c", "copy", "-movflags", "+faststart", final_path
    ])

    for path in temp_files + [concat_file]:
        try:
            os.remove(path)
        except OSError:
            pass
    return final_path

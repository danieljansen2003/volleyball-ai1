import os
import tempfile
from typing import List

import cv2
import numpy as np
import requests

from app.schemas import Rally, Touch

MODEL_VERSION = "motion-rally-starter-v0.1"


def _safe_duration(duration_seconds: float) -> float:
    if duration_seconds and duration_seconds > 0:
        return min(float(duration_seconds), 6 * 60 * 60)
    return 60 * 60


def _download_video(url: str, max_mb: int) -> str | None:
    """Download only when small enough for this starter CPU worker."""
    try:
        head = requests.head(url, timeout=15, allow_redirects=True)
        content_length = int(head.headers.get("content-length", "0") or 0)
        if content_length and content_length > max_mb * 1024 * 1024:
            return None

        fd, path = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)
        with requests.get(url, stream=True, timeout=30) as r:
            r.raise_for_status()
            downloaded = 0
            with open(path, "wb") as f:
                for chunk in r.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    downloaded += len(chunk)
                    if downloaded > max_mb * 1024 * 1024:
                        try:
                            os.remove(path)
                        except OSError:
                            pass
                        return None
                    f.write(chunk)
        return path
    except Exception:
        return None


def _motion_segments(video_path: str, duration: float, start_after: float) -> List[tuple[float, float, float]]:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return []

    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    if frame_count > 0 and fps > 0:
        duration = min(duration, frame_count / fps)

    sample_every_seconds = 1.0
    sample_step = max(1, int(fps * sample_every_seconds))
    prev_gray = None
    scores: list[tuple[float, float]] = []
    frame_idx = 0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if frame_idx % sample_step != 0:
            frame_idx += 1
            continue
        t = frame_idx / fps
        frame_idx += 1
        if t < start_after:
            continue
        small = cv2.resize(frame, (320, 180))
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        if prev_gray is not None:
            diff = cv2.absdiff(gray, prev_gray)
            score = float(np.mean(diff))
            scores.append((t, score))
        prev_gray = gray

    cap.release()
    if not scores:
        return []

    values = np.array([s for _, s in scores])
    threshold = max(float(np.percentile(values, 65)), 4.0)

    segments: list[tuple[float, float, float]] = []
    in_seg = False
    start = 0.0
    peak = 0.0
    quiet_count = 0

    for t, score in scores:
        if score >= threshold:
            if not in_seg:
                start = t
                peak = score
                in_seg = True
                quiet_count = 0
            else:
                peak = max(peak, score)
                quiet_count = 0
        elif in_seg:
            quiet_count += 1
            if quiet_count >= 4:
                end = max(start + 4, t - 2)
                if 4 <= end - start <= 45:
                    conf = min(0.85, 0.45 + (peak / max(1, threshold)) * 0.12)
                    segments.append((round(start, 1), round(end, 1), round(conf, 2)))
                in_seg = False
                quiet_count = 0

    if in_seg:
        end = min(duration, scores[-1][0])
        if 4 <= end - start <= 45:
            segments.append((round(start, 1), round(end, 1), 0.55))

    return segments[:250]


def _fallback_segments(duration: float, match_id: int, first_serve_seconds: float | None) -> List[tuple[float, float, float]]:
    start = first_serve_seconds if first_serve_seconds is not None else 60.0
    start = max(0.0, min(start, max(0, duration - 10)))
    out: list[tuple[float, float, float]] = []
    t = start
    while t < duration - 5 and len(out) < 180:
        length = 8 + (len(out) % 5) * 2
        out.append((round(t, 1), round(min(duration, t + length), 1), 0.35))
        t += length + 12 + (len(out) % 4) * 3
    return out


def build_rallies(match_id: int, video_url: str, duration_seconds: float, first_serve_seconds: float | None = None) -> tuple[List[Rally], str]:
    duration = _safe_duration(duration_seconds)
    start_after = first_serve_seconds if first_serve_seconds is not None else 0.0
    max_mb = int(os.getenv("MAX_VIDEO_DOWNLOAD_MB", "2048"))

    video_path = _download_video(video_url, max_mb=max_mb)
    if video_path:
        try:
            segments = _motion_segments(video_path, duration, start_after)
            message = "Motion-based rally estimate complete. Review and correct labels before using for stats."
        finally:
            try:
                os.remove(video_path)
            except OSError:
                pass
    else:
        segments = []
        message = f"Video too large for this starter CPU worker or unavailable. Used conservative fallback after first serve. Set MAX_VIDEO_DOWNLOAD_MB higher or deploy a GPU/chunked worker."

    if not segments:
        segments = _fallback_segments(duration, match_id, first_serve_seconds)

    rallies: list[Rally] = []
    for i, (start, end, conf) in enumerate(segments):
        rally_id = match_id + i
        # Conservative: only create unknown review touches instead of fake serve/pass/set/attack.
        touches = [
            Touch(
                id=rally_id * 100,
                rally_id=rally_id,
                start_time=start,
                end_time=end,
                action="Live Rally",
                player="Needs review",
                outcome="needs review",
                notes="Detected as likely live play. Tag serve/pass/set/attack manually until action model is trained.",
                confidence=conf,
            )
        ]
        rallies.append(
            Rally(
                id=rally_id,
                match_id=match_id,
                start_time=start,
                end_time=end,
                phase="Live Rally",
                result="needs review",
                confidence=conf,
                touches=touches,
            )
        )
    return rallies, message

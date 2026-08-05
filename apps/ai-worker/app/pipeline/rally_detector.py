import os
import tempfile
from pathlib import Path
from typing import List

import cv2
import numpy as np
import requests

from app.schemas import Rally, Touch


MODEL_VERSION = "motion-rally-starter-v0.2"


def _safe_duration(duration_seconds: float) -> float:
    """Return a reasonable, bounded video duration."""
    if duration_seconds and duration_seconds > 0:
        return min(float(duration_seconds), 6 * 60 * 60)

    return 60 * 60


def _download_video(url: str, max_mb: int) -> str | None:
    """
    Download a remote video to a temporary file.

    This version logs the real failure instead of silently treating every
    download problem as a file-size problem.
    """
    max_bytes = max_mb * 1024 * 1024
    temporary_path: str | None = None

    try:
        if not url.startswith(("http://", "https://")):
            print(
                f"[video-download] Invalid remote video URL: {url!r}",
                flush=True,
            )
            return None

        headers = {
            "User-Agent": "VolleyVision-AI-Worker/0.2",
            "Accept": "video/*,application/octet-stream,*/*",
        }

        print(
            f"[video-download] Starting download from {url}",
            flush=True,
        )

        with requests.get(
            url,
            headers=headers,
            stream=True,
            allow_redirects=True,
            timeout=(20, 180),
        ) as response:
            response.raise_for_status()

            content_length_header = response.headers.get("content-length")
            content_length = 0

            if content_length_header:
                try:
                    content_length = int(content_length_header)
                except ValueError:
                    content_length = 0

            content_type = response.headers.get(
                "content-type",
                "unknown",
            )

            print(
                "[video-download] "
                f"status={response.status_code} "
                f"type={content_type} "
                f"content_length={content_length} "
                f"final_url={response.url}",
                flush=True,
            )

            if content_length and content_length > max_bytes:
                print(
                    "[video-download] File rejected because it is "
                    f"{content_length / 1024 / 1024:.1f} MB, "
                    f"above the configured {max_mb} MB limit.",
                    flush=True,
                )
                return None

            final_url_without_query = response.url.split("?", 1)[0].lower()

            if final_url_without_query.endswith(".mov"):
                suffix = ".mov"
            elif final_url_without_query.endswith(".webm"):
                suffix = ".webm"
            elif final_url_without_query.endswith(".m4v"):
                suffix = ".m4v"
            else:
                suffix = ".mp4"

            file_descriptor, temporary_path = tempfile.mkstemp(
                suffix=suffix,
            )
            os.close(file_descriptor)

            downloaded_bytes = 0

            with open(temporary_path, "wb") as output_file:
                for chunk in response.iter_content(
                    chunk_size=1024 * 1024,
                ):
                    if not chunk:
                        continue

                    downloaded_bytes += len(chunk)

                    if downloaded_bytes > max_bytes:
                        raise ValueError(
                            "The video download exceeded the configured "
                            f"{max_mb} MB limit."
                        )

                    output_file.write(chunk)

        if downloaded_bytes == 0:
            raise RuntimeError(
                "The video request succeeded but returned no file data."
            )

        if not Path(temporary_path).exists():
            raise RuntimeError(
                "The temporary video file was not created."
            )

        print(
            "[video-download] Saved "
            f"{downloaded_bytes / 1024 / 1024:.1f} MB "
            f"to {temporary_path}",
            flush=True,
        )

        return temporary_path

    except requests.Timeout as exc:
        print(
            f"[video-download] Download timed out: {exc}",
            flush=True,
        )

    except requests.HTTPError as exc:
        status_code = (
            exc.response.status_code
            if exc.response is not None
            else "unknown"
        )

        response_body = ""

        if exc.response is not None:
            try:
                response_body = exc.response.text[:300]
            except Exception:
                response_body = ""

        print(
            "[video-download] "
            f"HTTP error {status_code}: {response_body}",
            flush=True,
        )

    except requests.RequestException as exc:
        print(
            f"[video-download] Request error: {exc}",
            flush=True,
        )

    except Exception as exc:
        print(
            "[video-download] Unexpected error "
            f"{type(exc).__name__}: {exc}",
            flush=True,
        )

    if temporary_path:
        try:
            os.remove(temporary_path)
        except OSError:
            pass

    return None


def _motion_segments(
    video_path: str,
    duration: float,
    start_after: float,
) -> List[tuple[float, float, float]]:
    """
    Estimate active video segments using frame-to-frame image motion.

    This is only a starter rally estimator. It does not recognize volleyball
    actions such as serves, passes, sets, attacks, blocks, or digs.
    """
    capture = cv2.VideoCapture(video_path)

    if not capture.isOpened():
        print(
            f"[motion-analysis] OpenCV could not open {video_path}",
            flush=True,
        )
        return []

    fps = float(capture.get(cv2.CAP_PROP_FPS) or 30.0)
    frame_count = float(
        capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    )

    if frame_count > 0 and fps > 0:
        decoded_duration = frame_count / fps
        duration = min(duration, decoded_duration)

    print(
        "[motion-analysis] "
        f"fps={fps:.3f} "
        f"frames={int(frame_count)} "
        f"duration={duration:.3f} "
        f"start_after={start_after:.3f}",
        flush=True,
    )

    sample_every_seconds = 0.5
    sample_step = max(1, int(fps * sample_every_seconds))

    previous_gray: np.ndarray | None = None
    motion_scores: list[tuple[float, float]] = []
    frame_index = 0

    while True:
        frame_read, frame = capture.read()

        if not frame_read:
            break

        current_frame_index = frame_index
        frame_index += 1

        if current_frame_index % sample_step != 0:
            continue

        timestamp = current_frame_index / fps

        if timestamp < start_after:
            continue

        small_frame = cv2.resize(frame, (320, 180))
        gray_frame = cv2.cvtColor(
            small_frame,
            cv2.COLOR_BGR2GRAY,
        )
        gray_frame = cv2.GaussianBlur(
            gray_frame,
            (5, 5),
            0,
        )

        if previous_gray is not None:
            frame_difference = cv2.absdiff(
                gray_frame,
                previous_gray,
            )
            motion_score = float(np.mean(frame_difference))
            motion_scores.append((timestamp, motion_score))

        previous_gray = gray_frame

    capture.release()

    if not motion_scores:
        print(
            "[motion-analysis] No usable frame-motion scores were produced.",
            flush=True,
        )
        return []

    motion_values = np.array(
        [score for _, score in motion_scores],
        dtype=np.float32,
    )

    percentile_threshold = float(
        np.percentile(motion_values, 65)
    )
    threshold = max(percentile_threshold, 4.0)

    print(
        "[motion-analysis] "
        f"samples={len(motion_scores)} "
        f"threshold={threshold:.3f} "
        f"minimum={float(np.min(motion_values)):.3f} "
        f"maximum={float(np.max(motion_values)):.3f}",
        flush=True,
    )

    segments: list[tuple[float, float, float]] = []

    in_segment = False
    segment_start = 0.0
    segment_peak = 0.0
    quiet_count = 0

    for timestamp, motion_score in motion_scores:
        if motion_score >= threshold:
            if not in_segment:
                segment_start = timestamp
                segment_peak = motion_score
                in_segment = True
                quiet_count = 0
            else:
                segment_peak = max(
                    segment_peak,
                    motion_score,
                )
                quiet_count = 0

        elif in_segment:
            quiet_count += 1

            # Four quiet samples at 0.5 seconds each means approximately
            # two seconds of lower motion.
            if quiet_count >= 4:
                segment_end = max(
                    segment_start + 2.0,
                    timestamp - 1.0,
                )

                segment_length = segment_end - segment_start

                if 1.0 <= segment_length <= 45.0:
                    confidence = min(
                        0.85,
                        0.45
                        + (
                            segment_peak
                            / max(1.0, threshold)
                        )
                        * 0.12,
                    )

                    segments.append(
                        (
                            round(segment_start, 1),
                            round(segment_end, 1),
                            round(confidence, 2),
                        )
                    )

                in_segment = False
                quiet_count = 0

    if in_segment:
        segment_end = min(
            duration,
            motion_scores[-1][0],
        )
        segment_length = segment_end - segment_start

        if 1.0 <= segment_length <= 45.0:
            segments.append(
                (
                    round(segment_start, 1),
                    round(segment_end, 1),
                    0.55,
                )
            )

    print(
        f"[motion-analysis] Detected {len(segments)} active segments.",
        flush=True,
    )

    return segments[:250]


def _fallback_segments(
    duration: float,
    match_id: int,
    first_serve_seconds: float | None,
) -> List[tuple[float, float, float]]:
    """
    Produce conservative review segments only when video analysis fails.

    These segments are not claimed to be real volleyball actions.
    """
    del match_id

    start = (
        first_serve_seconds
        if first_serve_seconds is not None
        else 0.0
    )

    start = max(
        0.0,
        min(start, max(0.0, duration - 1.0)),
    )

    output: list[tuple[float, float, float]] = []

    # For very short clips, return one review segment instead of returning
    # nothing or inventing a long sequence of rallies.
    if duration <= 15:
        if duration > start:
            output.append(
                (
                    round(start, 1),
                    round(duration, 1),
                    0.2,
                )
            )

        return output

    timestamp = start

    while timestamp < duration - 2 and len(output) < 180:
        length = min(
            8 + (len(output) % 5) * 2,
            duration - timestamp,
        )

        if length < 2:
            break

        output.append(
            (
                round(timestamp, 1),
                round(timestamp + length, 1),
                0.2,
            )
        )

        timestamp += length + 12 + (len(output) % 4) * 3

    return output


def build_rallies(
    match_id: int,
    video_url: str,
    duration_seconds: float,
    first_serve_seconds: float | None = None,
) -> tuple[List[Rally], str]:
    """
    Download the match video and estimate likely live-motion segments.

    This function deliberately creates only generic "Live Rally" review
    entries. It does not invent serve, pass, set, attack, block, or dig labels.
    """
    duration = _safe_duration(duration_seconds)

    start_after = (
        float(first_serve_seconds)
        if first_serve_seconds is not None
        else 0.0
    )

    start_after = max(
        0.0,
        min(start_after, duration),
    )

    max_mb = int(
        os.getenv("MAX_VIDEO_DOWNLOAD_MB", "2048")
    )

    print(
        "[rally-builder] "
        f"match_id={match_id} "
        f"duration={duration:.3f} "
        f"first_serve={start_after:.3f} "
        f"max_download_mb={max_mb}",
        flush=True,
    )

    video_path = _download_video(
        video_url,
        max_mb=max_mb,
    )

    segments: list[tuple[float, float, float]] = []

    if video_path:
        try:
            segments = _motion_segments(
                video_path,
                duration,
                start_after,
            )

            if segments:
                message = (
                    "Motion-based active-play estimate completed. "
                    "The returned segments require review and are not yet "
                    "volleyball action classifications."
                )
            else:
                message = (
                    "The video downloaded successfully, but the starter "
                    "motion detector found no reliable active-play segments. "
                    "A low-confidence review segment was returned."
                )

        except Exception as exc:
            print(
                "[rally-builder] Motion analysis failed with "
                f"{type(exc).__name__}: {exc}",
                flush=True,
            )

            message = (
                "The video downloaded, but motion analysis failed. "
                "A low-confidence review segment was returned. "
                "Check the Render logs for the specific error."
            )

        finally:
            try:
                os.remove(video_path)
                print(
                    f"[rally-builder] Removed temporary file {video_path}",
                    flush=True,
                )
            except OSError as exc:
                print(
                    "[rally-builder] Could not remove temporary file: "
                    f"{exc}",
                    flush=True,
                )

    else:
        message = (
            "The AI worker could not download the video. "
            "A low-confidence review segment was returned. "
            "Check the Render logs for a [video-download] error."
        )

    if not segments:
        segments = _fallback_segments(
            duration,
            match_id,
            first_serve_seconds,
        )

    rallies: list[Rally] = []

    for index, (
        segment_start,
        segment_end,
        confidence,
    ) in enumerate(segments):
        rally_id = match_id + index

        touches = [
            Touch(
                id=rally_id * 100,
                rally_id=rally_id,
                start_time=segment_start,
                end_time=segment_end,
                action="Live Rally",
                player="Needs review",
                outcome="needs review",
                notes=(
                    "Detected as a possible active-play segment using "
                    "frame motion only. This is not yet a trained "
                    "serve/pass/set/attack classification."
                ),
                confidence=confidence,
            )
        ]

        rallies.append(
            Rally(
                id=rally_id,
                match_id=match_id,
                start_time=segment_start,
                end_time=segment_end,
                phase="Possible live play",
                result="needs review",
                confidence=confidence,
                touches=touches,
            )
        )

    print(
        f"[rally-builder] Returning {len(rallies)} rallies.",
        flush=True,
    )

    return rallies, message
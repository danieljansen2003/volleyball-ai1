from pathlib import Path
from typing import Any

import cv2
import torch
from ultralytics import YOLO


class PlayerTracker:
    def __init__(self) -> None:
        worker_root = Path(__file__).resolve().parent.parent
        model_path = worker_root / "yolo11n.pt"

        if not model_path.exists():
            raise FileNotFoundError(f"YOLO model not found: {model_path}")

        self.model = YOLO(str(model_path))

        self.device = (
            "mps"
            if torch.backends.mps.is_available()
            else "cpu"
        )

    def track(self, video_path: str) -> dict[str, Any]:
        path = Path(video_path).expanduser().resolve()

        if not path.exists():
            raise FileNotFoundError(f"Video not found: {path}")

        capture = cv2.VideoCapture(str(path))

        if not capture.isOpened():
            raise RuntimeError(f"Could not open video: {path}")

        fps = float(capture.get(cv2.CAP_PROP_FPS) or 30.0)
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        reported_frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        capture.release()

        results = self.model.track(
            source=str(path),
            tracker="bytetrack.yaml",
            classes=[0],
            persist=True,
            device=self.device,
            stream=True,
            verbose=False,
            conf=0.40,
            iou=0.50,
        )

        raw_frames: list[dict[str, Any]] = []
        track_frame_counts: dict[int, int] = {}

        for frame_index, result in enumerate(results):
            players: list[dict[str, Any]] = []

            if result.boxes is not None and result.boxes.id is not None:
                boxes = result.boxes.xyxy.cpu().tolist()
                track_ids = result.boxes.id.int().cpu().tolist()
                confidences = result.boxes.conf.cpu().tolist()

                for box, track_id, confidence in zip(
                    boxes,
                    track_ids,
                    confidences,
                    strict=True,
                ):
                    track_frame_counts[track_id] = (
                        track_frame_counts.get(track_id, 0) + 1
                    )

                    players.append(
                        {
                            "track_id": track_id,
                            "confidence": round(float(confidence), 4),
                            "box": {
                                "x1": round(float(box[0]), 2),
                                "y1": round(float(box[1]), 2),
                                "x2": round(float(box[2]), 2),
                                "y2": round(float(box[3]), 2),
                            },
                        }
                    )

            raw_frames.append(
                {
                    "frame": frame_index,
                    "timestamp_seconds": round(frame_index / fps, 3),
                    "players": players,
                }
            )

        minimum_track_frames = max(5, int(fps * 0.25))

        valid_track_ids = {
            track_id
            for track_id, count in track_frame_counts.items()
            if count >= minimum_track_frames
        }

        frames: list[dict[str, Any]] = []
        unique_track_ids: set[int] = set()

        for frame in raw_frames:
            filtered_players = [
                player
                for player in frame["players"]
                if player["track_id"] in valid_track_ids
            ]

            unique_track_ids.update(
                player["track_id"] for player in filtered_players
            )

            frames.append(
                {
                    "frame": frame["frame"],
                    "timestamp_seconds": frame["timestamp_seconds"],
                    "players": filtered_players,
                }
            )

        processed_frame_count = len(frames)
        duration_seconds = (
            processed_frame_count / fps
            if fps > 0
            else 0.0
        )

        return {
            "status": "complete",
            "device": self.device,
            "video_path": str(path),
            "fps": round(fps, 3),
            "width": width,
            "height": height,
            "reported_frame_count": reported_frame_count,
            "frame_count": processed_frame_count,
            "duration_seconds": round(duration_seconds, 3),
            "minimum_track_frames": minimum_track_frames,
            "unique_track_count": len(unique_track_ids),
            "frames": frames,
        }
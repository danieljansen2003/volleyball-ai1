from pathlib import Path
from typing import Any

import cv2
import numpy as np
import torch
from ultralytics import YOLO


class PlayerTracker:
    def __init__(self) -> None:
        worker_root = Path(__file__).resolve().parent.parent
        model_path = worker_root / "yolo11n.pt"

        if not model_path.exists():
            raise FileNotFoundError(
                f"YOLO model not found: {model_path}"
            )

        self.model = YOLO(str(model_path))

        self.device = (
            "mps"
            if torch.backends.mps.is_available()
            else "cpu"
        )

        print(
            f"[player-tracker] Loaded YOLO on device={self.device}",
            flush=True,
        )

    def _build_court_polygon(
        self,
        court_points: list[dict[str, float]] | None,
        width: int,
        height: int,
    ) -> np.ndarray | None:
        if not court_points:
            return None

        if len(court_points) != 4:
            raise ValueError(
                "Exactly four court points are required."
            )

        pixel_points: list[list[int]] = []

        for point in court_points:
            normalized_x = float(point["x"])
            normalized_y = float(point["y"])

            if not 0 <= normalized_x <= 1:
                raise ValueError(
                    f"Court x coordinate must be 0-1: {normalized_x}"
                )

            if not 0 <= normalized_y <= 1:
                raise ValueError(
                    f"Court y coordinate must be 0-1: {normalized_y}"
                )

            pixel_x = int(round(normalized_x * width))
            pixel_y = int(round(normalized_y * height))

            pixel_points.append(
                [pixel_x, pixel_y]
            )

        return np.array(
            pixel_points,
            dtype=np.int32,
        )

    def _inside_court(
        self,
        foot_x: float,
        foot_y: float,
        court_polygon: np.ndarray | None,
    ) -> bool:
        if court_polygon is None:
            return True

        result = cv2.pointPolygonTest(
            court_polygon,
            (float(foot_x), float(foot_y)),
            False,
        )

        return result >= 0

    def track(
        self,
        video_path: str,
        court_points: list[dict[str, float]] | None = None,
    ) -> dict[str, Any]:
        path = Path(video_path).expanduser().resolve()

        if not path.exists():
            raise FileNotFoundError(
                f"Video not found: {path}"
            )

        capture = cv2.VideoCapture(str(path))

        if not capture.isOpened():
            raise RuntimeError(
                f"Could not open video: {path}"
            )

        fps = float(
            capture.get(cv2.CAP_PROP_FPS) or 30.0
        )

        width = int(
            capture.get(cv2.CAP_PROP_FRAME_WIDTH)
        )

        height = int(
            capture.get(cv2.CAP_PROP_FRAME_HEIGHT)
        )

        reported_frame_count = int(
            capture.get(cv2.CAP_PROP_FRAME_COUNT)
        )

        capture.release()

        court_polygon = self._build_court_polygon(
            court_points,
            width,
            height,
        )

        print(
            "[player-tracker] "
            f"video={path.name} "
            f"size={width}x{height} "
            f"fps={fps:.3f} "
            f"frames={reported_frame_count}",
            flush=True,
        )

        if court_polygon is not None:
            print(
                "[player-tracker] Court polygon pixels: "
                f"{court_polygon.tolist()}",
                flush=True,
            )
        else:
            print(
                "[player-tracker] No court polygon supplied. "
                "All person detections will be considered.",
                flush=True,
            )

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

        detections_total = 0
        detections_inside_court = 0
        detections_outside_court = 0

        for frame_index, result in enumerate(results):
            players: list[dict[str, Any]] = []

            if (
                result.boxes is not None
                and result.boxes.id is not None
            ):
                boxes = (
                    result.boxes.xyxy
                    .cpu()
                    .tolist()
                )

                track_ids = (
                    result.boxes.id
                    .int()
                    .cpu()
                    .tolist()
                )

                confidences = (
                    result.boxes.conf
                    .cpu()
                    .tolist()
                )

                for box, track_id, confidence in zip(
                    boxes,
                    track_ids,
                    confidences,
                    strict=True,
                ):
                    detections_total += 1

                    x1 = float(box[0])
                    y1 = float(box[1])
                    x2 = float(box[2])
                    y2 = float(box[3])

                    # Bottom-center of the person bounding box.
                    # This approximates where the player's feet touch
                    # the floor, which is much better for court filtering
                    # than using the center of their body.
                    foot_x = (x1 + x2) / 2.0
                    foot_y = y2

                    if not self._inside_court(
                        foot_x,
                        foot_y,
                        court_polygon,
                    ):
                        detections_outside_court += 1
                        continue

                    detections_inside_court += 1

                    track_frame_counts[track_id] = (
                        track_frame_counts.get(
                            track_id,
                            0,
                        )
                        + 1
                    )

                    normalized_foot_x = (
                        foot_x / width
                        if width > 0
                        else 0
                    )

                    normalized_foot_y = (
                        foot_y / height
                        if height > 0
                        else 0
                    )

                    players.append(
                        {
                            "track_id": track_id,
                            "confidence": round(
                                float(confidence),
                                4,
                            ),
                            "box": {
                                "x1": round(x1, 2),
                                "y1": round(y1, 2),
                                "x2": round(x2, 2),
                                "y2": round(y2, 2),
                            },
                            "foot": {
                                "x": round(
                                    foot_x,
                                    2,
                                ),
                                "y": round(
                                    foot_y,
                                    2,
                                ),
                            },
                            "foot_normalized": {
                                "x": round(
                                    normalized_foot_x,
                                    6,
                                ),
                                "y": round(
                                    normalized_foot_y,
                                    6,
                                ),
                            },
                        }
                    )

            raw_frames.append(
                {
                    "frame": frame_index,
                    "timestamp_seconds": round(
                        frame_index / fps,
                        3,
                    ),
                    "players": players,
                }
            )

        # Remove tracks that only appeared very briefly.
        #
        # At roughly 30 FPS, this requires a player to exist for
        # about 0.25 seconds before we trust the track.
        minimum_track_frames = max(
            5,
            int(fps * 0.25),
        )

        valid_track_ids = {
            track_id
            for track_id, count
            in track_frame_counts.items()
            if count >= minimum_track_frames
        }

        frames: list[dict[str, Any]] = []
        unique_track_ids: set[int] = set()

        detections_removed_short_track = 0
        detections_kept = 0

        for frame in raw_frames:
            filtered_players: list[
                dict[str, Any]
            ] = []

            for player in frame["players"]:
                if (
                    player["track_id"]
                    not in valid_track_ids
                ):
                    detections_removed_short_track += 1
                    continue

                filtered_players.append(player)
                detections_kept += 1

                unique_track_ids.add(
                    player["track_id"]
                )

            frames.append(
                {
                    "frame": frame["frame"],
                    "timestamp_seconds": (
                        frame["timestamp_seconds"]
                    ),
                    "players": filtered_players,
                }
            )

        processed_frame_count = len(frames)

        duration_seconds = (
            processed_frame_count / fps
            if fps > 0
            else 0.0
        )

        track_lengths = {
            str(track_id): count
            for track_id, count
            in sorted(
                track_frame_counts.items(),
                key=lambda item: item[1],
                reverse=True,
            )
            if track_id in valid_track_ids
        }

        print(
            "[player-tracker] Complete: "
            f"total_detections={detections_total} "
            f"inside={detections_inside_court} "
            f"outside={detections_outside_court} "
            f"kept={detections_kept} "
            f"unique_tracks={len(unique_track_ids)}",
            flush=True,
        )

        return {
            "status": "complete",
            "device": self.device,
            "video_path": str(path),

            "fps": round(fps, 3),
            "width": width,
            "height": height,

            "reported_frame_count": (
                reported_frame_count
            ),

            "frame_count": (
                processed_frame_count
            ),

            "duration_seconds": round(
                duration_seconds,
                3,
            ),

            "court_filter_enabled": (
                court_polygon is not None
            ),

            "court_points_pixels": (
                court_polygon.tolist()
                if court_polygon is not None
                else None
            ),

            "minimum_track_frames": (
                minimum_track_frames
            ),

            "unique_track_count": (
                len(unique_track_ids)
            ),

            "detections_total": (
                detections_total
            ),

            "detections_inside_court": (
                detections_inside_court
            ),

            "detections_removed_outside_court": (
                detections_outside_court
            ),

            "detections_removed_short_track": (
                detections_removed_short_track
            ),

            "detections_kept": (
                detections_kept
            ),

            "track_lengths": track_lengths,

            "frames": frames,
        }
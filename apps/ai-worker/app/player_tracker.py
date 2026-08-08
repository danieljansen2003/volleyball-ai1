from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np
import torch
from ultralytics import YOLO

ProgressCallback = Callable[[int, int, str], None]


class PlayerTracker:
    def __init__(self) -> None:
        worker_root = Path(__file__).resolve().parent.parent
        model_path = worker_root / "yolo11n.pt"
        model_source = str(model_path) if model_path.exists() else "yolo11n.pt"
        if not model_path.exists():
            print("[player-tracker] Local yolo11n.pt not found; asking Ultralytics to download the official weight file.", flush=True)
        self.model = YOLO(model_source)
        ball_model_path = worker_root / "models" / "volleyball-ball.pt"
        self.ball_model_path = ball_model_path
        self.ball_model = YOLO(str(ball_model_path)) if ball_model_path.exists() else None
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"
        tracker_path = Path(__file__).resolve().parent / "trackers" / "volleyball_tracktrack.yaml"
        self.tracker_path = str(tracker_path)
        self.person_conf = float(os.getenv("VV_PERSON_CONF", "0.32"))
        self.ball_conf = float(os.getenv("VV_BALL_CONF", "0.08"))
        self.ball_imgsz = int(os.getenv("VV_BALL_IMGSZ", "1280"))
        self.stitch_gap_seconds = float(os.getenv("VV_STITCH_GAP_SECONDS", "3.0"))
        self.stitch_distance = float(os.getenv("VV_STITCH_DISTANCE", "0.22"))
        print(
            f"[player-tracker] Loaded player YOLO on device={self.device} tracker={tracker_path.name}",
            flush=True,
        )
        if self.ball_model is not None:
            print(f"[player-tracker] Loaded custom volleyball detector: {ball_model_path}", flush=True)
        else:
            print(
                f"[player-tracker] No custom volleyball detector yet at {ball_model_path}. "
                "Ball detections will remain 0 until you train and deploy volleyball-ball.pt.",
                flush=True,
            )

    @staticmethod
    def _build_court_polygon(
        court_points: list[dict[str, float]] | None,
        width: int,
        height: int,
    ) -> np.ndarray | None:
        if not court_points:
            return None
        if len(court_points) != 4:
            raise ValueError("Exactly four court points are required.")
        pixel_points: list[list[int]] = []
        for point in court_points:
            x = float(point["x"])
            y = float(point["y"])
            if not 0 <= x <= 1 or not 0 <= y <= 1:
                raise ValueError("Court coordinates must be normalized between 0 and 1.")
            pixel_points.append([int(round(x * width)), int(round(y * height))])
        return np.asarray(pixel_points, dtype=np.int32)

    @staticmethod
    def _court_transform(court_polygon: np.ndarray | None) -> np.ndarray | None:
        if court_polygon is None or len(court_polygon) != 4:
            return None
        src = court_polygon.astype(np.float32)
        dst = np.asarray([[0.0, 1.0], [1.0, 1.0], [1.0, 0.0], [0.0, 0.0]], dtype=np.float32)
        return cv2.getPerspectiveTransform(src, dst)

    @staticmethod
    def _project_point(point: tuple[float, float], transform: np.ndarray | None) -> tuple[float, float] | None:
        if transform is None:
            return None
        source = np.asarray([[[float(point[0]), float(point[1])]]], dtype=np.float32)
        projected = cv2.perspectiveTransform(source, transform)[0][0]
        return float(projected[0]), float(projected[1])

    @staticmethod
    def _inside_court(foot_x: float, foot_y: float, court_polygon: np.ndarray | None) -> bool:
        if court_polygon is None:
            return True
        return cv2.pointPolygonTest(court_polygon, (float(foot_x), float(foot_y)), False) >= 0

    @staticmethod
    def _build_segments(raw_frames: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
        segments: dict[int, dict[str, Any]] = {}
        for frame in raw_frames:
            frame_index = int(frame["frame"])
            for player in frame["players"]:
                raw_id = int(player["raw_track_id"])
                segment = segments.setdefault(
                    raw_id,
                    {
                        "raw_id": raw_id,
                        "start": frame_index,
                        "end": frame_index,
                        "first_court": player.get("court_position"),
                        "last_court": player.get("court_position"),
                        "first_foot": player["foot"],
                        "last_foot": player["foot"],
                        "heights": [],
                        "confidences": [],
                    },
                )
                segment["end"] = frame_index
                segment["last_court"] = player.get("court_position")
                segment["last_foot"] = player["foot"]
                segment["heights"].append(float(player["box"]["y2"] - player["box"]["y1"]))
                segment["confidences"].append(float(player["confidence"]))
        for segment in segments.values():
            heights = segment["heights"]
            segment["median_height"] = float(np.median(heights)) if heights else 1.0
        return segments

    def _stitch_track_ids(
        self,
        raw_frames: list[dict[str, Any]],
        fps: float,
        width: int,
        height: int,
    ) -> tuple[dict[int, int], dict[str, Any]]:
        segments = self._build_segments(raw_frames)
        ordered = sorted(segments.values(), key=lambda item: (item["start"], item["raw_id"]))
        max_gap = max(1, int(round(fps * self.stitch_gap_seconds)))
        mapping: dict[int, int] = {}
        stable_last: dict[int, dict[str, Any]] = {}
        next_stable = 1
        stitched_pairs: list[dict[str, Any]] = []

        def position(segment: dict[str, Any], first: bool) -> tuple[float, float]:
            court = segment["first_court"] if first else segment["last_court"]
            if court is not None:
                return float(court["x"]), float(court["y"])
            foot = segment["first_foot"] if first else segment["last_foot"]
            return float(foot["x"]) / max(1.0, width), float(foot["y"]) / max(1.0, height)

        for segment in ordered:
            best_stable = None
            best_score = 999.0
            start_pos = position(segment, True)
            current_height = max(1.0, float(segment["median_height"]))

            for stable_id, previous in stable_last.items():
                gap = int(segment["start"]) - int(previous["end"])
                if gap <= 0 or gap > max_gap:
                    continue
                previous_pos = position(previous, False)
                distance = math.dist(start_pos, previous_pos)
                height_ratio = current_height / max(1.0, float(previous["median_height"]))
                height_penalty = abs(math.log(max(0.01, height_ratio)))
                if distance > self.stitch_distance or height_penalty > 0.65:
                    continue
                score = distance + 0.10 * height_penalty + 0.02 * (gap / max_gap)
                if score < best_score:
                    best_score = score
                    best_stable = stable_id

            if best_stable is None:
                stable_id = next_stable
                next_stable += 1
            else:
                stable_id = best_stable
                stitched_pairs.append(
                    {
                        "from_raw_track_id": int(segment["raw_id"]),
                        "stable_track_id": stable_id,
                        "gap_frames": int(segment["start"] - stable_last[stable_id]["end"]),
                        "score": round(best_score, 4),
                    }
                )

            mapping[int(segment["raw_id"])] = stable_id
            stable_last[stable_id] = segment

        return mapping, {
            "raw_track_count": len(segments),
            "stable_track_count": len(set(mapping.values())),
            "stitched_track_count": len(stitched_pairs),
            "stitched_pairs": stitched_pairs,
        }

    def track(
        self,
        video_path: str,
        court_points: list[dict[str, float]] | None = None,
        progress_callback: ProgressCallback | None = None,
    ) -> dict[str, Any]:
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

        court_polygon = self._build_court_polygon(court_points, width, height)
        court_transform = self._court_transform(court_polygon)
        print(
            f"[player-tracker] video={path.name} size={width}x{height} fps={fps:.3f} "
            f"frames={reported_frame_count}",
            flush=True,
        )

        if progress_callback:
            progress_callback(0, max(1, reported_frame_count), "Tracking players")

        # Player tracking is kept separate from volleyball detection. The production ball
        # model is a custom single-class detector trained from VolleyVision labels.
        results = self.model.track(
            source=str(path),
            tracker=self.tracker_path,
            classes=[0],
            persist=True,
            device=self.device,
            stream=True,
            verbose=False,
            conf=self.person_conf,
            iou=0.50,
        )

        raw_frames: list[dict[str, Any]] = []
        track_frame_counts: dict[int, int] = {}
        detections_total = 0
        detections_inside_court = 0
        detections_outside_court = 0
        ball_detections = 0

        for frame_index, result in enumerate(results):
            players: list[dict[str, Any]] = []
            balls: list[dict[str, Any]] = []

            # Run the dedicated volleyball detector on the exact frame that was
            # used for player tracking. The custom model is single-class, so we
            # do not use COCO's generic "sports ball" class here.
            if self.ball_model is not None and result.orig_img is not None:
                ball_results = self.ball_model.predict(
                    source=result.orig_img,
                    conf=self.ball_conf,
                    imgsz=self.ball_imgsz,
                    device=self.device,
                    verbose=False,
                    max_det=5,
                )

                if ball_results and ball_results[0].boxes is not None and len(ball_results[0].boxes) > 0:
                    ball_boxes = ball_results[0].boxes.xyxy.cpu().tolist()
                    ball_confidences = ball_results[0].boxes.conf.cpu().tolist()

                    candidates: list[dict[str, Any]] = []
                    for ball_box, ball_confidence in zip(ball_boxes, ball_confidences, strict=True):
                        bx1, by1, bx2, by2 = (float(value) for value in ball_box)
                        ball_confidence = float(ball_confidence)
                        center_x = (bx1 + bx2) / 2.0
                        center_y = (by1 + by2) / 2.0

                        # Guard against obviously implausible giant boxes. This is
                        # deliberately permissive because the ball can be very small.
                        if (bx2 - bx1) > width * 0.15 or (by2 - by1) > height * 0.15:
                            continue

                        candidates.append(
                            {
                                "confidence": round(ball_confidence, 4),
                                "box": {
                                    "x1": round(bx1, 2),
                                    "y1": round(by1, 2),
                                    "x2": round(bx2, 2),
                                    "y2": round(by2, 2),
                                },
                                "center": {
                                    "x": round(center_x, 2),
                                    "y": round(center_y, 2),
                                },
                                "center_normalized": {
                                    "x": round(center_x / max(1, width), 6),
                                    "y": round(center_y / max(1, height), 6),
                                },
                                "source": "custom_volleyball_model",
                            }
                        )

                    # There is only one game ball. Keep the strongest detection for
                    # each frame rather than passing multiple false positives into
                    # contact/action inference.
                    if candidates:
                        best_ball = max(candidates, key=lambda item: float(item["confidence"]))
                        balls.append(best_ball)
                        ball_detections += 1

            if result.boxes is not None and len(result.boxes) > 0:
                boxes = result.boxes.xyxy.cpu().tolist()
                confidences = result.boxes.conf.cpu().tolist()
                classes = result.boxes.cls.int().cpu().tolist()
                if result.boxes.id is not None:
                    ids = result.boxes.id.int().cpu().tolist()
                else:
                    ids = [-1] * len(boxes)

                for box, raw_track_id, confidence, class_id in zip(
                    boxes, ids, confidences, classes, strict=True
                ):
                    x1, y1, x2, y2 = (float(value) for value in box)
                    confidence = float(confidence)
                    if class_id == 0:
                        if confidence < self.person_conf or raw_track_id < 0:
                            continue
                        detections_total += 1
                        foot_x = (x1 + x2) / 2.0
                        foot_y = y2
                        if not self._inside_court(foot_x, foot_y, court_polygon):
                            detections_outside_court += 1
                            continue
                        detections_inside_court += 1
                        track_frame_counts[raw_track_id] = track_frame_counts.get(raw_track_id, 0) + 1
                        court_position = self._project_point((foot_x, foot_y), court_transform)
                        players.append(
                            {
                                "track_id": int(raw_track_id),
                                "raw_track_id": int(raw_track_id),
                                "confidence": round(confidence, 4),
                                "box": {
                                    "x1": round(x1, 2),
                                    "y1": round(y1, 2),
                                    "x2": round(x2, 2),
                                    "y2": round(y2, 2),
                                },
                                "foot": {"x": round(foot_x, 2), "y": round(foot_y, 2)},
                                "court_position": (
                                    {"x": round(court_position[0], 5), "y": round(court_position[1], 5)}
                                    if court_position is not None
                                    else None
                                ),
                            }
                        )

            raw_frames.append(
                {
                    "frame": frame_index,
                    "timestamp_seconds": round(frame_index / fps, 3),
                    "players": players,
                    "balls": balls,
                }
            )

            if progress_callback and (
                frame_index == 0 or frame_index % 15 == 0 or frame_index + 1 >= reported_frame_count
            ):
                progress_callback(
                    frame_index + 1,
                    max(1, reported_frame_count),
                    f"Tracking frame {frame_index + 1} of {reported_frame_count}",
                )

        minimum_track_frames = max(5, int(fps * 0.20))
        valid_raw_ids = {
            track_id for track_id, count in track_frame_counts.items() if count >= minimum_track_frames
        }
        filtered_raw_frames: list[dict[str, Any]] = []
        detections_removed_short_track = 0
        for frame in raw_frames:
            filtered_players = []
            for player in frame["players"]:
                if player["raw_track_id"] not in valid_raw_ids:
                    detections_removed_short_track += 1
                    continue
                filtered_players.append(player)
            filtered_raw_frames.append({**frame, "players": filtered_players})

        id_mapping, stitching = self._stitch_track_ids(filtered_raw_frames, fps, width, height)
        frames: list[dict[str, Any]] = []
        stable_ids: set[int] = set()
        detections_kept = 0
        stable_track_lengths: dict[int, int] = {}
        for frame in filtered_raw_frames:
            players = []
            for player in frame["players"]:
                stable_id = id_mapping.get(int(player["raw_track_id"]), int(player["raw_track_id"]))
                updated = {**player, "track_id": stable_id}
                players.append(updated)
                detections_kept += 1
                stable_ids.add(stable_id)
                stable_track_lengths[stable_id] = stable_track_lengths.get(stable_id, 0) + 1
            frames.append({**frame, "players": players})

        duration_seconds = len(frames) / fps if fps > 0 else 0.0
        print(
            "[player-tracker] Complete: "
            f"raw_tracks={stitching['raw_track_count']} stable_tracks={len(stable_ids)} "
            f"stitched={stitching['stitched_track_count']} ball_detections={ball_detections}",
            flush=True,
        )

        return {
            "status": "complete",
            "device": self.device,
            "tracker": Path(self.tracker_path).name,
            "video_path": str(path),
            "fps": round(fps, 3),
            "width": width,
            "height": height,
            "reported_frame_count": reported_frame_count,
            "frame_count": len(frames),
            "duration_seconds": round(duration_seconds, 3),
            "court_filter_enabled": court_polygon is not None,
            "court_points_pixels": court_polygon.tolist() if court_polygon is not None else None,
            "minimum_track_frames": minimum_track_frames,
            "raw_unique_track_count": stitching["raw_track_count"],
            "unique_track_count": len(stable_ids),
            "stitched_track_count": stitching["stitched_track_count"],
            "stitching": stitching,
            "detections_total": detections_total,
            "detections_inside_court": detections_inside_court,
            "detections_removed_outside_court": detections_outside_court,
            "detections_removed_short_track": detections_removed_short_track,
            "detections_kept": detections_kept,
            "ball_detections": ball_detections,
            "ball_model": str(self.ball_model_path) if self.ball_model is not None else None,
            "ball_model_ready": self.ball_model is not None,
            "track_lengths": {str(k): v for k, v in sorted(stable_track_lengths.items())},
            "frames": frames,
        }

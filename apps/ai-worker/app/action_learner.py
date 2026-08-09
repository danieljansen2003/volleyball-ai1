from __future__ import annotations

import json
import math
import os
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FEEDBACK_DIR = PROJECT_ROOT / "storage" / "local" / "training-feedback"

_CANONICAL = {
    "serve": "serve",
    "serving": "serve",
    "pass": "pass",
    "serve receive": "pass",
    "serve receive / pass": "pass",
    "reception": "pass",
    "dig": "dig",
    "dig / cover": "dig",
    "cover": "dig",
    "set": "set",
    "setting": "set",
    "attack": "attack",
    "hit": "attack",
    "kill": "attack",
    "spike": "attack",
    "block": "block",
    "block touch": "block",
}


def canonical_action(value: Any) -> str:
    text = str(value or "").strip().lower().replace("_", " ")
    if text in _CANONICAL:
        return _CANONICAL[text]
    for key, value in _CANONICAL.items():
        if key in text:
            return value
    return text


def _numeric_features(value: Any, prefix: str = "") -> dict[str, float]:
    out: dict[str, float] = {}
    if isinstance(value, bool):
        out[prefix] = 1.0 if value else 0.0
    elif isinstance(value, (int, float)) and math.isfinite(float(value)):
        out[prefix] = float(value)
    elif isinstance(value, dict):
        for key, child in value.items():
            child_prefix = f"{prefix}.{key}" if prefix else str(key)
            out.update(_numeric_features(child, child_prefix))
    return out


def _ball_point(frame: dict[str, Any]) -> tuple[float, float] | None:
    balls = frame.get("balls") or []
    if not balls:
        return None
    ball = balls[0]
    center = ball.get("center_normalized") or ball.get("center") or {}
    try:
        return float(center["x"]), float(center["y"])
    except Exception:
        return None


def _window_features(touch: dict[str, Any], tracking: dict[str, Any] | None) -> dict[str, float]:
    if not isinstance(tracking, dict):
        return {}
    frames = tracking.get("frames") or []
    fps = float(tracking.get("fps") or 30.0)
    if not frames or fps <= 0:
        return {}
    width = max(1.0, float(tracking.get("width") or 1.0))
    height = max(1.0, float(tracking.get("height") or 1.0))
    t = float(touch.get("start_time") or 0.0)
    center_idx = max(0, min(len(frames) - 1, int(round(t * fps))))
    radius = max(2, int(round(0.75 * fps)))
    lo = max(0, center_idx - radius)
    hi = min(len(frames), center_idx + radius + 1)

    samples: list[tuple[int, float, float]] = []
    for idx in range(lo, hi):
        point = _ball_point(frames[idx])
        if point is None:
            continue
        x, y = point
        # Older tracker payloads can contain pixel centers.
        if x > 1.5 or y > 1.5:
            x /= width
            y /= height
        samples.append((idx, x, y))
    if len(samples) < 3:
        return {"window.ball_samples": float(len(samples))}

    before = [s for s in samples if s[0] <= center_idx]
    after = [s for s in samples if s[0] >= center_idx]

    def velocity(group: list[tuple[int, float, float]]) -> tuple[float, float, float]:
        if len(group) < 2:
            return 0.0, 0.0, 0.0
        a, b = group[0], group[-1]
        dt = max(1.0 / fps, (b[0] - a[0]) / fps)
        vx = (b[1] - a[1]) / dt
        vy = (b[2] - a[2]) / dt
        return vx, vy, math.hypot(vx, vy)

    pre_vx, pre_vy, pre_speed = velocity(before[-max(2, int(fps * 0.35)) :])
    post_vx, post_vy, post_speed = velocity(after[: max(2, int(fps * 0.35))])
    nearest = min(samples, key=lambda s: abs(s[0] - center_idx))

    out = {
        "window.ball_samples": float(len(samples)),
        "window.ball_x": nearest[1],
        "window.ball_y": nearest[2],
        "window.pre_vx": pre_vx,
        "window.pre_vy": pre_vy,
        "window.pre_speed": pre_speed,
        "window.post_vx": post_vx,
        "window.post_vy": post_vy,
        "window.post_speed": post_speed,
        "window.speed_change": post_speed - pre_speed,
        "window.direction_change": math.hypot(post_vx - pre_vx, post_vy - pre_vy),
        "window.vertical_flip": 1.0 if pre_vy * post_vy < 0 else 0.0,
    }

    track_id = touch.get("track_id")
    if track_id is not None:
        frame = frames[center_idx]
        players = frame.get("players") or []
        player = next((p for p in players if p.get("track_id") == track_id), None)
        if player:
            box = player.get("box") or {}
            try:
                px = (float(box["x1"]) + float(box["x2"])) / 2.0 / width
                py = (float(box["y1"]) + float(box["y2"])) / 2.0 / height
                out["window.player_ball_distance"] = math.hypot(nearest[1] - px, nearest[2] - py)
                out["window.player_x"] = px
                out["window.player_y"] = py
            except Exception:
                pass
    return out


def enrich_touch_features(touch: dict[str, Any], tracking: dict[str, Any] | None) -> dict[str, float]:
    features = _numeric_features(touch.get("features") or {})
    features.update(_window_features(touch, tracking))
    heuristic = canonical_action(touch.get("action"))
    if heuristic:
        features[f"heuristic.{heuristic}"] = 1.0
    features["touch.duration"] = max(0.0, float(touch.get("end_time") or 0.0) - float(touch.get("start_time") or 0.0))
    touch["features"] = features
    return features


class ActionLearner:
    """Conservative instance-based action learner.

    Every reviewed JSON label can affect the very next video. There is no neural
    retraining step. The existing heuristic detector still finds contacts; this
    learner only re-ranks the action label when reviewed examples strongly agree.
    """

    def __init__(self, feedback_dir: Path | None = None) -> None:
        self.feedback_dir = feedback_dir or Path(os.getenv("VV_ACTION_FEEDBACK_DIR", str(DEFAULT_FEEDBACK_DIR)))
        self.min_examples = int(os.getenv("VV_ACTION_MIN_EXAMPLES", "8"))
        self.min_confidence = float(os.getenv("VV_ACTION_MIN_CONFIDENCE", "0.62"))
        self.min_support = int(os.getenv("VV_ACTION_MIN_SUPPORT", "2"))
        self.k = int(os.getenv("VV_ACTION_K", "7"))
        self._signature: tuple[int, int] | None = None
        self._examples: list[tuple[str, dict[str, float]]] = []

    def _reload_if_needed(self) -> None:
        files = sorted(self.feedback_dir.glob("*.json")) if self.feedback_dir.exists() else []
        signature = (len(files), int(max((p.stat().st_mtime for p in files), default=0)))
        if signature == self._signature:
            return
        examples: list[tuple[str, dict[str, float]]] = []
        for path in files:
            try:
                record = json.loads(path.read_text())
            except Exception:
                continue
            label = canonical_action((record.get("corrected_label") or {}).get("action"))
            original = record.get("original_prediction") or {}
            if label not in {"serve", "pass", "set", "attack", "dig", "block"}:
                continue
            features = _numeric_features(original.get("features") or {})
            heuristic = canonical_action(original.get("action"))
            if heuristic:
                features[f"heuristic.{heuristic}"] = 1.0
            clip = record.get("clip") or {}
            try:
                features["touch.duration"] = max(0.0, float(clip.get("end_time", 0)) - float(clip.get("start_time", 0)))
            except Exception:
                pass
            if len(features) >= 2:
                examples.append((label, features))
        self._examples = examples
        self._signature = signature

    @property
    def example_count(self) -> int:
        self._reload_if_needed()
        return len(self._examples)

    def predict(self, query: dict[str, float]) -> tuple[str | None, float, int]:
        self._reload_if_needed()
        if len(self._examples) < self.min_examples or len(query) < 2:
            return None, 0.0, 0

        keys = sorted(set(query).intersection(*(set(features) for _, features in self._examples)))
        if len(keys) < 2:
            # Use keys present in query and at least a few examples instead of requiring all records.
            counts = Counter(k for _, f in self._examples for k in f if k in query)
            keys = [k for k, count in counts.items() if count >= max(3, len(self._examples) // 4)]
        if len(keys) < 2:
            return None, 0.0, 0

        means: dict[str, float] = {}
        scales: dict[str, float] = {}
        for key in keys:
            vals = [f[key] for _, f in self._examples if key in f]
            if not vals:
                continue
            mean = sum(vals) / len(vals)
            variance = sum((v - mean) ** 2 for v in vals) / max(1, len(vals) - 1)
            means[key] = mean
            scales[key] = max(1e-4, math.sqrt(variance))

        scored: list[tuple[float, str]] = []
        for label, features in self._examples:
            common = [k for k in keys if k in features and k in query]
            if len(common) < 2:
                continue
            d2 = sum(((query[k] - features[k]) / scales[k]) ** 2 for k in common) / len(common)
            scored.append((math.sqrt(d2), label))
        if not scored:
            return None, 0.0, 0
        scored.sort(key=lambda item: item[0])
        nearest = scored[: min(self.k, len(scored))]
        votes: dict[str, float] = defaultdict(float)
        supports: Counter[str] = Counter()
        for distance, label in nearest:
            weight = 1.0 / (0.20 + distance)
            votes[label] += weight
            supports[label] += 1
        ordered = sorted(votes.items(), key=lambda item: item[1], reverse=True)
        best_label, best_vote = ordered[0]
        total = sum(votes.values())
        confidence = best_vote / max(1e-9, total)
        support = supports[best_label]
        if confidence < self.min_confidence or support < self.min_support:
            return None, confidence, support
        return best_label, confidence, support

    def apply(self, result: dict[str, Any]) -> dict[str, Any]:
        tracking = result.get("tracking") if isinstance(result, dict) else None
        overrides = 0
        candidates = 0
        for rally in result.get("rallies") or []:
            for touch in rally.get("touches") or []:
                candidates += 1
                query = enrich_touch_features(touch, tracking)
                predicted, confidence, support = self.predict(query)
                if not predicted:
                    continue
                old = canonical_action(touch.get("action"))
                touch["action_learning"] = {
                    "prediction": predicted,
                    "confidence": round(confidence, 4),
                    "support": support,
                    "examples": self.example_count,
                }
                if predicted != old:
                    touch["heuristic_action"] = touch.get("action")
                    touch["action"] = predicted
                    touch["confidence"] = max(float(touch.get("confidence") or 0.0), min(0.95, confidence))
                    touch["source"] = "review_memory+heuristic_contact"
                    touch["notes"] = (str(touch.get("notes") or "") + f" Action learner changed {old or 'unknown'} -> {predicted} from {support} nearby reviewed examples.").strip()
                    overrides += 1
        result["action_learning"] = {
            "mode": "review-memory-knn-v1",
            "reviewed_examples": self.example_count,
            "candidates_seen": candidates,
            "labels_overridden": overrides,
            "message": "Existing contact detector preserved; reviewed labels only re-rank action type when confidence is high.",
        }
        return result

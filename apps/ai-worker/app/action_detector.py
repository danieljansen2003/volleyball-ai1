from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class BallObservation:
    frame: int
    time: float
    x: float
    y: float
    confidence: float


def _center(box: dict[str, float]) -> tuple[float, float]:
    return ((box["x1"] + box["x2"]) / 2.0, (box["y1"] + box["y2"]) / 2.0)


def _player_distance(ball_x: float, ball_y: float, player: dict[str, Any]) -> tuple[float, float]:
    box = player["box"]
    height = max(1.0, box["y2"] - box["y1"])
    width = max(1.0, box["x2"] - box["x1"])
    px = (box["x1"] + box["x2"]) / 2.0
    py = box["y1"] + 0.45 * height
    dx = (ball_x - px) / max(height, width)
    dy = (ball_y - py) / height
    return (dx * dx + dy * dy) ** 0.5, height


def _velocity(before: BallObservation | None, after: BallObservation | None, width: int, height: int) -> tuple[float, float, float]:
    if before is None or after is None or after.time <= before.time:
        return (0.0, 0.0, 0.0)
    dt = after.time - before.time
    vx = ((after.x - before.x) / max(1.0, width)) / dt
    vy = ((after.y - before.y) / max(1.0, height)) / dt
    speed = (vx * vx + vy * vy) ** 0.5
    return vx, vy, speed


def _classify_contact(
    contact_index: int,
    contacts_count: int,
    player: dict[str, Any],
    ball: BallObservation,
    before: BallObservation | None,
    after: BallObservation | None,
    width: int,
    height: int,
) -> tuple[str, str, float, dict[str, float]]:
    box = player["box"]
    player_height = max(1.0, box["y2"] - box["y1"])
    contact_height = (ball.y - box["y1"]) / player_height
    in_vx, in_vy, in_speed = _velocity(before, ball, width, height)
    out_vx, out_vy, out_speed = _velocity(ball, after, width, height)
    direction_change = abs(out_vx - in_vx) + abs(out_vy - in_vy)

    action = "touch"
    confidence = 0.35

    if contact_index == 0 and out_speed > 0.08:
        action = "serve"
        confidence = 0.55
    elif contact_height <= 0.42 and out_vy < -0.03 and out_speed < 1.4:
        action = "set"
        confidence = 0.52
    elif contact_height <= 0.48 and out_vy > 0.03 and out_speed >= 0.12:
        action = "attack"
        confidence = 0.56
    elif contact_height > 0.42 and out_vy < -0.015:
        action = "pass"
        confidence = 0.50
    elif contact_height <= 0.30 and direction_change > 0.18:
        action = "block"
        confidence = 0.45
    elif direction_change > 0.12:
        action = "dig"
        confidence = 0.42

    outcome = "continued rally"
    if action == "attack" and contact_index == contacts_count - 1:
        outcome = "kill candidate"
        confidence = max(confidence, 0.58)
    elif action == "pass":
        outcome = "pass candidate"
    elif action == "set":
        outcome = "set candidate"
    elif action == "serve":
        outcome = "serve in candidate"

    confidence = min(0.80, confidence + min(0.12, direction_change * 0.15))
    features = {
        "contact_height": round(contact_height, 4),
        "incoming_speed": round(in_speed, 4),
        "outgoing_speed": round(out_speed, 4),
        "incoming_vy": round(in_vy, 4),
        "outgoing_vy": round(out_vy, 4),
        "direction_change": round(direction_change, 4),
    }
    return action, outcome, round(confidence, 3), features


def detect_actions(tracking: dict[str, Any], match_id: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    frames = tracking.get("frames") or []
    fps = float(tracking.get("fps") or 30.0)
    width = int(tracking.get("width") or 1)
    height = int(tracking.get("height") or 1)

    observations: list[BallObservation] = []
    observation_frames: list[dict[str, Any]] = []
    for frame in frames:
        balls = frame.get("balls") or []
        if not balls:
            continue
        ball = max(balls, key=lambda item: float(item.get("confidence", 0.0)))
        observations.append(
            BallObservation(
                frame=int(frame["frame"]),
                time=float(frame["timestamp_seconds"]),
                x=float(ball["center"]["x"]),
                y=float(ball["center"]["y"]),
                confidence=float(ball.get("confidence", 0.0)),
            )
        )
        observation_frames.append(frame)

    if len(observations) < 3:
        return [], {
            "ball_observations": len(observations),
            "contact_candidates": 0,
            "message": "Not enough volleyball detections for automatic action inference. Review manually and keep the labels for training.",
        }

    candidates: list[dict[str, Any]] = []
    for idx, (obs, frame) in enumerate(zip(observations, observation_frames, strict=True)):
        players = frame.get("players") or []
        if not players:
            continue
        best_player = None
        best_distance = 999.0
        for player in players:
            distance, _ = _player_distance(obs.x, obs.y, player)
            if distance < best_distance:
                best_distance = distance
                best_player = player
        if best_player is None or best_distance > 0.78:
            continue

        previous_distance = None
        next_distance = None
        if idx > 0:
            previous_frame = observation_frames[idx - 1]
            previous_player = next(
                (p for p in previous_frame.get("players", []) if p.get("track_id") == best_player.get("track_id")),
                None,
            )
            if previous_player:
                previous_distance, _ = _player_distance(observations[idx - 1].x, observations[idx - 1].y, previous_player)
        if idx + 1 < len(observations):
            next_frame = observation_frames[idx + 1]
            next_player = next(
                (p for p in next_frame.get("players", []) if p.get("track_id") == best_player.get("track_id")),
                None,
            )
            if next_player:
                next_distance, _ = _player_distance(observations[idx + 1].x, observations[idx + 1].y, next_player)

        is_local_min = (
            (previous_distance is None or best_distance <= previous_distance)
            and (next_distance is None or best_distance <= next_distance)
        )
        if not is_local_min:
            continue
        candidates.append({"obs_index": idx, "player": best_player, "proximity": best_distance})

    deduped: list[dict[str, Any]] = []
    minimum_gap = max(1, int(round(fps * 0.20)))
    for candidate in candidates:
        obs = observations[candidate["obs_index"]]
        if deduped:
            last_obs = observations[deduped[-1]["obs_index"]]
            if obs.frame - last_obs.frame < minimum_gap:
                if candidate["proximity"] < deduped[-1]["proximity"]:
                    deduped[-1] = candidate
                continue
        deduped.append(candidate)

    touches: list[dict[str, Any]] = []
    for contact_index, candidate in enumerate(deduped):
        obs_index = candidate["obs_index"]
        obs = observations[obs_index]
        before = observations[obs_index - 1] if obs_index > 0 else None
        after = observations[obs_index + 1] if obs_index + 1 < len(observations) else None
        player = candidate["player"]
        action, outcome, confidence, features = _classify_contact(
            contact_index,
            len(deduped),
            player,
            obs,
            before,
            after,
            width,
            height,
        )
        touch_id = match_id * 10000 + contact_index + 1
        touches.append(
            {
                "id": touch_id,
                "rally_id": match_id,
                "start_time": round(max(0.0, obs.time - 0.18), 3),
                "end_time": round(obs.time + 0.35, 3),
                "action": action,
                "player": f"ID {player['track_id']}",
                "outcome": outcome,
                "notes": "Experimental ball/proximity heuristic. Review this label; approved corrections become training data.",
                "confidence": confidence,
                "source": "ai_heuristic",
                "reviewed": False,
                "track_id": int(player["track_id"]),
                "ball_frame": obs.frame,
                "features": features,
            }
        )

    return touches, {
        "ball_observations": len(observations),
        "contact_candidates": len(touches),
        "message": "Actions are experimental candidates derived from generic sports-ball detections and player proximity. Review every label before using it for stats or training.",
    }

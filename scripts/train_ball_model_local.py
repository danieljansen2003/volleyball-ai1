#!/usr/bin/env python3
from __future__ import annotations

import argparse
import random
import shutil
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "storage" / "local" / "ball-labels"
BUILD = ROOT / "storage" / "local" / "ball-dataset-build"
MODEL_OUT = ROOT / "apps" / "ai-worker" / "models" / "volleyball-ball.pt"


def main() -> None:
    parser = argparse.ArgumentParser(description="Train VolleyVision's ball detector from localhost labels only.")
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--imgsz", type=int, default=1280)
    parser.add_argument("--patience", type=int, default=15)
    args = parser.parse_args()

    images = SOURCE / "images"; labels = SOURCE / "labels"
    pairs = [(p, labels / f"{p.stem}.txt") for p in sorted(images.glob("*.jpg")) if (labels / f"{p.stem}.txt").exists()]
    if len(pairs) < 20:
        raise SystemExit(f"Need at least 20 local ball labels; found {len(pairs)}.")
    random.Random(42).shuffle(pairs)
    val_count = max(10, round(len(pairs) * 0.20))
    val = pairs[:val_count]; train = pairs[val_count:]
    if BUILD.exists(): shutil.rmtree(BUILD)
    for split in ("train", "val"):
        (BUILD / "images" / split).mkdir(parents=True, exist_ok=True)
        (BUILD / "labels" / split).mkdir(parents=True, exist_ok=True)
    for split, items in (("train", train), ("val", val)):
        for image, label in items:
            shutil.copy2(image, BUILD / "images" / split / image.name)
            shutil.copy2(label, BUILD / "labels" / split / label.name)
    yaml = BUILD / "data.yaml"
    yaml.write_text(f"path: {BUILD}\ntrain: images/train\nval: images/val\nnames:\n  0: volleyball\n")

    start = MODEL_OUT if MODEL_OUT.exists() else ROOT / "apps" / "ai-worker" / "yolo11n.pt"
    if not start.exists(): start = Path("yolo11n.pt")
    print(f"Local labels: {len(pairs)} ({len(train)} train / {len(val)} val)")
    print(f"Warm-start: {start}")
    model = YOLO(str(start))
    result = model.train(data=str(yaml), epochs=args.epochs, imgsz=args.imgsz, patience=args.patience, device="mps", project=str(ROOT / "runs" / "volleyball-ball-local"), name="detector", exist_ok=True)
    best = Path(result.save_dir) / "weights" / "best.pt"
    if not best.exists(): raise SystemExit(f"Training finished but best.pt was not found at {best}")
    MODEL_OUT.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(best, MODEL_OUT)
    print(f"Installed best model: {MODEL_OUT}")
    print("Restart the AI worker service to load the new ball model: ./scripts/restart_local_services.sh")


if __name__ == "__main__": main()

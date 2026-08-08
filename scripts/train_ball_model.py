from __future__ import annotations

import argparse
import json
import random
import shutil
from pathlib import Path
from urllib.parse import urljoin

import requests
from ultralytics import YOLO


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, timeout=60) as response:
        response.raise_for_status()
        destination.write_bytes(response.content)


def fetch_samples(app_url: str) -> list[dict]:
    index_url = urljoin(app_url.rstrip("/") + "/", "api/ball-labels")
    response = requests.get(index_url, timeout=60)
    response.raise_for_status()
    payload = response.json()
    samples = []
    for item in payload.get("samples", []):
        metadata_url = item.get("metadata_url")
        if not metadata_url:
            continue
        metadata_response = requests.get(metadata_url, timeout=60)
        metadata_response.raise_for_status()
        samples.append(metadata_response.json())
    return samples


def prepare_dataset(samples: list[dict], root: Path, seed: int = 42) -> Path:
    if len(samples) < 10:
        raise RuntimeError(
            f"Only {len(samples)} ball labels are available. Collect at least 10 before a smoke-test train, "
            "and aim for 200+ before judging detector quality."
        )

    if root.exists():
        shutil.rmtree(root)

    rng = random.Random(seed)
    shuffled = list(samples)
    rng.shuffle(shuffled)

    n = len(shuffled)
    train_end = max(1, int(n * 0.70))
    val_end = max(train_end + 1, int(n * 0.90)) if n >= 3 else n

    partitions = {
        "train": shuffled[:train_end],
        "val": shuffled[train_end:val_end],
        "test": shuffled[val_end:],
    }
    if not partitions["test"] and len(partitions["val"]) > 1:
        partitions["test"].append(partitions["val"].pop())

    manifest = []
    for split, split_samples in partitions.items():
        image_dir = root / "images" / split
        label_dir = root / "labels" / split
        image_dir.mkdir(parents=True, exist_ok=True)
        label_dir.mkdir(parents=True, exist_ok=True)

        for index, sample in enumerate(split_samples):
            sample_id = str(sample.get("sample_id") or f"sample-{index}").replace("/", "_")
            image_path = image_dir / f"{sample_id}.jpg"
            label_path = label_dir / f"{sample_id}.txt"
            download(sample["image_url"], image_path)
            download(sample["label_url"], label_path)
            manifest.append({"split": split, **sample})

    data_yaml = root / "data.yaml"
    data_yaml.write_text(
        "\n".join(
            [
                f"path: {root.resolve()}",
                "train: images/train",
                "val: images/val",
                "test: images/test",
                "",
                "names:",
                "  0: volleyball",
                "",
            ]
        )
    )
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return data_yaml


def main() -> None:
    parser = argparse.ArgumentParser(description="Download VolleyVision ball labels and train a custom YOLO detector.")
    parser.add_argument("app_url", help="Your deployed VolleyVision URL, e.g. https://your-app.vercel.app")
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--imgsz", type=int, default=1280)
    parser.add_argument("--batch", type=int, default=4)
    parser.add_argument("--device", default="mps")
    parser.add_argument("--model", default="yolo11n.pt")
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parent.parent
    dataset_root = project_root / "datasets" / "volleyball-ball" / "generated"
    output_root = project_root / "runs" / "volleyball-ball"
    production_model = project_root / "apps" / "ai-worker" / "models" / "volleyball-ball.pt"

    print("[1/4] Reading saved ball labels from VolleyVision...")
    samples = fetch_samples(args.app_url)
    print(f"Found {len(samples)} saved volleyball labels.")

    print("[2/4] Building train/validation/test dataset...")
    data_yaml = prepare_dataset(samples, dataset_root)
    print(f"Dataset ready: {data_yaml}")

    print("[3/4] Training custom volleyball detector...")
    model = YOLO(args.model)
    results = model.train(
        data=str(data_yaml),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        patience=20,
        project=str(output_root),
        name="detector",
        exist_ok=True,
    )

    best = Path(results.save_dir) / "weights" / "best.pt"
    if not best.exists():
        raise RuntimeError(f"Training finished but best.pt was not found at {best}")

    print("[4/4] Installing best model into the AI worker...")
    production_model.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(best, production_model)
    print(f"Installed: {production_model}")
    print("Next: git add apps/ai-worker/models/volleyball-ball.pt && git commit && git push")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Download reviewed VolleyVision training labels from the deployed web app.

Usage:
    python scripts/export_training_feedback.py https://your-app.vercel.app

This exports feedback JSON records. The records reference the original video URL and
start/end timestamps, so a later training step can download only the short clips needed.
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python scripts/export_training_feedback.py https://your-app.vercel.app")
        return 2
    base = sys.argv[1].rstrip("/")
    with urllib.request.urlopen(f"{base}/api/training-feedback", timeout=30) as response:
        index = json.load(response)
    records = []
    for blob in index.get("blobs", []):
        try:
            with urllib.request.urlopen(blob["url"], timeout=30) as response:
                records.append(json.load(response))
        except Exception as exc:
            print(f"Skipping {blob.get('url')}: {exc}")
    output = Path("training-feedback.jsonl")
    with output.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")
    print(f"Wrote {len(records)} reviewed labels to {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

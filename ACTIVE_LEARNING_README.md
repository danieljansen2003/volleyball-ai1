# VolleyVision v0.3 – active-learning prototype

This version adds two major upgrades:

1. **Identity continuity:** TrackTrack + native ReID, a longer lost-track buffer, and a post-processing stitcher that merges short ID fragments using court position, time gap, and player scale.
2. **Action-learning loop:** the existing YOLO11 model also looks for COCO `sports ball` detections. Ball trajectory changes near a tracked player create *experimental* serve/pass/set/attack/dig/block candidates. Every candidate can be reviewed or corrected in the web UI and is saved as a JSON training example in Vercel Blob.

## Important limitation

The action candidates are a bootstrap system, not a trained volleyball action model. Generic COCO sports-ball detection will miss volleyballs in some frames and heuristic labels will be wrong sometimes. **Do not use unreviewed action labels as stats.** The purpose of this version is to accelerate labeling so that corrected examples can become a real volleyball-specific training set.

Do not retrain neural weights after every single correction. That causes instability and catastrophic forgetting. Collect reviewed labels continuously, then retrain/version a model in batches (for example after 50–200 new reviewed contacts), validate it against a held-out set, and only promote it if metrics improve.

## Deploy

Keep your existing `apps/ai-worker/yolo11n.pt` if it is already in the repo. If it is missing, the worker will ask Ultralytics to download the official YOLO11n weights on startup.

```bash
cd ~/Documents/volleyball-ai1
python3.11 -m py_compile \
  apps/ai-worker/app/main.py \
  apps/ai-worker/app/player_tracker.py \
  apps/ai-worker/app/action_detector.py \
  apps/ai-worker/app/schemas.py

cd apps/web
npm install
npm run build
cd ../..

git add .
git commit -m "Add occlusion ReID and active learning action review"
git push
```

Render and Vercel should redeploy automatically.

## Review workflow

1. Upload a clip.
2. Calibrate the four court corners.
3. Run AI.
4. Inspect stable player IDs and the yellow BALL overlay.
5. Review each action candidate in **AI action review**.
6. Correct action/player/outcome and press **Approve / save**.
7. Missed actions can be added with **Add a missed action**.
8. Each approved or manual label is written to `training-feedback/...json` in Vercel Blob.

The feedback index is available at `/api/training-feedback` on your deployed web app.

## Export labels

```bash
python scripts/export_training_feedback.py https://YOUR-APP.vercel.app
```

This creates `training-feedback.jsonl`. Each record contains the original video URL, clip timestamps, model prediction, corrected label, court calibration, track id, and engineered motion features.

## Recommended next training step

Once you have enough reviewed examples, train a dedicated volleyball **ball detector** first. Generic COCO `sports ball` detection is the main bottleneck for reliable touches. After that, train an action classifier using short contact-centered clips or pose/ball trajectory features. Keep a fixed validation set so "learning" means measured improvement rather than simply fitting the latest clips.

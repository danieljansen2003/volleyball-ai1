# VolleyVision built-in volleyball training workflow

This version replaces the CVAT dependency for ball labels.

## What changed

- `Label volleyball` mode is built into the video player.
- Saving a box captures the exact paused video frame and stores:
  - the JPG frame,
  - a YOLO-format `.txt` label,
  - JSON metadata,
  in Vercel Blob under `ball-training/`.
- `/api/ball-labels` shows the number of saved training samples.
- `scripts/train_ball_model.py` downloads the saved samples, makes a deterministic 70/20/10 train/validation/test split, trains YOLO, and installs the resulting model at `apps/ai-worker/models/volleyball-ball.pt`.
- The AI worker no longer relies on generic COCO `sports ball` detections. Once `volleyball-ball.pt` exists, it automatically uses your custom volleyball model.

## Deploy the labeling version

From the repo root:

```bash
git add .
git commit -m "Add built in volleyball labeling and training pipeline"
git push
```

Wait for Vercel and Render to redeploy.

## Labeling workflow

1. Upload a video as usual.
2. Click **Label volleyball**.
3. Scrub to a frame where the volleyball is visible and pause.
4. Drag a tight rectangle around the ball.
5. Click **Save volleyball label**.
6. Move to another useful frame and repeat.

The `Ball training samples` card shows the saved sample count.

Aim for at least 200 diverse labels before judging the detector. 500+ is a much better first production dataset.

## Train/retrain

Use the Python 3.11 AI environment from the repo root:

```bash
apps/ai-worker/.venv/bin/python scripts/train_ball_model.py https://YOUR-VERCEL-APP.vercel.app
```

The script automatically:

1. downloads the saved ball-training samples,
2. builds `datasets/volleyball-ball/generated/`,
3. splits train/val/test,
4. trains at 1280px,
5. copies the best model to `apps/ai-worker/models/volleyball-ball.pt`.

Then deploy the model:

```bash
git add apps/ai-worker/models/volleyball-ball.pt
git commit -m "Deploy trained volleyball detector"
git push
```

Render will load the custom model on startup. `/health` should report `volleyvision-ball-training-v0.4` after the new worker deploys.

## Important

Do not label frames where you cannot confidently locate the ball. Keep boxes tight. Include motion blur, far-side balls, near-player contacts, ceiling/background clutter, and different rally phases.

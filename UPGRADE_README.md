# VolleyVision AI - Background Tracking Upgrade

This source bundle replaces the timeout-prone synchronous analysis flow with a background-job workflow and makes the real YOLO/ByteTrack output visible over the video.

## What changed

- `apps/ai-worker/app/main.py`
  - adds `POST /jobs/analyze`
  - adds `GET /jobs/{job_id}`
  - runs one AI analysis at a time in a background worker thread
  - keeps the old synchronous `/analyze` endpoint only for compatibility/debugging
- `apps/ai-worker/app/player_tracker.py`
  - keeps court filtering
  - reports frame-by-frame progress to the background job
- `apps/web/app/api/analyze/route.ts`
  - POST starts a job and returns immediately
  - GET polls a job by `job_id`
  - removes the old 55-second wait on one giant request
- `apps/web/app/page.tsx`
  - removes generated/fake rally actions from upload
  - shows AI job progress
  - polls until the background job is complete
  - draws real player bounding boxes and ByteTrack IDs over the video
  - persists only a small tracking summary in localStorage
  - keeps manual touch annotation clearly separated from AI output

## Important truth about touch recognition

This upgrade does **not** pretend to recognize serve, receive, set, attack, dig, or block. The current model detects/tracks people only. Accurate volleyball touch recognition requires a trained ball detector plus a temporal/action model. Manual touch labels remain available so you can build training data without fabricating AI results.

## Replace your current source

The easiest approach is to copy the files from this bundle over your project, preserving your deployment environment variables.

Do **not** copy `.env.local` from an old ZIP into Git. This bundle intentionally omits it.

## Local checks

From the repository root:

```bash
source apps/ai-worker/.venv/bin/activate
python -m py_compile \
  apps/ai-worker/app/main.py \
  apps/ai-worker/app/player_tracker.py \
  apps/ai-worker/app/schemas.py
```

Then test the web app on your Mac:

```bash
cd apps/web
npm install
npm run dev
```

## Deploy

Commit and push:

```bash
git add apps/ai-worker/app/main.py \
        apps/ai-worker/app/player_tracker.py \
        apps/web/app/api/analyze/route.ts \
        apps/web/app/page.tsx \
        UPGRADE_README.md

git commit -m "Add background AI jobs and tracking overlay"
git push
```

Render should redeploy the AI worker and Vercel should redeploy the web app.

## Expected Render health response

After deployment, `/health` should show a model version similar to:

```json
{
  "ok": true,
  "model_version": "court-player-tracker-jobs-v0.2",
  "tracking_device": "cpu"
}
```

## Expected user flow

1. Upload video.
2. Wait for Vercel Blob upload to finish.
3. Set four court corners.
4. Confirm court.
5. Click **Run AI worker**.
6. The browser immediately receives a job ID.
7. Progress updates while Render processes the video.
8. When complete, green boxes and `ID #` labels appear over tracked players.

## Prototype limitation

Jobs are stored in Render process memory. They survive normal long inference requests but are lost if the Render process restarts/redeploys. For full production/full-match processing, move jobs/results to Redis/Postgres and store large tracking artifacts in object storage instead of returning every frame through JSON.

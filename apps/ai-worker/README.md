# VolleyVision AI Worker

This is the backend where real computer vision belongs. Do not run YOLO, ByteTrack, EasyOCR, or MMAction2 inside the Vercel frontend.

## What this worker does now

- Accepts a Vercel Blob video URL
- Optionally downloads/samples the video
- Creates conservative rally segments using motion changes
- Returns volleyball-shaped events back to the web app
- Avoids fake actions before play starts

## Run locally

```powershell
cd apps\ai-worker
py -3.11 -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 9000
```

Health check:

```text
http://localhost:9000/health
```

## Connect web app locally

Create `apps/web/.env.local`:

```env
AI_WORKER_URL=http://localhost:9000
```

Restart the web app.

## Deploy later

Deploy this worker to Render, Railway, Fly.io, RunPod, Modal, or another backend host. Then set this in Vercel:

```env
AI_WORKER_URL=https://your-ai-worker-url.com
```

## Next real AI upgrades

Add these in order:

1. YOLO player/ball detector
2. ByteTrack player tracking
3. EasyOCR jersey reading
4. MMAction2 action classification
5. Save coach corrections as training data

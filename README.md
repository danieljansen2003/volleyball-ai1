# VolleyVision AI - Vercel Blob + AI Worker Starter

This version keeps the Next.js app on Vercel, stores full-match videos in Vercel Blob, and adds a separate AI worker backend where real computer vision belongs.

## What changed

- `apps/web`: Vercel frontend and Blob upload UI
- `apps/web/app/api/analyze/route.ts`: proxy endpoint that calls the AI worker
- `apps/ai-worker`: FastAPI backend starter for video analysis
- conservative rally detector that avoids fake serve/pass/set/attack labels before training
- Dockerfile and local run instructions

## Architecture

```text
Vercel Web App
  -> uploads video to Vercel Blob
  -> sends Blob URL to AI Worker
  -> AI Worker returns rally/touch data
  -> Web app displays live tracker + correction tools
```

## Run web locally

```powershell
cd apps\web
npm install --registry=https://registry.npmjs.org/
npm run dev
```

## Run AI worker locally

Use Python 3.11.

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

## Connect the web app to local AI worker

Create `apps/web/.env.local`:

```env
AI_WORKER_URL=http://localhost:9000
```

Restart the web app.

## Deploying

### Vercel frontend

Keep Vercel settings:

```text
Root Directory: apps/web
Framework: Next.js
Build Command: npm run build
Install Command: npm install --registry=https://registry.npmjs.org/
Output Directory: blank
```

Environment variables needed in Vercel:

```env
BLOB_READ_WRITE_TOKEN=...
AI_WORKER_URL=https://your-deployed-ai-worker.com
```

### AI Worker backend

Deploy `apps/ai-worker` to Render, Railway, Fly.io, RunPod, Modal, or another backend service.

For 15 GB matches, do not expect a small CPU worker to download and process the whole video quickly. The starter worker limits downloads with:

```env
MAX_VIDEO_DOWNLOAD_MB=2048
```

Increase only on a machine with enough disk/network capacity. For production, add chunked processing and GPU workers.

## Next model upgrades

Do this in order:

1. Train YOLO player/ball detection from CVAT labels
2. Add ByteTrack for player tracking
3. Add EasyOCR jersey reading
4. Train MMAction2 for serve/pass/set/attack/block/dig
5. Save manual corrections as training data

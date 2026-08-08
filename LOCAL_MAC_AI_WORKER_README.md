# VolleyVision Local Mac AI Worker

This version keeps Vercel as the web app, video/blob store, job queue, and result store. Heavy YOLO/PyTorch inference runs on your Mac using Apple MPS instead of Render Free.

## One-time setup

1. In Vercel, add an environment variable named `LOCAL_AI_WORKER_TOKEN`. Generate a value on your Mac with:

   ```bash
   openssl rand -hex 32
   ```

   Copy the output into Vercel for Production, then redeploy the web app.

2. In the project root, make sure the local secret file is ignored by Git, then create it:

   ```bash
   grep -qxF ".env.local-worker" .gitignore || echo ".env.local-worker" >> .gitignore
   cp .env.local-worker.example .env.local-worker
   ```

   Edit `.env.local-worker`. Set `LOCAL_AI_WORKER_TOKEN` to the exact same value you put in Vercel. `VOLLEYVISION_URL` should be your deployed Vercel app URL.

3. Make sure your local model files exist:

   ```text
   apps/ai-worker/yolo11n.pt
   apps/ai-worker/models/volleyball-ball.pt
   ```

## Run the worker

From the project root:

```bash
apps/ai-worker/.venv/bin/python scripts/local_ai_worker.py
```

Leave that terminal running while you use VolleyVision. Then click **Run AI worker** in the web app. The web app queues the job; your Mac picks it up, downloads the Vercel Blob video, runs player + custom volleyball inference locally, and uploads progress/results back to Vercel.

Expected terminal flow:

```text
VolleyVision local AI worker
...
Processing job ...
  3% Downloading video
  ... Tracking frame ...
 95% Inferring volleyball contacts
Uploading result in ... chunk(s)...
Job ... complete.
```

## Render

Render no longer needs to run heavy inference for normal web-app jobs. You can leave the Render service online as a lightweight health/debug endpoint, or stop it while developing. `/api/analyze` on Vercel no longer proxies to `AI_WORKER_URL`.

## Why result chunks exist

Tracking results can become several MB for longer matches. The local worker uploads the JSON in small chunks so a large result does not hit Vercel request-body limits. The browser still polls `/api/analyze?job_id=...`; the server reconstructs the result after completion.

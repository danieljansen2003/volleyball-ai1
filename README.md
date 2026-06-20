# VolleyVision AI - Vercel Blob Fast Upload Build

This version uploads match videos to Vercel Blob and improves the upload/playback experience:

- Uses the selected local file for instant playback while the cloud upload runs.
- Tracks real upload progress from `@vercel/blob/client`.
- Shows upload speed and uploaded/total bytes.
- Keeps cloud URL metadata only in browser localStorage.
- Keeps videos out of GitHub and Vercel builds.
- Uses `preload="metadata"` so remote Blob videos start loading metadata instead of trying to load the full file.

## Required Vercel setup

Your Vercel project must have these environment variables:

- `BLOB_READ_WRITE_TOKEN`
- `BLOB_STORE_ID`
- `BLOB_WEBHOOK_PUBLIC_KEY`

When connecting Blob storage, check **Add a read-write token env var to this connection**.

## Deploy

```powershell
cd apps\web
npm install --registry=https://registry.npmjs.org/
cd ..\..
git add .
git commit -m "Improve Blob upload progress and playback"
git push
```

Redeploy on Vercel after pushing.

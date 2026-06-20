# VolleyVision AI - Blob Upload + First Serve Marker

This build keeps full-match videos out of Git and out of browser storage by uploading video files to Vercel Blob.

## New fixes

- Video preview starts immediately from the local selected file while the Blob upload continues.
- Upload progress is monotonic, so the progress bar does not jump backward or restart when large-file upload chunks report progress.
- The app no longer generates fake volleyball actions during pre-game standing-around footage.
- After upload, scrub the video to the first real serve and click **Mark first serve here**.
- Rally/touch sequences are generated only after the marked first serve.
- The live tracker now shows "Between touches / dead time" instead of pretending there is an action happening.

## Required Vercel setting

Your project must have this environment variable:

```text
BLOB_READ_WRITE_TOKEN
```

Connect your Vercel Blob store to the project and check **Add a read-write token env var to this connection**.

## Deploy

```powershell
cd apps\web
npm install --registry=https://registry.npmjs.org/
cd ..\..
git add .
git commit -m "Improve upload progress and first serve tracking"
git push
```

Then redeploy in Vercel.

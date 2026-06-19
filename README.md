# VolleyVision AI - Vercel Blob Upload Build

This version uploads full match videos to **Vercel Blob** instead of browser IndexedDB or local backend storage.

## What changed

- Videos upload directly from the browser to Vercel Blob using `@vercel/blob/client`.
- The app saves only match metadata and the Blob video URL in browser localStorage.
- Videos are not committed to GitHub and are not included in Vercel builds.
- Added API routes:
  - `apps/web/app/api/blob-upload/route.ts`
  - `apps/web/app/api/blob-delete/route.ts`
- Added `.npmrc` files to force the public npm registry.
- Removed package-lock files so you can regenerate a clean lockfile locally.

## Required Vercel setup

1. Create/connect a Vercel Blob store to the Vercel project.
2. Make sure the project has `BLOB_READ_WRITE_TOKEN` in Environment Variables.
3. Redeploy with existing build cache disabled.

## Local setup

```bash
cd apps/web
npm install --registry=https://registry.npmjs.org/
npm run dev
```

## Push steps

```bash
git add .
git commit -m "Add Vercel Blob video uploads"
git push
```

Then redeploy on Vercel with **Use Existing Build Cache** turned off.

## Note

The current AI event detection is still a browser-side estimator. Real action/player recognition requires a separate backend worker with CV models.

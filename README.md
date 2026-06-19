# VolleyVision AI - Safe Video Storage Build

This build is designed to avoid the Git/Vercel problems caused by generated video files being added to Source Control.

## What changed

- Videos are saved safely in browser IndexedDB in the Vercel/browser version.
- Video files are **not** saved into the Git repository.
- `.gitignore` blocks uploads, clips, databases, build folders, node modules, and common video formats.
- The app limits the browser video library to keep production from slowing down:
  - 750 MB max per video
  - 2 GB max total browser storage
  - 8 saved videos max
- Removing a video deletes it from browser storage too.
- Added `scripts/clean-git-generated-files.ps1` for cleanup if generated files ever appear in Source Control again.

## Run locally

```powershell
cd apps/web
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

## Deploy on Vercel

Use these Vercel settings:

```text
Root Directory: apps/web
Framework Preset: Next.js
Build Command: npm run build
Output Directory: blank
Install Command: npm install
```

## Safe Git workflow

Before committing, check:

```powershell
git status
```

You should **not** see:

```text
apps/api/storage/
node_modules/
.next/
*.mp4
*.db
```

If generated files show up, run:

```powershell
.\scripts\clean-git-generated-files.ps1
git commit -m "Stop tracking generated files"
git push
```

## Important production note

Browser IndexedDB is safe for Vercel because it does not push videos into Git or Vercel builds. It is good for demos and personal use.

For a real team production app where players/coaches need videos saved across devices/accounts, connect cloud object storage later:

- Vercel Blob
- Cloudflare R2
- AWS S3
- Supabase Storage

Do not store uploaded videos directly in GitHub or inside the Vercel deployment bundle.

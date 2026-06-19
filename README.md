# VolleyVision AI - Vercel Browser Mode

This version is designed to work directly on Vercel without a separate FastAPI backend.

## What works on Vercel

- Upload a video in the browser
- Upload/progress bar
- Match list for the current browser session
- Delete/remove videos
- Clickable rally breakdown rows
- Jump video to event timestamps
- Preview Top 5 highlight playback
- Preview rally-only playback that skips dead time
- Roster/body-build hints
- Estimated player assignment across all roster players
- Manual tags at the current video time

## Important limitation

Because this runs on Vercel frontend only, videos are not saved permanently. They stay in the current browser session through object URLs. Refreshing the page clears uploaded videos.

For permanent cloud uploads, real FFmpeg-generated MP4 exports, true player tracking, jersey OCR, and trained volleyball AI, deploy the FastAPI backend separately on Render, Railway, or Fly.io and connect it with `NEXT_PUBLIC_API_URL`.

## Vercel settings

Set the Vercel project settings to:

- Framework Preset: Next.js
- Root Directory: `apps/web`
- Install Command: `npm install`
- Build Command: `npm run build`
- Output Directory: leave blank

## Local run

```bash
cd apps/web
npm install
npm run dev
```

Then open:

```text
http://localhost:3000
```

## Version 3 updates

This Vercel browser-mode update adds:

- Rally objects with multiple touches/actions inside each rally
- Serve receive -> set -> attack -> block/dig/cover sequences
- Player assignment based on roster role/body-build hints
- Live event tracker that follows the video time
- Auto-scrolling highlighted event row as the video plays
- Click-to-jump for each touch and rally

Note: this is still browser-mode estimation. Real recognition of exact player/action from film requires a deployed computer vision backend using player detection, tracking, pose/ball detection, and jersey OCR.

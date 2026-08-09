# VolleyVision local-training v8

This is an additive upgrade to the current local-Mac-worker version. It intentionally keeps the current player tracker, custom volleyball model, contact detector, UI review flow, and cloud deployment path.

## What changes

- **Local training mode:** localhost uploads, videos, AI jobs, AI results, ball labels, and action-review labels stay under `storage/local/` on the Mac. No Vercel Blob calls are required for normal local training.
- **Cloud mode remains intact:** when `VV_MODE` is not `local`, `/api/analyze` continues using the existing Vercel Blob queue/result path.
- **Always-on local app:** `launchd` starts both the Next.js dev server and the Mac AI worker at login, so VS Code/Terminal is not required before clicking Analyze.
- **Faster action learning without replacing the detector:** the existing action/contact detector still finds candidates. `action_learner.py` uses reviewed labels as a conservative nearest-neighbor memory and only overrides pass/set/attack/dig/block/serve when nearby reviewed examples agree strongly.
- **0.75-second motion window:** the learner adds ball motion before/after each contact (speed, direction change, vertical flip, location, and player-ball distance when available). Reviewed candidates save those features, so the next video can benefit immediately.
- **Local ball dataset:** new ball boxes save as standard YOLO images/labels locally. `train_ball_model_local.py` can retrain the existing volleyball model without Blob.

## Local files

`storage/local/videos/` - uploaded training videos

`storage/local/jobs/` - local queue documents

`storage/local/results/` - AI result JSON

`storage/local/ball-labels/` - ball images + YOLO labels + metadata

`storage/local/training-feedback/` - reviewed action labels

`storage/local/logs/` - web/worker service logs

None of these should be committed.

## Action-learning behavior

This is deliberately conservative. It does not replace the existing action detector. A candidate is only relabeled when the local review-memory learner has enough examples and enough agreement. Defaults:

- minimum usable reviewed feature examples: 8
- nearest reviewed examples: 7
- minimum confidence: 0.62
- minimum same-label support: 2

These can later be tuned with `VV_ACTION_MIN_EXAMPLES`, `VV_ACTION_K`, `VV_ACTION_MIN_CONFIDENCE`, and `VV_ACTION_MIN_SUPPORT` in `.env.local-worker`.

Every local reviewed label is visible at `http://localhost:3000/api/local-training-feedback`.

## Switching worker target

Local training (no Blob queue operations):

```bash
./scripts/use_local_worker.sh
```

Deployed Vercel app (uses the cloud queue/Blob and therefore its quota):

```bash
./scripts/use_cloud_worker.sh
```

The web app itself stays cloud-mode on Vercel because `apps/web/.env.local` is gitignored and exists only on the Mac.

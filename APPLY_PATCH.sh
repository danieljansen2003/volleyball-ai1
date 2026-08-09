#!/bin/zsh
set -euo pipefail
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HOME/Documents/volleyball-ai1"
if [[ ! -d "$ROOT/apps/web/app" || ! -d "$ROOT/apps/ai-worker/app" ]]; then
  echo "Could not find VolleyVision at $ROOT"; exit 1
fi
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$ROOT/.vv-backups/local-training-v8-$STAMP"
mkdir -p "$BACKUP"
for f in apps/web/app/page.tsx apps/web/app/api/analyze/route.ts scripts/local_ai_worker.py; do
  if [[ -f "$ROOT/$f" ]]; then mkdir -p "$BACKUP/$(dirname "$f")"; cp "$ROOT/$f" "$BACKUP/$f"; fi
done

echo "Backup created: $BACKUP"
cd "$SRC_DIR"
find apps scripts -type f | while read -r f; do
  mkdir -p "$ROOT/$(dirname "$f")"
  cp "$SRC_DIR/$f" "$ROOT/$f"
done
chmod +x "$ROOT/scripts/"*.sh "$ROOT/scripts/"*.py 2>/dev/null || true
for item in '.env.local-worker' 'apps/web/.env.local' 'storage/local/' 'runs/' '.vv-backups/'; do
  grep -qxF "$item" "$ROOT/.gitignore" || echo "$item" >> "$ROOT/.gitignore"
done

echo "Patch copied successfully."
echo "Next: cd $ROOT && ./scripts/install_local_services.sh"

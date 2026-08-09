#!/bin/zsh
set -euo pipefail
ROOT="$HOME/Documents/volleyball-ai1"
FILE="$ROOT/.env.local-worker"
python3 - "$FILE" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); lines=p.read_text().splitlines() if p.exists() else []; out=[]; seen=False
for line in lines:
    if line.startswith('VOLLEYVISION_URL='):
        out.append('VOLLEYVISION_URL=http://127.0.0.1:3000'); seen=True
    else: out.append(line)
if not seen: out.insert(0,'VOLLEYVISION_URL=http://127.0.0.1:3000')
p.write_text('\n'.join(out)+'\n')
PY
launchctl kickstart -k "gui/$(id -u)/com.volleyvision.aiworker" || true
echo "AI worker now targets localhost. No Vercel Blob queue operations."

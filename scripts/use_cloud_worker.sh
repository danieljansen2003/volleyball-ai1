#!/bin/zsh
set -euo pipefail
ROOT="$HOME/Documents/volleyball-ai1"
FILE="$ROOT/.env.local-worker"
if [[ ! -f "$FILE" ]]; then echo "Missing $FILE"; exit 1; fi
python3 - "$FILE" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); lines=p.read_text().splitlines(); out=[]; seen=False
for line in lines:
    if line.startswith('VOLLEYVISION_URL='):
        out.append('VOLLEYVISION_URL=https://volleyball-ai1-fm8y.vercel.app'); seen=True
    else: out.append(line)
if not seen: out.insert(0,'VOLLEYVISION_URL=https://volleyball-ai1-fm8y.vercel.app')
p.write_text('\n'.join(out)+'\n')
PY
launchctl kickstart -k "gui/$(id -u)/com.volleyvision.aiworker" || true
echo "AI worker now targets the deployed Vercel app. This can use Vercel Blob operations."

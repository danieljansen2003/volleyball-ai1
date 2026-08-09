#!/bin/zsh
set -euo pipefail
UID_NUM=$(id -u)
launchctl kickstart -k "gui/$UID_NUM/com.volleyvision.web" || true
launchctl kickstart -k "gui/$UID_NUM/com.volleyvision.aiworker" || true
echo "Restarted VolleyVision local web + AI services. Open http://localhost:3000"

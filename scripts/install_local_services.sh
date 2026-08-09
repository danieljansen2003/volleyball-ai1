#!/bin/zsh
set -euo pipefail
ROOT="$HOME/Documents/volleyball-ai1"
cd "$ROOT"
mkdir -p storage/local/logs storage/local/videos storage/local/jobs storage/local/results storage/local/training-feedback storage/local/ball-labels

TOKEN=""
if [[ -f .env.local-worker ]]; then TOKEN=$(grep '^LOCAL_AI_WORKER_TOKEN=' .env.local-worker | tail -1 | cut -d= -f2- || true); fi
if [[ -z "$TOKEN" ]]; then TOKEN=$(openssl rand -hex 32); fi
cat > .env.local-worker <<EOF
VOLLEYVISION_URL=http://127.0.0.1:3000
LOCAL_AI_WORKER_TOKEN=$TOKEN
LOCAL_AI_POLL_SECONDS=2
VV_PERSON_CONF=0.32
VV_BALL_CONF=0.08
VV_BALL_IMGSZ=1280
VV_ACTION_FEEDBACK_DIR=$ROOT/storage/local/training-feedback
EOF
cat > apps/web/.env.local <<EOF
VV_MODE=local
NEXT_PUBLIC_VV_MODE=local
LOCAL_AI_WORKER_TOKEN=$TOKEN
EOF
for item in '.env.local-worker' 'apps/web/.env.local' 'storage/local/' 'runs/'; do grep -qxF "$item" .gitignore || echo "$item" >> .gitignore; done

UID_NUM=$(id -u)
WEB_PLIST="$HOME/Library/LaunchAgents/com.volleyvision.web.plist"
AI_PLIST="$HOME/Library/LaunchAgents/com.volleyvision.aiworker.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$WEB_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.volleyvision.web</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>cd '$ROOT/apps/web' &amp;&amp; npm run dev</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$ROOT/storage/local/logs/web.log</string>
<key>StandardErrorPath</key><string>$ROOT/storage/local/logs/web-error.log</string>
</dict></plist>
EOF
cat > "$AI_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.volleyvision.aiworker</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>cd '$ROOT' &amp;&amp; '$ROOT/apps/ai-worker/.venv/bin/python' '$ROOT/scripts/local_ai_worker.py'</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$ROOT/storage/local/logs/ai-worker.log</string>
<key>StandardErrorPath</key><string>$ROOT/storage/local/logs/ai-worker-error.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$UID_NUM" "$WEB_PLIST" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM" "$AI_PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$WEB_PLIST"
launchctl bootstrap "gui/$UID_NUM" "$AI_PLIST"
launchctl kickstart -k "gui/$UID_NUM/com.volleyvision.web"
launchctl kickstart -k "gui/$UID_NUM/com.volleyvision.aiworker"
echo "VolleyVision local training mode installed."
echo "Open: http://localhost:3000"
echo "Logs: storage/local/logs/"
echo "No Vercel Blob operations are used while NEXT_PUBLIC_VV_MODE=local."

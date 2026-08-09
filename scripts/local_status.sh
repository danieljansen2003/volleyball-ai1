#!/bin/zsh
set -u
UID_NUM=$(id -u)
echo "--- web service ---"
launchctl print "gui/$UID_NUM/com.volleyvision.web" 2>/dev/null | grep -E 'state =|pid =|last exit code' || echo "not installed"
echo "--- AI worker ---"
launchctl print "gui/$UID_NUM/com.volleyvision.aiworker" 2>/dev/null | grep -E 'state =|pid =|last exit code' || echo "not installed"
echo "--- recent AI log ---"
tail -20 "$HOME/Documents/volleyball-ai1/storage/local/logs/ai-worker.log" 2>/dev/null || true

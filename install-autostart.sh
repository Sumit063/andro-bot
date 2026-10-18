#!/bin/zsh
# Runs the hub automatically at login (launchd). Undo with: ./install-autostart.sh remove
# Note: under launchd macOS asks for permissions for python3 / cc-helper themselves (not Terminal),
# so you'll approve Screen & System Audio Recording, Input Monitoring and Automation once more.
set -e
DIR="${0:A:h}"
PLIST=~/Library/LaunchAgents/com.androbot.hub.plist
LABEL=com.androbot.hub

if [ "$1" = "remove" ]; then
  launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
  rm -f "$PLIST"
  echo "Autostart removed."
  exit 0
fi

mkdir -p ~/Library/LaunchAgents "$DIR/logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>$DIR/server.py</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardErrorPath</key><string>$DIR/logs/hub.log</string>
  <key>StandardOutPath</key><string>$DIR/logs/hub.log</string>
</dict>
</plist>
EOF
launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"
echo "Autostart installed. Logs: $DIR/logs/hub.log"

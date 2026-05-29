#!/bin/bash
# install_service.sh
# Installs the Browser MCP server as a macOS background service.
# It will start automatically on login and restart if it crashes.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"
VENV_PYTHON="$SERVER_DIR/venv/bin/python3"
SERVER_PY="$SERVER_DIR/server.py"
PLIST_LABEL="com.satisharps.browser-mcp"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
LOG_DIR="$HOME/Library/Logs/browser-mcp"

if [ ! -f "$VENV_PYTHON" ]; then
  echo "❌  venv not found. Run this first:"
  echo "    cd $SERVER_DIR && python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt"
  exit 1
fi

if [ ! -f "$SERVER_PY" ]; then
  echo "❌  server.py not found at $SERVER_PY"
  exit 1
fi

mkdir -p "$LOG_DIR"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$VENV_PYTHON</string>
    <string>$SERVER_PY</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/server.error.log</string>
  <key>WorkingDirectory</key>
  <string>$SERVER_DIR</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo ""
echo "✅  Browser MCP service installed and started!"
echo ""
echo "   Server starts automatically on every login."
echo "   Logs: $LOG_DIR/server.log"
echo ""
echo "   Stop:  launchctl unload ~/Library/LaunchAgents/$PLIST_LABEL.plist"
echo "   Start: launchctl load   ~/Library/LaunchAgents/$PLIST_LABEL.plist"
echo "   Logs:  tail -f $LOG_DIR/server.log"

#!/usr/bin/env bash
# ============================================================
# Browser MCP (Node) — install as an always-on background service (macOS launchd)
# ============================================================
# Runs server.js in HTTP mode so the Chrome extension always has a bridge on
# :9009, and Claude Code / Cowork / claude.ai chat can all share it over HTTP
# on :8765 — even before any Claude client starts.
#
# Usage:
#   ./install-service.sh           # install & start
#   ./install-service.sh remove    # stop & uninstall
# ============================================================
set -euo pipefail

LABEL="com.satisharps.browser-mcp-node"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_JS="${SCRIPT_DIR}/server.js"
HTTP_PORT="${HTTP_PORT:-8765}"

if [[ "${1:-}" == "remove" ]]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "🗑️  Removed ${LABEL}"
  exit 0
fi

NODE_BIN="$(command -v node)"
[[ -z "$NODE_BIN" ]] && { echo "❌ node not found in PATH"; exit 1; }
[[ -f "$SERVER_JS" ]] || { echo "❌ server.js not found at $SERVER_JS"; exit 1; }

# Ensure dependencies are installed.
[[ -d "${SCRIPT_DIR}/node_modules/@modelcontextprotocol" ]] || (cd "$SCRIPT_DIR" && npm install)

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${SERVER_JS}</string>
        <string>--http</string>
        <string>--port</string>
        <string>${HTTP_PORT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/browser-mcp-node.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/browser-mcp-node.err.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "🚀  Installed & started ${LABEL}"
echo "    Node       : ${NODE_BIN}"
echo "    Extension  : ws://localhost:9009"
echo "    MCP (HTTP) : http://localhost:${HTTP_PORT}/mcp"
echo "    Logs       : /tmp/browser-mcp-node.log"
echo
echo "Register with Claude Code:"
echo "    claude mcp add --transport http browser http://localhost:${HTTP_PORT}/mcp"

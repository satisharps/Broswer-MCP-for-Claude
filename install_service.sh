#!/bin/bash
# install_service.sh
# Sets up the Browser MCP for Claude Code CLI, Cowork desktop, and Claude.ai chat.
#
# How each interface works:
#   Claude Code CLI  — stdio: Claude auto-starts the server as a subprocess
#   Cowork desktop   — stdio: same, Claude auto-starts it (user-scoped MCP)
#   Claude.ai chat   — SSE:  you run the server manually + expose via ngrok

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"
VENV_PYTHON="$SERVER_DIR/venv/bin/python3"
SERVER_PY="$SERVER_DIR/server.py"

# ── Checks ────────────────────────────────────────────
if [ ! -f "$VENV_PYTHON" ]; then
  echo "❌  venv not found. Run this first:"
  echo "    cd $SERVER_DIR && python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt"
  exit 1
fi

if [ ! -f "$SERVER_PY" ]; then
  echo "❌  server.py not found at $SERVER_PY"
  exit 1
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Browser MCP — Setup for all Claude interfaces"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: Register at user scope for Claude Code + Cowork ──
echo "▶  Registering stdio MCP (Claude Code CLI + Cowork)..."
# Remove old project-scoped or wrongly-typed registrations
claude mcp remove browser     2>/dev/null || true
claude mcp remove browser-sse 2>/dev/null || true
# Add at user scope — Claude auto-starts this as a subprocess
claude mcp add --scope user browser "$VENV_PYTHON" "$SERVER_PY"
echo "   ✅  'browser' registered (user scope, stdio)"
echo ""

# ── Step 2: Instructions for Claude.ai chat ──────────────────
echo "▶  For Claude.ai chat (needs a public URL):"
echo ""
echo "   1. Install ngrok (if not already):"
echo "      brew install ngrok"
echo ""
echo "   2. Start the SSE server:"
echo "      cd $SERVER_DIR"
echo "      source venv/bin/activate"
echo "      python server.py --transport sse --host 0.0.0.0 --port 8765"
echo ""
echo "   3. In a new terminal, expose it publicly:"
echo "      ngrok http 8765"
echo ""
echo "   4. Copy the https URL from ngrok and register:"
echo "      claude mcp add --scope claudeai browser-remote https://XXXX.ngrok.io/sse"
echo ""
echo "   5. In Claude.ai → Settings → Integrations — it will appear there."
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  ✅  Done! Next steps:"
echo ""
echo "  1. Restart the Claude desktop app (Cmd+Q then reopen)"
echo "  2. Flip the ⚡ toggle ON in Chrome"
echo "  3. Open Claude — the browser tools will be available"
echo ""
echo "  Verify: claude mcp list"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

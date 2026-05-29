# Claude Browser MCP

Connects your Chrome browser to Claude (Claude Code / Cowork / claude.ai chat) via the
MCP protocol. Claude can navigate, click, type, take screenshots, read pages, monitor
network traffic, and control tabs — all from a conversation.

```
Claude ←── MCP (stdio or HTTP) ──→ server ←── WebSocket :9009 ──→ Chrome Extension
                                                                     └── browser APIs
```

There are **two interchangeable server implementations** — pick one:

| | Node.js (recommended) | Python (original) |
|---|---|---|
| Folder | [`server-node/`](server-node) | [`server/`](server) |
| Runtime | Node ≥ 18 | Python 3 + venv |
| Install | `npx browser-mcp-satisharps` | `pip install -r requirements.txt` |
| Transports | stdio **and** always-on HTTP daemon | stdio / SSE |
| Multi-client | ✅ one daemon shared by Code + Cowork + chat | one client at a time |

Both speak the same WebSocket protocol to the **same Chrome extension** and expose the
**same 25 tools**. They cannot run at the same time (both want port `9009`).

---

## Quick start (Node.js — recommended)

### 1 · Load the Chrome extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the [`extension/`](extension) folder
4. Click the ⚡ icon and toggle **Enable MCP ON**

### 2 · Register the server with Claude Code

```bash
claude mcp add browser -- npx browser-mcp-satisharps     # after npm publish
# or, run from this checkout without publishing:
claude mcp add browser -- node /absolute/path/to/browser-mcp/server-node/server.js
```

### 3 · (Optional) Always-on daemon for Code + Cowork + chat

To share one browser bridge across every Claude client at once:

```bash
cd server-node
./install-service.sh        # launchd service: WebSocket :9009 + MCP HTTP :8765
```

Then register the HTTP endpoint and verify:

```bash
claude mcp add --transport http browser http://localhost:8765/mcp
curl -s http://localhost:8765/health
# {"status":"ok","extensionConnected":true,"mcpEndpoint":"/mcp"}
```

See [`server-node/README.md`](server-node/README.md) for Cowork, claude.ai chat,
publishing, and full details.

---

## Quick start (Python — original)

```bash
cd browser-mcp/server
pip install -r requirements.txt
claude mcp add browser python3 /absolute/path/to/browser-mcp/server/server.py
```

Then load the extension (above) and toggle it ON. Claude starts `server.py`
automatically when you open a chat.

---

## Available MCP tools

| Tool | What it does |
|---|---|
| `navigate(url)` | Go to a URL, waits for load |
| `go_back / go_forward` | Browser history navigation |
| `reload_page` | Reload current tab |
| `get_page_info` | URL + title of current tab |
| `get_page_text` | Visible text of the page (clean) |
| `get_page_html` | Full HTML source (truncated at 50 k) |
| `take_screenshot` | PNG screenshot Claude can **see** |
| `find_elements(selector)` | Find DOM elements by CSS selector |
| `get_element_text(selector)` | Read an element's text |
| `get_element_attribute(selector, attr)` | Read an HTML attribute |
| `click_element(selector)` | Click an element |
| `type_text(selector, text)` | Type into an input / textarea |
| `wait_for_element(selector)` | Wait for dynamic content |
| `scroll_page(direction)` | up / down / top / bottom |
| `execute_javascript(code)` | Run JS on the page |
| `list_tabs` | All open tabs with IDs |
| `switch_tab(tab_id)` | Focus a tab |
| `new_tab(url?)` | Open a new tab |
| `close_tab(tab_id)` | Close a tab |
| `duplicate_tab` | Duplicate current or given tab |
| `get_network_requests` | Recent XHR / fetch / resources |
| `get_console_logs` | console.log / warn / error messages |
| `clear_network_requests` | Clear captured requests |
| `clear_console_logs` | Clear captured logs |

---

## Example prompts

```
Go to github.com, find the search box, type "MCP server", and press enter.
```

```
Take a screenshot of the current page and tell me what you see.
```

```
Open a new tab, navigate to news.ycombinator.com, and summarise the top 5 stories.
```

```
Click the "Sign in" button and fill in the email field with test@example.com.
```

```
Check the browser console for any JavaScript errors on this page.
```

---

## Notes

- **No debugger banner** — the extension uses `chrome.webRequest` + MAIN-world script
  injection for network/console monitoring, so Chrome never shows the "DevTools is
  debugging" banner.

- **Port** — The WebSocket bridge uses `localhost:9009`. Only one server (Node *or*
  Python) can own it at a time. The Node HTTP daemon also serves MCP on `:8765`.

- **Service worker lifetime** — Chrome MV3 service workers can sleep after ~30 s of
  inactivity. The extension uses `chrome.alarms` to wake itself and reconnect
  automatically.

- **Security** — The server only accepts connections from `localhost`. Do not expose
  port 9009 (or the HTTP 8765 port) to the network.

- **`execute_javascript`** is blocked on strict-CSP sites (no `unsafe-eval`); use the
  dedicated DOM tools there. **`take_screenshot`** may return "image readback failed"
  on an unpainted tab — retry once.

---

## Project layout

```
browser-mcp/
├── extension/
│   ├── manifest.json       Chrome extension manifest (MV3)
│   ├── background.js       Service worker — WebSocket bridge + all commands
│   ├── content_relay.js    Relays page console logs to the background worker
│   ├── popup.html          Status UI shown when clicking the toolbar icon
│   └── popup.js            Reads connection state from chrome.storage
├── server-node/            Node.js server (recommended)
│   ├── server.js           MCP server — stdio + HTTP daemon, WebSocket bridge
│   ├── package.json        npm package: browser-mcp-satisharps
│   ├── install-service.sh  launchd installer for the always-on daemon
│   └── README.md           Full Node docs (Cowork, chat, publishing)
└── server/                 Python server (original)
    ├── server.py           FastMCP + WebSocket bridge
    └── requirements.txt     mcp[cli], websockets
```

# Claude Browser MCP

Connects your Chrome browser to Claude (Cowork / Claude Code) via the MCP protocol.
Claude can navigate, click, type, take screenshots, read pages, monitor network traffic,
and control tabs — all from a conversation.

```
Claude ←── stdio MCP ──→ server.py ←── WebSocket :9009 ──→ Chrome Extension
                                                              └── browser APIs
```

---

## Quick start

### 1 · Install Python dependencies

```bash
cd browser-mcp/server
pip install -r requirements.txt
```

### 2 · Load the Chrome extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `browser-mcp/extension` folder
5. You'll see the ⚡ Claude Browser MCP icon in your toolbar

### 3 · Register the MCP server with Claude

**Claude Code (CLI)**

```bash
claude mcp add browser python3 /absolute/path/to/browser-mcp/server/server.py
```

Or add manually to `~/.claude.json` (or your project's `.claude/mcp_servers.json`):

```json
{
  "mcpServers": {
    "browser": {
      "command": "python3",
      "args": ["/absolute/path/to/browser-mcp/server/server.py"]
    }
  }
}
```

**Claude Desktop**

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "browser": {
      "command": "python3",
      "args": ["/absolute/path/to/browser-mcp/server/server.py"]
    }
  }
}
```

Then restart Claude Desktop.

### 4 · Start a session

Claude starts `server.py` automatically when you open a chat.
Click the ⚡ extension icon — it should show **Connected** (green).

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

- **Debugger banner** — Chrome shows "DevTools is debugging Chrome" while the extension
  is attached. This is required for network and console monitoring. It disappears when
  you close all Chrome windows.

- **Port** — The WebSocket bridge uses `localhost:9009`. Change `WS_PORT` in both
  `background.js` and `server.py` if you need a different port.

- **Service worker lifetime** — Chrome MV3 service workers can sleep after ~30 s of
  inactivity. The extension uses `chrome.alarms` to wake itself every ~24 s and
  reconnect automatically.

- **Security** — The server only accepts connections from `localhost`. Do not expose
  port 9009 to the network.

---

## Project layout

```
browser-mcp/
├── extension/
│   ├── manifest.json     Chrome extension manifest (MV3)
│   ├── background.js     Service worker — WebSocket bridge + all commands
│   ├── popup.html        Status UI shown when clicking the toolbar icon
│   └── popup.js          Reads connection state from chrome.storage
└── server/
    ├── server.py         Python MCP server (FastMCP + WebSocket bridge)
    └── requirements.txt  mcp[cli], websockets
```

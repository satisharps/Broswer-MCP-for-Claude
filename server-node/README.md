# browser-mcp-satisharps

An [MCP](https://modelcontextprotocol.io) server that lets Claude — **Claude Code,
Cowork, and claude.ai chat** — drive your Chrome browser: navigate, click, type,
read pages, take screenshots, and monitor network/console. It bridges MCP to the
**Browser MCP Chrome extension** over a local WebSocket on port `9009`.

This is the Node.js rewrite of the original Python server, published so it can be
run directly with `npx` — no Python environment required. 25 tools, single file,
zero build step.

## Install

Add it to Claude Code:

```bash
claude mcp add browser npx browser-mcp-satisharps
```

Or run it standalone:

```bash
npx browser-mcp-satisharps
```

## How it works

The server always owns the WebSocket bridge on `ws://localhost:9009` that the
Chrome extension connects to. It can expose MCP to clients in two ways:

**stdio mode (default)** — `node server.js`

```
Claude Code  <--stdio (MCP)-->  server.js  <--WebSocket :9009-->  Chrome extension
```

The client spawns one server per session. Simplest, but only one client at a
time (each would otherwise fight over port 9009). Good for the `npx` quick start.

**HTTP mode (always-on daemon)** — `node server.js --http --port 8765`

```
Claude Code  ─┐
Cowork        ├─ HTTP /mcp :8765 ─► server.js ─ WebSocket :9009 ─► Chrome extension
claude.ai     ─┘
```

One long-running server owns `:9009` and serves MCP over Streamable HTTP on
`:8765`, so **Code, Cowork, and claude.ai chat can all share one browser bridge
at the same time**. This is the mode you want if you use more than one client.

Either way you need the companion Chrome extension installed and toggled **ON**.
The extension lives in the [`extension/`](../extension) folder of this repo.

## Requirements

- Node.js >= 18
- The Browser MCP Chrome extension installed and enabled

## Use with Code, Cowork, and claude.ai chat (always-on)

1. **Install the always-on service** (macOS launchd):

   ```bash
   cd server-node
   ./install-service.sh        # runs `server.js --http --port 8765` at login
   ```

   It owns `:9009` (extension) and `:8765` (MCP HTTP). Remove with
   `./install-service.sh remove`.

2. **Claude Code** — register the HTTP endpoint:

   ```bash
   claude mcp add --transport http browser http://localhost:8765/mcp
   ```

3. **Cowork** — add a remote/custom MCP server pointing at
   `http://localhost:8765/mcp` (Streamable HTTP).

4. **claude.ai chat** — chat needs a *public* URL. Tunnel `:8765` and add the
   public `/mcp` URL as a custom connector:

   ```bash
   ngrok http 8765
   # then use https://<id>.ngrok.app/mcp as the connector URL
   ```

5. **Toggle the Chrome extension ON.** Confirm everything is wired up:

   ```bash
   curl -s http://localhost:8765/health
   # {"status":"ok","extensionConnected":true,"mcpEndpoint":"/mcp"}
   ```

> Only one Browser MCP server can own port 9009. If you run the always-on
> service, do **not** also register the stdio command — they'll collide.

## Tools (25)

| Tool | What it does |
|---|---|
| `navigate(url)` | Go to a URL, waits for load |
| `go_back` / `go_forward` | Browser history navigation |
| `reload_page` | Reload the current tab |
| `get_page_info` | URL + title of the current tab |
| `get_page_text` | Visible text of the page (clean) |
| `get_page_html` | Full HTML source |
| `take_screenshot` | PNG screenshot Claude can **see** |
| `find_elements(selector, limit=20)` | Find DOM elements by CSS selector |
| `get_element_text(selector)` | Read an element's text |
| `get_element_attribute(selector, attribute)` | Read an HTML attribute |
| `click_element(selector)` | Click an element |
| `type_text(selector, text)` | Type into an input / textarea |
| `wait_for_element(selector, timeout=10s)` | Wait for dynamic content |
| `scroll_page(direction, amount=1)` | up / down / left / right / top / bottom |
| `execute_javascript(code)` | Run JS on the page |
| `list_tabs` | All open tabs with IDs |
| `switch_tab(tab_id)` | Focus a tab |
| `new_tab(url?)` | Open a new tab |
| `close_tab(tab_id)` | Close a tab |
| `duplicate_tab(tab_id)` | Duplicate a tab |
| `get_network_requests` | Recent requests captured for the tab |
| `clear_network_requests` | Clear captured requests |
| `get_console_logs` | console.log / warn / error messages |
| `clear_console_logs` | Clear captured logs |

## Example prompts

```
Go to example.com and tell me the page title.
Take a screenshot of the current page and describe what you see.
Find the search box, type "starter", and read the suggestions.
Open a new tab, go to news.ycombinator.com, and summarise the top 5 stories.
Check the browser console for any JavaScript errors on this page.
```

## Notes & limitations

- **One owner of port 9009.** Only one Browser MCP server (Node or the old Python
  one) can bind `:9009` at a time. If the extension shows "Disconnected", make sure
  no other server is holding the port.
- **`execute_javascript` and strict-CSP sites.** Pages that disallow `unsafe-eval`
  (many production apps) will reject `execute_javascript`. Use the dedicated tools
  (`find_elements`, `click_element`, `type_text`, …) on those sites instead.
- **`take_screenshot` occasionally returns "image readback failed."** This is a
  Chrome `captureVisibleTab` timing quirk when the tab isn't fully painted/focused;
  it generally succeeds on retry.
- **`type_text` doesn't press Enter.** It fires `input`/`change` events. To submit
  a form, click the submit button or navigate to the results URL.
- **localhost only.** The bridge binds to `localhost` — do not expose `:9009` or the
  HTTP `:8765` port to the network. For claude.ai chat, tunnel deliberately.

## Development

```bash
npm install
node server.js              # stdio mode
node server.js --http       # HTTP daemon mode on :8765 (add --port to change)
```

## Publishing

This package is published to the npm registry so it can be run with `npx`.

```bash
cd server-node

# 1. Check the name is still available (a 404 means it's free)
npm view browser-mcp-satisharps

# 2. Bump the version (npm refuses to republish the same version)
npm version patch        # or: minor / major

# 3. Preview exactly what will ship — should be 3 files
npm publish --dry-run

# 4. Publish publicly
npm publish
```

After publishing, anyone can add it to Claude Code with:

```bash
claude mcp add browser npx browser-mcp-satisharps
```

## License

MIT

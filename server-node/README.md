# browser-mcp-satisharps

An [MCP](https://modelcontextprotocol.io) server that lets Claude Code (and any MCP
client) drive your Chrome browser. It bridges the MCP stdio transport to the
**Browser MCP Chrome extension** over a local WebSocket on port `9009`.

This is the Node.js rewrite of the original Python server, published so it can be
run directly with `npx` — no Python environment required.

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

## Tools

Navigation: `navigate`, `go_back`, `go_forward`, `reload_page`

Page inspection: `get_page_info`, `get_page_text`, `get_page_html`, `take_screenshot`

Elements: `find_elements`, `get_element_text`, `get_element_attribute`,
`click_element`, `type_text`, `wait_for_element`, `scroll_page`, `execute_javascript`

Tabs: `list_tabs`, `switch_tab`, `new_tab`, `close_tab`, `duplicate_tab`

Network & console: `get_network_requests`, `clear_network_requests`,
`get_console_logs`, `clear_console_logs`

## Development

```bash
npm install
node server.js
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

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

```
Claude Code  <--stdio (MCP)-->  server.js  <--WebSocket :9009-->  Chrome extension
```

1. The server starts a WebSocket server on `ws://localhost:9009`.
2. The Browser MCP Chrome extension connects to it automatically.
3. Claude Code talks to the server over stdio and calls tools, which are forwarded
   to the extension and executed against the active tab.

You need the companion Chrome extension installed and active for the tools to work.
The extension lives in the [`extension/`](../extension) folder of this repo.

## Requirements

- Node.js >= 18
- The Browser MCP Chrome extension installed and enabled

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

## License

MIT

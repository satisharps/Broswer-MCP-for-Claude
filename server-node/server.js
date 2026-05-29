#!/usr/bin/env node
/**
 * Browser MCP Server (Node.js)
 * Connects Claude Code to Chrome via WebSocket + MCP stdio transport.
 *
 * - Starts a WebSocket server on port 9009 that the Chrome extension connects to.
 * - Exposes MCP tools over stdio using @modelcontextprotocol/sdk.
 *
 * Wire protocol (matches the existing Chrome extension):
 *   server -> extension: { id, action, params }
 *   extension -> server: { id, result } | { id, error }
 */
import { WebSocketServer } from "ws";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const PORT = 9009;
const REQUEST_TIMEOUT_MS = 30000;

// stdout is reserved for the MCP protocol — all logging goes to stderr.
function log(...args) {
  console.error(`${new Date().toISOString()} [browser-mcp]`, ...args);
}

// ============================================================
// WebSocket Bridge (Chrome Extension Connection)
// ============================================================

class BrowserBridge {
  constructor() {
    this.ws = null;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.requestId = 0;
  }

  nextId() {
    this.requestId += 1;
    return String(this.requestId);
  }

  setSocket(ws) {
    this.ws = ws;
  }

  isConnected() {
    return this.ws !== null && this.ws.readyState === this.ws.OPEN;
  }

  sendCommand(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(
          new Error(
            "Chrome extension not connected. Make sure the extension is installed and active."
          )
        );
        return;
      }

      const id = this.nextId();
      const message = { id, action, params: params || {} };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${action}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.ws.send(JSON.stringify(message));
        log(`Sent command: ${action} (id=${id})`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  handleResponse(data) {
    const id = data.id;
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (data.error !== undefined) {
      entry.reject(new Error(String(data.error)));
    } else {
      entry.resolve(data);
    }
  }
}

const bridge = new BrowserBridge();

function startWebSocketServer() {
  const wss = new WebSocketServer({ host: "localhost", port: PORT });

  wss.on("connection", (ws) => {
    log("Chrome extension connected");
    bridge.setSocket(ws);

    ws.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        log(`Invalid JSON: ${raw}`);
        return;
      }
      bridge.handleResponse(data);
    });

    ws.on("close", () => {
      log("Chrome extension disconnected");
      if (bridge.ws === ws) bridge.setSocket(null);
    });

    ws.on("error", (err) => {
      log("WebSocket error:", err.message);
    });
  });

  wss.on("listening", () => {
    log(`WebSocket server started on ws://localhost:${PORT}`);
  });

  wss.on("error", (err) => {
    log("WebSocket server error:", err.message);
  });
}

// ============================================================
// MCP Server (Claude Code Connection)
// ============================================================

const mcp = new McpServer({ name: "browser", version: "1.0.0" });

// Helper: run a bridge command and wrap the result as MCP text content.
function asText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function runCommand(action, params) {
  const response = await bridge.sendCommand(action, params);
  const result = response.result !== undefined ? response.result : response;
  return asText(result);
}

// Register a tool whose handler maps directly to a bridge command.
function tool(name, description, schema, action, mapArgs) {
  mcp.tool(name, description, schema, async (args) => {
    const params = mapArgs ? mapArgs(args) : args;
    return runCommand(action, params);
  });
}

// --- Navigation ---
tool(
  "navigate",
  "Navigate the active browser tab to a URL.",
  { url: z.string().describe("The URL to navigate to (e.g., https://example.com)") },
  "navigate"
);

tool("go_back", "Navigate back in browser history.", {}, "go_back");
tool("go_forward", "Navigate forward in browser history.", {}, "go_forward");
tool("reload_page", "Reload the current page.", {}, "reload_page");

// --- Page inspection ---
tool("get_page_info", "Get information about the current page (URL, title).", {}, "get_page_info");
tool("get_page_text", "Get the visible text content of the current page.", {}, "get_page_text");
tool("get_page_html", "Get the full HTML of the current page.", {}, "get_page_html");
tool(
  "take_screenshot",
  "Take a screenshot of the current visible tab. Returns base64 PNG data.",
  {},
  "take_screenshot"
);

// --- Element interaction ---
tool(
  "find_elements",
  "Find elements on the page matching a CSS selector.",
  { selector: z.string().describe("CSS selector (e.g., 'button', '.class', '#id')") },
  "find_elements"
);

tool(
  "get_element_text",
  "Get the text content of an element.",
  { selector: z.string().describe("CSS selector for the element") },
  "get_element_text"
);

tool(
  "get_element_attribute",
  "Get an attribute value from an element.",
  {
    selector: z.string().describe("CSS selector for the element"),
    attribute: z.string().describe("The attribute name (e.g., 'href', 'src', 'value')"),
  },
  "get_element_attribute"
);

tool(
  "click_element",
  "Click an element on the page.",
  { selector: z.string().describe("CSS selector for the element to click") },
  "click_element"
);

tool(
  "type_text",
  "Type text into an input element.",
  {
    selector: z.string().describe("CSS selector for the input element"),
    text: z.string().describe("The text to type"),
  },
  "type_text"
);

tool(
  "wait_for_element",
  "Wait for an element to appear on the page.",
  {
    selector: z.string().describe("CSS selector for the element"),
    timeout: z.number().int().default(5000).describe("Maximum time to wait in milliseconds (default 5000)"),
  },
  "wait_for_element"
);

tool(
  "scroll_page",
  "Scroll the page.",
  {
    direction: z
      .enum(["up", "down", "top", "bottom"])
      .default("down")
      .describe("Direction to scroll ('up', 'down', 'top', 'bottom')"),
    amount: z.number().int().default(500).describe("Pixels to scroll (default 500)"),
  },
  "scroll_page"
);

tool(
  "execute_javascript",
  "Execute JavaScript in the page context.",
  { code: z.string().describe("JavaScript code to execute") },
  "execute_javascript"
);

// --- Tab management ---
tool("list_tabs", "List all open browser tabs.", {}, "list_tabs");

tool(
  "switch_tab",
  "Switch to a specific tab.",
  { tab_id: z.number().int().describe("The ID of the tab to switch to") },
  "switch_tab",
  ({ tab_id }) => ({ tabId: tab_id })
);

tool(
  "new_tab",
  "Open a new browser tab.",
  { url: z.string().default("").describe("Optional URL to open in the new tab") },
  "new_tab"
);

tool(
  "close_tab",
  "Close a specific tab.",
  { tab_id: z.number().int().describe("The ID of the tab to close") },
  "close_tab",
  ({ tab_id }) => ({ tabId: tab_id })
);

tool(
  "duplicate_tab",
  "Duplicate a specific tab.",
  { tab_id: z.number().int().describe("The ID of the tab to duplicate") },
  "duplicate_tab",
  ({ tab_id }) => ({ tabId: tab_id })
);

// --- Network & console ---
tool("get_network_requests", "Get captured network requests from the current tab.", {}, "get_network_requests");
tool("clear_network_requests", "Clear the captured network requests log.", {}, "clear_network_requests");
tool("get_console_logs", "Get captured console logs from the current tab.", {}, "get_console_logs");
tool("clear_console_logs", "Clear the captured console logs.", {}, "clear_console_logs");

// ============================================================
// Main entry point
// ============================================================

async function main() {
  log("Starting Browser MCP Server...");
  startWebSocketServer();

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log("MCP server connected over stdio");
}

main().catch((err) => {
  log("Fatal error:", err.stack || err.message);
  process.exit(1);
});

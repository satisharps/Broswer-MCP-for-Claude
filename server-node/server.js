#!/usr/bin/env node
/**
 * Browser MCP Server (Node.js)
 * Connects Claude (Code / Cowork / claude.ai chat) to Chrome via a WebSocket
 * bridge to the Browser MCP Chrome extension.
 *
 * Two transport modes:
 *   stdio (default)  — `node server.js`
 *       Claude Code/Cowork spawn this per-session. Owns WebSocket :9009.
 *   http             — `node server.js --http [--port 8765]`
 *       Always-on daemon. Owns WebSocket :9009 AND serves MCP over Streamable
 *       HTTP so Code, Cowork, and claude.ai chat can all share one browser
 *       bridge at the same time. Register the URL as a remote MCP server.
 *
 * Extension wire protocol:
 *   server -> extension: { id, command, params }
 *   extension -> server: { id, result, error }
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const WS_PORT = 9009;
const DEFAULT_HTTP_PORT = 8765;
const REQUEST_TIMEOUT_MS = 30000;

// stdout is reserved for the MCP stdio protocol — all logging goes to stderr.
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
            "Chrome extension not connected. Install the extension and toggle it ON."
          )
        );
        return;
      }

      const id = this.nextId();
      // The Chrome extension's dispatcher reads the `command` field.
      const message = { id, command: action, params: params || {} };

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
    // The extension always includes `error` (null on success), so check for a
    // non-null value rather than presence.
    if (data.error != null) {
      entry.reject(new Error(String(data.error)));
    } else {
      entry.resolve(data);
    }
  }
}

const bridge = new BrowserBridge();

function startWebSocketServer() {
  const wss = new WebSocketServer({ host: "localhost", port: WS_PORT });

  wss.on("connection", (ws) => {
    log("Chrome extension connected");
    bridge.setSocket(ws);

    ws.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        log(`Invalid JSON from extension: ${raw}`);
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
    log(`WebSocket bridge listening on ws://localhost:${WS_PORT}`);
  });

  wss.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log(
        `Port ${WS_PORT} is already in use. Another Browser MCP server (or the ` +
          `old Python server) is running. Stop it first.`
      );
    } else {
      log("WebSocket server error:", err.message);
    }
  });
}

// ============================================================
// MCP Server factory
// ============================================================

function asText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function runCommand(action, params) {
  const response = await bridge.sendCommand(action, params);
  const result = response.result !== undefined ? response.result : response;
  return asText(result);
}

// Build a fully-configured MCP server. Each transport gets its own instance,
// but they all share the single `bridge` singleton above.
function buildMcpServer() {
  const mcp = new McpServer({ name: "browser", version: "1.1.0" });

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
  tool("reload_page", "Reload the current page.", {}, "reload");

  // --- Page inspection ---
  tool("get_page_info", "Get information about the current page (URL, title).", {}, "get_page_info");
  tool("get_page_text", "Get the visible text content of the current page.", {}, "get_page_text");
  tool("get_page_html", "Get the full HTML of the current page.", {}, "get_page_html");

  mcp.tool(
    "take_screenshot",
    "Take a screenshot of the current visible tab.",
    {},
    async () => {
      const response = await bridge.sendCommand("take_screenshot");
      const result = response.result !== undefined ? response.result : response;
      const dataUrl = result.screenshot || "";
      if (!dataUrl) throw new Error("Screenshot failed — no data returned");
      const b64 = dataUrl.includes(",") ? dataUrl.split(",", 2)[1] : dataUrl;
      return { content: [{ type: "image", data: b64, mimeType: "image/png" }] };
    }
  );

  // --- Element interaction ---
  tool(
    "find_elements",
    "Find elements on the page matching a CSS selector.",
    {
      selector: z.string().describe("CSS selector (e.g., 'button', '.class', '#id')"),
      limit: z.number().int().default(20).describe("Maximum number of elements to return (default 20)"),
    },
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
      timeout: z.number().int().default(10).describe("Maximum time to wait in seconds (default 10)"),
    },
    "wait_for_element"
  );
  tool(
    "scroll_page",
    "Scroll the page.",
    {
      direction: z
        .enum(["up", "down", "left", "right", "top", "bottom"])
        .default("down")
        .describe("Direction to scroll ('up', 'down', 'left', 'right', 'top', 'bottom')"),
      amount: z.number().int().default(1).describe("Scroll multiplier; each unit = 300px (default 1)"),
    },
    "scroll"
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
    ({ tab_id }) => ({ tab_id })
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
    ({ tab_id }) => ({ tab_id })
  );
  tool(
    "duplicate_tab",
    "Duplicate a specific tab.",
    { tab_id: z.number().int().describe("The ID of the tab to duplicate") },
    "duplicate_tab",
    ({ tab_id }) => ({ tab_id })
  );

  // --- Network & console ---
  tool("get_network_requests", "Get captured network requests from the current tab.", {}, "get_network_requests");
  tool("clear_network_requests", "Clear the captured network requests log.", {}, "clear_network_requests");
  tool("get_console_logs", "Get captured console logs from the current tab.", {}, "get_console_logs");
  tool("clear_console_logs", "Clear the captured console logs.", {}, "clear_console_logs");

  return mcp;
}

// ============================================================
// Transports
// ============================================================

async function startStdio() {
  const mcp = buildMcpServer();
  await mcp.connect(new StdioServerTransport());
  log("MCP server connected over stdio");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Stateless Streamable HTTP: a fresh MCP server + transport per request, all
// sharing the bridge singleton. Supports many concurrent clients (Code, Cowork,
// claude.ai chat) with no session bookkeeping.
async function startHttp(port) {
  const server = http.createServer(async (req, res) => {
    // Simple health endpoint for debugging.
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          extensionConnected: bridge.isConnected(),
          mcpEndpoint: "/mcp",
        })
      );
      return;
    }

    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    // Stateless mode: only POST carries JSON-RPC; GET/DELETE aren't used.
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed (stateless server)" },
          id: null,
        })
      );
      return;
    }

    try {
      const body = await readBody(req);
      const mcp = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log("HTTP request error:", err.message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          })
        );
      }
    }
  });

  server.listen(port, () => {
    log(`MCP Streamable HTTP endpoint: http://localhost:${port}/mcp`);
    log(`Health check:                 http://localhost:${port}/health`);
  });
}

// ============================================================
// Main
// ============================================================

function parseArgs(argv) {
  const args = { http: false, port: DEFAULT_HTTP_PORT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") args.http = true;
    else if (a === "--port") args.port = parseInt(argv[++i], 10) || DEFAULT_HTTP_PORT;
    else if (a.startsWith("--port=")) args.port = parseInt(a.split("=")[1], 10) || DEFAULT_HTTP_PORT;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log("Starting Browser MCP Server...");
  startWebSocketServer();

  if (args.http) {
    await startHttp(args.port);
    log(`Running in HTTP mode (port ${args.port}). Suitable for an always-on daemon.`);
  } else {
    await startStdio();
  }
}

main().catch((err) => {
  log("Fatal error:", err.stack || err.message);
  process.exit(1);
});

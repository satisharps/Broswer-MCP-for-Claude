#!/usr/bin/env python3
"""
Claude Browser MCP Server
=========================
Exposes Chrome browser control as MCP tools for Claude (Cowork / Claude Code).

Architecture
------------
  Claude ←─ stdio MCP ─→ server.py ←─ WebSocket :9009 ─→ Chrome Extension
                                                            └─ browser APIs

Usage
-----
  pip install -r requirements.txt
  python server.py          # listens on stdio (MCP transport)
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import websockets
import websockets.exceptions
from mcp.server.fastmcp import FastMCP, Image

# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────

WS_HOST = "localhost"
WS_PORT = 9009

# ─────────────────────────────────────────────
# Global bridge state
# ─────────────────────────────────────────────

_chrome_ws: websockets.WebSocketServerProtocol | None = None
_pending: dict[str, asyncio.Future[dict]] = {}


def _log(msg: str) -> None:
    print(f"[Browser MCP] {msg}", file=sys.stderr, flush=True)


# ─────────────────────────────────────────────
# WebSocket bridge (Extension ↔ Python)
# ─────────────────────────────────────────────

async def _handle_extension(websocket: websockets.WebSocketServerProtocol) -> None:
    global _chrome_ws
    _chrome_ws = websocket
    _log("✅  Chrome extension connected")

    try:
        async for raw in websocket:
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if data.get("type") == "ping":
                continue  # keepalive from extension

            msg_id: str | None = data.get("id")
            if msg_id and msg_id in _pending:
                fut = _pending.pop(msg_id)
                if not fut.done():
                    fut.set_result(data)

    except websockets.exceptions.ConnectionClosed:
        _log("⚠️  Chrome extension disconnected")
    finally:
        _chrome_ws = None


async def _send(command: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """Send a command to the Chrome extension and await its response."""
    if _chrome_ws is None:
        raise RuntimeError(
            "Chrome extension is not connected. "
            "Make sure the extension is installed and the server is running."
        )

    msg_id = str(uuid.uuid4())
    loop = asyncio.get_running_loop()
    fut: asyncio.Future[dict] = loop.create_future()
    _pending[msg_id] = fut

    await _chrome_ws.send(json.dumps({
        "id": msg_id,
        "command": command,
        "params": params or {},
    }))

    try:
        response = await asyncio.wait_for(asyncio.shield(fut), timeout=30.0)
    except asyncio.TimeoutError:
        _pending.pop(msg_id, None)
        raise RuntimeError(f"Command '{command}' timed out after 30 s")

    if response.get("error"):
        raise RuntimeError(response["error"])

    return response.get("result") or {}


# ─────────────────────────────────────────────
# Lifespan: start/stop the WS server alongside MCP
# ─────────────────────────────────────────────

@asynccontextmanager
async def lifespan(_server: FastMCP) -> AsyncIterator[None]:
    ws_server = await websockets.serve(_handle_extension, WS_HOST, WS_PORT)
    _log(f"🔌  WebSocket bridge listening on ws://{WS_HOST}:{WS_PORT}")
    _log("    Waiting for Chrome extension to connect…")
    try:
        yield
    finally:
        ws_server.close()
        await ws_server.wait_closed()
        _log("WebSocket server stopped")


# ─────────────────────────────────────────────
# FastMCP server
# ─────────────────────────────────────────────

mcp = FastMCP("Browser MCP", lifespan=lifespan)


# ── Navigation tools ─────────────────────────

@mcp.tool()
async def navigate(url: str) -> str:
    """
    Navigate the current browser tab to a URL.
    Waits for the page to finish loading before returning.
    Example: navigate("https://example.com")
    """
    await _send("navigate", {"url": url})
    return f"Navigated to {url}"


@mcp.tool()
async def go_back() -> str:
    """Go back in the browser history of the current tab."""
    await _send("go_back")
    return "Went back"


@mcp.tool()
async def go_forward() -> str:
    """Go forward in the browser history of the current tab."""
    await _send("go_forward")
    return "Went forward"


@mcp.tool()
async def reload_page() -> str:
    """Reload the current browser tab."""
    await _send("reload")
    return "Page reloaded"


# ── Page reading tools ────────────────────────

@mcp.tool()
async def get_page_info() -> str:
    """
    Get the current page URL and title.
    Returns JSON with url, title, and tabId.
    """
    result = await _send("get_page_info")
    return json.dumps(result, indent=2)


@mcp.tool()
async def get_page_text() -> str:
    """
    Get the visible text content of the current page (innerText).
    Use this to read page content — it's cleaner than get_page_html.
    """
    result = await _send("get_page_text")
    return result.get("text", "")


@mcp.tool()
async def get_page_html() -> str:
    """
    Get the full HTML source of the current page.
    Truncated at 50 000 chars. Prefer get_page_text for reading content.
    """
    result = await _send("get_page_html")
    html = result.get("html", "")
    if len(html) > 50_000:
        return html[:50_000] + "\n\n… [truncated — use get_page_text for readable content]"
    return html


@mcp.tool()
async def take_screenshot() -> Image:
    """
    Take a screenshot of the visible area of the current tab.
    Returns the image so Claude can see what's on screen.
    """
    result = await _send("take_screenshot")
    data_url: str = result.get("screenshot", "")
    if not data_url:
        raise RuntimeError("Screenshot failed — no data returned")

    # data_url is "data:image/png;base64,<b64>"
    if "," in data_url:
        b64 = data_url.split(",", 1)[1]
    else:
        b64 = data_url

    return Image(data=base64.b64decode(b64), format="png")


# ── DOM interaction tools ────────────────────

@mcp.tool()
async def find_elements(selector: str, limit: int = 20) -> str:
    """
    Find elements on the page matching a CSS selector.
    Returns JSON array with tag, text, id, class, href, value, etc.
    Example: find_elements("button"), find_elements("input[type=email]")
    """
    result = await _send("find_elements", {"selector": selector, "limit": limit})
    elements = result.get("elements", [])
    if not elements:
        return f"No elements found matching: {selector}"
    return json.dumps(elements, indent=2)


@mcp.tool()
async def get_element_text(selector: str) -> str:
    """
    Get the text content (or value) of a single element by CSS selector.
    Example: get_element_text("#page-title")
    """
    result = await _send("get_element_text", {"selector": selector})
    text = result.get("text")
    if text is None:
        return f"Element not found: {selector}"
    return text


@mcp.tool()
async def get_element_attribute(selector: str, attribute: str) -> str:
    """
    Get an HTML attribute value from an element.
    Example: get_element_attribute("a.logo", "href")
    """
    result = await _send("get_element_attribute", {"selector": selector, "attribute": attribute})
    value = result.get("value")
    if value is None:
        return f"Attribute '{attribute}' not found on {selector}"
    return value


@mcp.tool()
async def click_element(selector: str) -> str:
    """
    Click an element on the page using a CSS selector.
    Example: click_element("#submit-btn"), click_element("button[type=submit]")
    """
    result = await _send("click_element", {"selector": selector})
    if result.get("success"):
        return f"Clicked: {selector}"
    return f"Click failed: {result.get('error', 'unknown error')}"


@mcp.tool()
async def type_text(selector: str, text: str, clear: bool = True) -> str:
    """
    Type text into an input or textarea element.
    selector: CSS selector for the field.
    clear: clear existing value first (default True).
    Works with React, Vue, and Angular forms.
    """
    result = await _send("type_text", {"selector": selector, "text": text, "clear": clear})
    if result.get("success"):
        return f"Typed into {selector}"
    return f"Type failed: {result.get('error', 'unknown error')}"


@mcp.tool()
async def wait_for_element(selector: str, timeout: int = 10) -> str:
    """
    Wait for an element to appear on the page (e.g. after navigation or JS rendering).
    timeout: max seconds to wait (default 10).
    """
    result = await _send("wait_for_element", {"selector": selector, "timeout": timeout})
    if result.get("found"):
        return f"Element appeared: {selector}"
    return result.get("error", f"Timed out waiting for {selector}")


@mcp.tool()
async def scroll_page(direction: str, amount: int = 1) -> str:
    """
    Scroll the page.
    direction: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom'
    amount: multiplier (each unit = 300 px). Default 1.
    """
    valid = {"up", "down", "left", "right", "top", "bottom"}
    if direction not in valid:
        return f"Invalid direction '{direction}'. Use one of: {', '.join(sorted(valid))}"
    await _send("scroll", {"direction": direction, "amount": amount})
    return f"Scrolled {direction}"


@mcp.tool()
async def execute_javascript(code: str) -> str:
    """
    Execute JavaScript in the context of the current page.
    Returns the result as a JSON string.
    Example: execute_javascript("document.title")
             execute_javascript("window.location.href")
    """
    result = await _send("execute_javascript", {"code": code})
    if result.get("success"):
        return result.get("result", "undefined")
    return f"JavaScript error: {result.get('error', 'unknown error')}"


# ── Tab management tools ──────────────────────

@mcp.tool()
async def list_tabs() -> str:
    """
    List all open browser tabs.
    Returns JSON array with id, url, title, active, windowId.
    Use tab IDs with switch_tab, close_tab, etc.
    """
    result = await _send("list_tabs")
    tabs = result.get("tabs", [])
    return json.dumps(tabs, indent=2)


@mcp.tool()
async def switch_tab(tab_id: int) -> str:
    """
    Switch focus to a browser tab by its numeric ID.
    Get IDs from list_tabs first.
    """
    await _send("switch_tab", {"tab_id": tab_id})
    return f"Switched to tab {tab_id}"


@mcp.tool()
async def new_tab(url: str = "") -> str:
    """
    Open a new browser tab, optionally navigating to a URL.
    Returns the new tab's ID.
    """
    result = await _send("new_tab", {"url": url})
    return f"Opened new tab (ID: {result.get('tabId')})" + (f" at {url}" if url else "")


@mcp.tool()
async def close_tab(tab_id: int) -> str:
    """Close a browser tab by its numeric ID."""
    await _send("close_tab", {"tab_id": tab_id})
    return f"Closed tab {tab_id}"


@mcp.tool()
async def duplicate_tab(tab_id: int | None = None) -> str:
    """
    Duplicate a tab. If tab_id is omitted, duplicates the active tab.
    Returns the new tab's ID.
    """
    params: dict[str, Any] = {}
    if tab_id is not None:
        params["tab_id"] = tab_id
    result = await _send("duplicate_tab", params)
    return f"Duplicated tab — new ID: {result.get('tabId')}"


# ── Network & console monitoring tools ────────

@mcp.tool()
async def get_network_requests(filter_url: str = "") -> str:
    """
    Get recent network requests captured from the current tab (last 50).
    filter_url: optional substring to filter by URL.
    Shows request method, URL, response status, MIME type.
    Note: requires the debugger permission (shows a Chrome banner).
    """
    params: dict[str, Any] = {}
    if filter_url:
        params["filter_url"] = filter_url
    result = await _send("get_network_requests", params)
    requests = result.get("requests", [])
    if not requests:
        return "No network requests captured yet. Navigate to a page first."
    return json.dumps(requests, indent=2)


@mcp.tool()
async def clear_network_requests() -> str:
    """Clear the stored network request log for the current tab."""
    await _send("clear_network_requests")
    return "Network request log cleared"


@mcp.tool()
async def get_console_logs(level: str = "") -> str:
    """
    Get console log messages from the current tab (last 100).
    level: optional filter — 'log' | 'warn' | 'error' | 'info' | 'debug'
    """
    params: dict[str, Any] = {}
    if level:
        params["level"] = level
    result = await _send("get_console_logs", params)
    logs = result.get("logs", [])
    if not logs:
        return "No console logs captured yet."
    return json.dumps(logs, indent=2)


@mcp.tool()
async def clear_console_logs() -> str:
    """Clear the stored console log messages for the current tab."""
    await _send("clear_console_logs")
    return "Console log cleared"


# ─────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Claude Browser MCP Server")
    parser.add_argument(
        "--transport",
        choices=["stdio", "sse", "streamable-http"],
        default="stdio",
        help=(
            "Transport mode:\n"
            "  stdio            — Claude Code CLI and Cowork desktop (default, auto-started by Claude)\n"
            "  sse              — Claude.ai chat via public URL (needs ngrok)\n"
            "  streamable-http  — same as sse, newer MCP spec name\n"
        ),
    )
    parser.add_argument(
        "--host",
        default="localhost",
        help="Host to bind HTTP/SSE server (default: localhost). Use 0.0.0.0 for remote/ngrok access.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="Port for HTTP/SSE server (default: 8765)",
    )
    args = parser.parse_args()

    if args.transport in ("sse", "streamable-http"):
        _log(f"🌐  Starting {args.transport} server on http://{args.host}:{args.port}")
        _log(f"    SSE endpoint : http://{args.host}:{args.port}/sse")
        _log(f"    For Claude.ai: expose via ngrok then register the /sse URL")
        # FastMCP 1.x: host/port are set via mcp.settings, NOT as run() kwargs
        try:
            mcp.settings.host = args.host
            mcp.settings.port = args.port
        except AttributeError:
            # Fallback: env vars are read by FastMCP if settings not available
            import os
            os.environ["FASTMCP_HOST"] = args.host
            os.environ["FASTMCP_PORT"] = str(args.port)
        mcp.run(transport=args.transport)
    else:
        _log("📡  Starting stdio transport (Claude Code CLI / Cowork mode)")
        _log("    Claude starts this server automatically — no manual startup needed.")
        mcp.run(transport="stdio")

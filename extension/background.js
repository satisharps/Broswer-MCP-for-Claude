/**
 * Claude Browser MCP — Background Service Worker (v1.1)
 *
 * No chrome.debugger → no Chrome banner, ever.
 * Network monitoring via chrome.webRequest.
 * Console monitoring via MAIN-world script injection + content_relay.js.
 *
 * Protocol:
 *   Server → Extension: { id, command, params }
 *   Extension → Server: { id, result, error }
 */

const WS_PORT = 9009;
const WS_URL  = `ws://localhost:${WS_PORT}`;

let ws             = null;
let reconnectTimer = null;
let mcpEnabled     = false;

// Per-tab storage (cleared when tab closes)
const networkRequests = {}; // tabId → []
const consoleLogs     = {}; // tabId → []

// ─────────────────────────────────────────────
// WebSocket connection
// ─────────────────────────────────────────────

function connect() {
  if (!mcpEnabled) return;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[Claude MCP] Connected');
      clearInterval(reconnectTimer);
      reconnectTimer = null;
      chrome.storage.local.set({ mcpStatus: 'connected' });
    };

    ws.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'ping') return;
      await handleCommand(msg);
    };

    ws.onclose = () => {
      ws = null;
      if (mcpEnabled) {
        chrome.storage.local.set({ mcpStatus: 'disconnected' });
        scheduleReconnect();
      }
    };

    ws.onerror = () => {};
  } catch {
    scheduleReconnect();
  }
}

function disconnect() {
  clearInterval(reconnectTimer);
  reconnectTimer = null;
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  chrome.storage.local.set({ mcpStatus: 'off' });
}

function scheduleReconnect() {
  if (!reconnectTimer) reconnectTimer = setInterval(() => connect(), 3000);
}

function send(id, result, error = null) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id, result: result ?? null, error: error ?? null }));
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab;
}

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(done, timeoutMs);
  });
}

async function runScript(tabId, func, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}

// Inject console capture into the page's MAIN world (no debugger needed)
async function injectConsoleCapture(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        if (window.__claudeMcpConsole) return;
        window.__claudeMcpConsole = true;
        ['log', 'warn', 'error', 'info', 'debug'].forEach((method) => {
          const orig = console[method].bind(console);
          console[method] = (...args) => {
            orig(...args);
            try {
              window.dispatchEvent(new CustomEvent('__claude_mcp_console__', {
                detail: {
                  level: method,
                  args: args.map((a) => { try { return String(a); } catch { return ''; } }),
                  timestamp: Date.now(),
                },
              }));
            } catch {}
          };
        });
      },
    });
  } catch { /* chrome:// tabs or CSP pages — skip silently */ }
}

// ─────────────────────────────────────────────
// Command dispatcher
// ─────────────────────────────────────────────

async function handleCommand({ id, command, params = {} }) {
  try { send(id, await dispatch(command, params)); }
  catch (err) { send(id, null, err.message ?? String(err)); }
}

async function dispatch(command, params) {
  switch (command) {

    // ── Navigation ──────────────────────────────

    case 'navigate': {
      const tab = await getActiveTab();
      await chrome.tabs.update(tab.id, { url: params.url });
      await waitForTabLoad(tab.id);
      await injectConsoleCapture(tab.id);
      return { success: true, url: params.url };
    }
    case 'go_back': {
      const tab = await getActiveTab();
      await chrome.tabs.goBack(tab.id);
      return { success: true };
    }
    case 'go_forward': {
      const tab = await getActiveTab();
      await chrome.tabs.goForward(tab.id);
      return { success: true };
    }
    case 'reload': {
      const tab = await getActiveTab();
      await chrome.tabs.reload(tab.id);
      await waitForTabLoad(tab.id);
      return { success: true };
    }

    // ── Page reading ─────────────────────────────

    case 'get_page_info': {
      const tab = await getActiveTab();
      return { url: tab.url, title: tab.title, tabId: tab.id };
    }
    case 'get_page_text': {
      const tab = await getActiveTab();
      return { text: await runScript(tab.id, () => document.body.innerText) };
    }
    case 'get_page_html': {
      const tab = await getActiveTab();
      return { html: await runScript(tab.id, () => document.documentElement.outerHTML) };
    }
    case 'take_screenshot': {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
      return { screenshot: dataUrl };
    }

    // ── DOM interaction ──────────────────────────

    case 'find_elements': {
      const tab = await getActiveTab();
      const elements = await runScript(tab.id, (selector, limit) => {
        return [...document.querySelectorAll(selector)].slice(0, limit || 20).map((el, i) => ({
          index: i,
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || '').trim().slice(0, 150),
          id: el.id || null,
          className: (el.className || '').slice(0, 100),
          href: el.href || null,
          value: el.value ?? null,
          type: el.type || null,
          placeholder: el.placeholder || null,
          ariaLabel: el.getAttribute('aria-label') || null,
          name: el.name || null,
        }));
      }, [params.selector, params.limit]);
      return { elements: elements || [] };
    }
    case 'click_element': {
      const tab = await getActiveTab();
      return await runScript(tab.id, (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { success: false, error: `Not found: ${sel}` };
        el.click();
        return { success: true };
      }, [params.selector]);
    }
    case 'type_text': {
      const tab = await getActiveTab();
      return await runScript(tab.id, (sel, text, clear) => {
        const el = document.querySelector(sel);
        if (!el) return { success: false, error: `Not found: ${sel}` };
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (clear) { setter ? setter.call(el, '') : (el.value = ''); }
        setter ? setter.call(el, text) : (el.value = text);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      }, [params.selector, params.text, params.clear !== false]);
    }
    case 'get_element_text': {
      const tab = await getActiveTab();
      const text = await runScript(tab.id, (sel) => {
        const el = document.querySelector(sel);
        return el ? (el.innerText || el.value || el.textContent || '') : null;
      }, [params.selector]);
      return { text };
    }
    case 'get_element_attribute': {
      const tab = await getActiveTab();
      return { value: await runScript(tab.id, (sel, attr) => {
        const el = document.querySelector(sel);
        return el ? el.getAttribute(attr) : null;
      }, [params.selector, params.attribute]) };
    }
    case 'wait_for_element': {
      const tab   = await getActiveTab();
      const until = Date.now() + (params.timeout || 10) * 1000;
      while (Date.now() < until) {
        const found = await runScript(tab.id, (sel) => !!document.querySelector(sel), [params.selector]);
        if (found) return { found: true };
        await new Promise(r => setTimeout(r, 250));
      }
      return { found: false, error: `Timeout: ${params.selector}` };
    }
    case 'scroll': {
      const tab = await getActiveTab();
      await runScript(tab.id, (dir, amt) => {
        const px = (amt || 1) * 300;
        if      (dir === 'top')    window.scrollTo(0, 0);
        else if (dir === 'bottom') window.scrollTo(0, document.body.scrollHeight);
        else if (dir === 'up')     window.scrollBy(0, -px);
        else if (dir === 'down')   window.scrollBy(0,  px);
        else if (dir === 'left')   window.scrollBy(-px, 0);
        else if (dir === 'right')  window.scrollBy( px, 0);
      }, [params.direction, params.amount]);
      return { success: true };
    }
    case 'execute_javascript': {
      const tab = await getActiveTab();
      return await runScript(tab.id, (code) => {
        try { return { success: true,  result: JSON.stringify(eval(code), null, 2) }; }
        catch (e) { return { success: false, error: e.message }; }
      }, [params.code]);
    }

    // ── Tab management ───────────────────────────

    case 'list_tabs': {
      const tabs = await chrome.tabs.query({});
      return { tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })) };
    }
    case 'switch_tab': {
      await chrome.tabs.update(params.tab_id, { active: true });
      const tab = await chrome.tabs.get(params.tab_id);
      await chrome.windows.update(tab.windowId, { focused: true });
      return { success: true };
    }
    case 'new_tab': {
      const tab = await chrome.tabs.create({ url: params.url || 'about:blank' });
      if (params.url && params.url !== 'about:blank') await waitForTabLoad(tab.id);
      return { tabId: tab.id };
    }
    case 'close_tab': {
      await chrome.tabs.remove(params.tab_id);
      return { success: true };
    }
    case 'duplicate_tab': {
      const src    = params.tab_id ? await chrome.tabs.get(params.tab_id) : await getActiveTab();
      const newTab = await chrome.tabs.duplicate(src.id);
      return { tabId: newTab.id };
    }

    // ── Network monitoring (via webRequest, no debugger) ──

    case 'get_network_requests': {
      const tab      = await getActiveTab();
      const requests = networkRequests[tab.id] || [];
      const filtered = params.filter_url
        ? requests.filter(r => r.url?.includes(params.filter_url))
        : requests;
      return { requests: filtered.slice(-50) };
    }
    case 'clear_network_requests': {
      const tab = await getActiveTab();
      networkRequests[tab.id] = [];
      return { success: true };
    }

    // ── Console monitoring (via MAIN-world injection) ──

    case 'get_console_logs': {
      const tab    = await getActiveTab();
      const logs   = consoleLogs[tab.id] || [];
      const filtered = params.level ? logs.filter(l => l.level === params.level) : logs;
      return { logs: filtered.slice(-100) };
    }
    case 'clear_console_logs': {
      const tab = await getActiveTab();
      consoleLogs[tab.id] = [];
      return { success: true };
    }

    default:
      throw new Error(`Unknown command: "${command}"`);
  }
}

// ─────────────────────────────────────────────
// Network monitoring — chrome.webRequest (no banner)
// ─────────────────────────────────────────────

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (!mcpEnabled || details.tabId < 0) return;
  if (!networkRequests[details.tabId]) networkRequests[details.tabId] = [];
  networkRequests[details.tabId].push({
    event: 'request',
    requestId: details.requestId,
    url: details.url,
    method: details.method,
    type: details.type,
    timestamp: Date.now(),
  });
}, { urls: ['<all_urls>'] });

chrome.webRequest.onCompleted.addListener((details) => {
  if (!mcpEnabled || details.tabId < 0) return;
  if (!networkRequests[details.tabId]) networkRequests[details.tabId] = [];
  networkRequests[details.tabId].push({
    event: 'response',
    requestId: details.requestId,
    url: details.url,
    status: details.statusCode,
    type: details.type,
    timestamp: Date.now(),
  });
}, { urls: ['<all_urls>'] });

chrome.webRequest.onErrorOccurred.addListener((details) => {
  if (!mcpEnabled || details.tabId < 0) return;
  if (!networkRequests[details.tabId]) networkRequests[details.tabId] = [];
  networkRequests[details.tabId].push({
    event: 'error',
    requestId: details.requestId,
    url: details.url,
    error: details.error,
    timestamp: Date.now(),
  });
}, { urls: ['<all_urls>'] });

// ─────────────────────────────────────────────
// Console log relay from content_relay.js
// ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'CONSOLE_LOG' && sender.tab) {
    const tabId = sender.tab.id;
    if (!consoleLogs[tabId]) consoleLogs[tabId] = [];
    consoleLogs[tabId].push({ level: msg.level, args: msg.args, timestamp: msg.timestamp });
  }
});

// ─────────────────────────────────────────────
// Tab cleanup
// ─────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  delete networkRequests[tabId];
  delete consoleLogs[tabId];
});

// Inject console capture on page load (when enabled)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (mcpEnabled && changeInfo.status === 'complete') {
    injectConsoleCapture(tabId);
  }
});

// ─────────────────────────────────────────────
// Toggle handler (from popup)
// ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'SET_ENABLED') return;
  mcpEnabled = msg.enabled;
  chrome.storage.local.set({ mcpEnabled });
  if (mcpEnabled) {
    connect();
    // Inject console capture into all open tabs
    chrome.tabs.query({}, (tabs) => tabs.forEach(t => injectConsoleCapture(t.id)));
  } else {
    disconnect();
  }
});

// ─────────────────────────────────────────────
// Keepalive
// ─────────────────────────────────────────────

chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    connect();
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }
});

// ─────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────

chrome.storage.local.get(['mcpEnabled'], (res) => {
  mcpEnabled = res.mcpEnabled ?? false;
  if (mcpEnabled) connect();
  else chrome.storage.local.set({ mcpStatus: 'off' });
});

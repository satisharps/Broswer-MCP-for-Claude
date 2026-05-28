/**
 * Claude Browser MCP — Background Service Worker
 *
 * Acts as a bridge between the Python MCP server (WebSocket)
 * and the Chrome browser APIs (tabs, scripting, debugger).
 *
 * Protocol:
 *   Server → Extension: { id, command, params }
 *   Extension → Server: { id, result, error }
 */

const WS_PORT = 9009;
const WS_URL = `ws://localhost:${WS_PORT}`;
const RECONNECT_INTERVAL_MS = 3000;
const KEEPALIVE_INTERVAL_MS = 20000;

let ws = null;
let reconnectTimer = null;

// Debugger state
const attachedTabs = new Set();
const networkRequests = {};   // tabId -> []
const consoleLogs = {};       // tabId -> []

// ─────────────────────────────────────────────
// WebSocket connection management
// ─────────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[Claude MCP] Connected to Python server');
      clearInterval(reconnectTimer);
      reconnectTimer = null;
      // Notify popup
      chrome.storage.local.set({ mcpStatus: 'connected' });
    };

    ws.onmessage = async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'ping') return; // ignore server pings
      await handleCommand(message);
    };

    ws.onclose = () => {
      console.log('[Claude MCP] Disconnected — will retry in 3s');
      ws = null;
      chrome.storage.local.set({ mcpStatus: 'disconnected' });
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose fires after onerror, so just log here
      console.warn('[Claude MCP] WebSocket error');
    };
  } catch (err) {
    console.error('[Claude MCP] Could not create WebSocket:', err);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setInterval(() => connect(), RECONNECT_INTERVAL_MS);
  }
}

function send(id, result, error = null) {
  if (ws && ws.readyState === WebSocket.OPEN) {
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
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(done, timeoutMs);
  });
}

async function runScript(tabId, func, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return result;
}

// ─────────────────────────────────────────────
// Command dispatcher
// ─────────────────────────────────────────────

async function handleCommand({ id, command, params = {} }) {
  try {
    const result = await dispatch(command, params);
    send(id, result);
  } catch (err) {
    send(id, null, err.message ?? String(err));
  }
}

async function dispatch(command, params) {
  switch (command) {

    // ── Navigation ──────────────────────────────

    case 'navigate': {
      const tab = await getActiveTab();
      await chrome.tabs.update(tab.id, { url: params.url });
      await waitForTabLoad(tab.id);
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

    // ── Page reading ────────────────────────────

    case 'get_page_info': {
      const tab = await getActiveTab();
      return { url: tab.url, title: tab.title, tabId: tab.id };
    }

    case 'get_page_text': {
      const tab = await getActiveTab();
      const text = await runScript(tab.id, () => document.body.innerText);
      return { text };
    }

    case 'get_page_html': {
      const tab = await getActiveTab();
      const html = await runScript(tab.id, () => document.documentElement.outerHTML);
      return { html };
    }

    case 'take_screenshot': {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
      return { screenshot: dataUrl };
    }

    // ── DOM interaction ──────────────────────────

    case 'find_elements': {
      const tab = await getActiveTab();
      const elements = await runScript(tab.id, (selector, limit) => {
        const els = [...document.querySelectorAll(selector)].slice(0, limit || 20);
        return els.map((el, i) => ({
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
      const res = await runScript(tab.id, (selector) => {
        const el = document.querySelector(selector);
        if (!el) return { success: false, error: `Element not found: ${selector}` };
        el.click();
        return { success: true };
      }, [params.selector]);
      return res;
    }

    case 'type_text': {
      const tab = await getActiveTab();
      const res = await runScript(tab.id, (selector, text, clear) => {
        const el = document.querySelector(selector);
        if (!el) return { success: false, error: `Element not found: ${selector}` };
        el.focus();
        if (clear) el.value = '';
        // Set value and fire React/Vue-compatible events
        const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeInputSetter) nativeInputSetter.call(el, text);
        else el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      }, [params.selector, params.text, params.clear !== false]);
      return res;
    }

    case 'get_element_text': {
      const tab = await getActiveTab();
      const text = await runScript(tab.id, (selector) => {
        const el = document.querySelector(selector);
        return el ? (el.innerText || el.value || el.textContent || '') : null;
      }, [params.selector]);
      return { text };
    }

    case 'get_element_attribute': {
      const tab = await getActiveTab();
      const value = await runScript(tab.id, (selector, attr) => {
        const el = document.querySelector(selector);
        return el ? el.getAttribute(attr) : null;
      }, [params.selector, params.attribute]);
      return { value };
    }

    case 'wait_for_element': {
      const tab = await getActiveTab();
      const timeoutMs = (params.timeout || 10) * 1000;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const found = await runScript(tab.id, (sel) => !!document.querySelector(sel), [params.selector]);
        if (found) return { found: true };
        await new Promise(r => setTimeout(r, 250));
      }
      return { found: false, error: `Timeout: ${params.selector} not found after ${params.timeout || 10}s` };
    }

    case 'scroll': {
      const tab = await getActiveTab();
      await runScript(tab.id, (direction, amount) => {
        const px = (amount || 1) * 300;
        const map = {
          up: [0, -px], down: [0, px],
          left: [-px, 0], right: [px, 0],
          top: null, bottom: null,
        };
        if (direction === 'top') window.scrollTo(0, 0);
        else if (direction === 'bottom') window.scrollTo(0, document.body.scrollHeight);
        else if (map[direction]) window.scrollBy(...map[direction]);
      }, [params.direction, params.amount]);
      return { success: true };
    }

    case 'execute_javascript': {
      const tab = await getActiveTab();
      const res = await runScript(tab.id, (code) => {
        try {
          // eslint-disable-next-line no-eval
          const r = eval(code);
          return { success: true, result: JSON.stringify(r, null, 2) };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }, [params.code]);
      return res;
    }

    // ── Tab management ───────────────────────────

    case 'list_tabs': {
      const tabs = await chrome.tabs.query({});
      return {
        tabs: tabs.map(t => ({
          id: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
          windowId: t.windowId,
          index: t.index,
        })),
      };
    }

    case 'switch_tab': {
      await chrome.tabs.update(params.tab_id, { active: true });
      const tab = await chrome.tabs.get(params.tab_id);
      await chrome.windows.update(tab.windowId, { focused: true });
      return { success: true };
    }

    case 'new_tab': {
      const tab = await chrome.tabs.create({ url: params.url || 'about:blank' });
      if (params.url && params.url !== 'about:blank') {
        await waitForTabLoad(tab.id);
      }
      return { tabId: tab.id, url: tab.url };
    }

    case 'close_tab': {
      await chrome.tabs.remove(params.tab_id);
      return { success: true };
    }

    case 'duplicate_tab': {
      const tab = params.tab_id
        ? await chrome.tabs.get(params.tab_id)
        : await getActiveTab();
      const newTab = await chrome.tabs.duplicate(tab.id);
      return { tabId: newTab.id };
    }

    // ── Network & console monitoring ─────────────

    case 'get_network_requests': {
      const tab = await getActiveTab();
      const requests = networkRequests[tab.id] || [];
      const filter = params.filter_url;
      const filtered = filter
        ? requests.filter(r => r.url && r.url.includes(filter))
        : requests;
      return { requests: filtered.slice(-50) };
    }

    case 'clear_network_requests': {
      const tab = await getActiveTab();
      networkRequests[tab.id] = [];
      return { success: true };
    }

    case 'get_console_logs': {
      const tab = await getActiveTab();
      const logs = consoleLogs[tab.id] || [];
      const filter = params.level; // 'log', 'warn', 'error', etc.
      const filtered = filter ? logs.filter(l => l.type === filter) : logs;
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
// Debugger: network + console monitoring
// ─────────────────────────────────────────────

async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
    attachedTabs.add(tabId);
    networkRequests[tabId] = [];
    consoleLogs[tabId] = [];
  } catch {
    // Tab might be chrome:// or already have a debugger; silently skip
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;

  if (method === 'Network.requestWillBeSent') {
    if (!networkRequests[tabId]) networkRequests[tabId] = [];
    networkRequests[tabId].push({
      event: 'request',
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      timestamp: params.timestamp,
      type: params.type,
    });
  } else if (method === 'Network.responseReceived') {
    if (!networkRequests[tabId]) networkRequests[tabId] = [];
    networkRequests[tabId].push({
      event: 'response',
      requestId: params.requestId,
      url: params.response.url,
      status: params.response.status,
      statusText: params.response.statusText,
      mimeType: params.response.mimeType,
      timestamp: params.timestamp,
    });
  } else if (method === 'Runtime.consoleAPICalled') {
    if (!consoleLogs[tabId]) consoleLogs[tabId] = [];
    consoleLogs[tabId].push({
      type: params.type,
      args: (params.args || []).map(a => a.value ?? a.description ?? ''),
      timestamp: Date.now(),
    });
  }
});

chrome.debugger.onDetach.addListener((source) => {
  attachedTabs.delete(source.tabId);
});

// Attach debugger to tabs as they load
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    attachDebugger(tabId);
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id) attachDebugger(tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (attachedTabs.has(tabId)) {
    chrome.debugger.detach({ tabId }).catch(() => {});
    attachedTabs.delete(tabId);
  }
  delete networkRequests[tabId];
  delete consoleLogs[tabId];
});

// ─────────────────────────────────────────────
// Keepalive — prevent MV3 service worker sleep
// ─────────────────────────────────────────────

chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 }); // ~24 s

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    connect();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }
});

// ─────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────

connect();

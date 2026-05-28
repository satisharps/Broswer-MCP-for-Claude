/**
 * content_relay.js — runs in ISOLATED world (has chrome.runtime access)
 * Listens for console events dispatched from the MAIN world injection
 * and forwards them to the background service worker.
 */
window.addEventListener('__claude_mcp_console__', (e) => {
  try {
    chrome.runtime.sendMessage({ type: 'CONSOLE_LOG', ...e.detail });
  } catch { /* extension context may be invalidated */ }
});

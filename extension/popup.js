// popup.js — reads connection status from chrome.storage and updates UI

const dot = document.getElementById('dot');
const label = document.getElementById('statusLabel');
const sub = document.getElementById('statusSub');

function render(status) {
  const state = status === 'connected' ? 'connected'
    : status === 'disconnected' ? 'disconnected'
    : 'connecting';

  dot.className = `dot ${state}`;
  label.className = `status-label ${state}`;

  if (state === 'connected') {
    label.textContent = 'Connected';
    sub.textContent = 'Claude can control this browser via MCP tools.';
  } else if (state === 'disconnected') {
    label.textContent = 'Disconnected';
    sub.textContent = 'Python MCP server is not running. Start it with: python server.py';
  } else {
    label.textContent = 'Connecting…';
    sub.textContent = 'Waiting for Python MCP server on localhost:9009.';
  }
}

// Read current status
chrome.storage.local.get(['mcpStatus'], (res) => {
  render(res.mcpStatus || 'connecting');
});

// Listen for changes while popup is open
chrome.storage.onChanged.addListener((changes) => {
  if (changes.mcpStatus) {
    render(changes.mcpStatus.newValue);
  }
});

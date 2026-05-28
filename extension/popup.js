// popup.js — toggle switch + live status display

const toggle      = document.getElementById('toggle');
const toggleHint  = document.getElementById('toggleHint');
const dot         = document.getElementById('dot');
const label       = document.getElementById('statusLabel');
const sub         = document.getElementById('statusSub');

function renderStatus(status, enabled) {
  // Determine display state
  const state = !enabled ? 'off'
    : status === 'connected'    ? 'connected'
    : status === 'disconnected' ? 'disconnected'
    : 'connecting';

  dot.className   = `dot ${state}`;
  label.className = `status-label ${state}`;

  const messages = {
    off:          ['Disabled',      'Toggle on to let Claude control this browser.'],
    connected:    ['Connected',     'Claude can control this browser via MCP tools.'],
    disconnected: ['Disconnected',  'Python MCP server not running. Start it with: python server.py'],
    connecting:   ['Connecting…',   'Waiting for Python MCP server on localhost:9009.'],
  };

  const [labelText, subText] = messages[state];
  label.textContent = labelText;
  sub.textContent   = subText;
  toggleHint.textContent = enabled ? 'On — Claude can see browser' : 'Off — Claude cannot see browser';
}

// Load saved state and render
chrome.storage.local.get(['mcpEnabled', 'mcpStatus'], (res) => {
  const enabled = res.mcpEnabled ?? false;
  toggle.checked = enabled;
  renderStatus(res.mcpStatus, enabled);
});

// User flips the toggle
toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled });
  // Optimistic UI update
  renderStatus(enabled ? 'connecting' : 'off', enabled);
});

// Live status updates while popup is open
chrome.storage.onChanged.addListener((changes) => {
  const enabled = changes.mcpEnabled ? changes.mcpEnabled.newValue : toggle.checked;
  const status  = changes.mcpStatus  ? changes.mcpStatus.newValue  : null;
  if (changes.mcpEnabled) toggle.checked = enabled;
  if (status) renderStatus(status, enabled);
});

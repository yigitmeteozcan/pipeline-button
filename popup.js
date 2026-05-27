(() => {
  'use strict';

  // ── Element refs ──────────────────────────────────────────────────────────

  const tokenInput     = document.getElementById('token-input');
  const boardInput     = document.getElementById('board-input');
  const toggleToken    = document.getElementById('toggle-token');
  const saveBtn        = document.getElementById('save-btn');
  const statusBox      = document.getElementById('status-box');
  const historySection = document.getElementById('history-section');
  const historyList    = document.getElementById('history-list');
  const clearHistory   = document.getElementById('clear-history');

  // ── Helpers ───────────────────────────────────────────────────────────────

  function showStatus(message, type) {
    statusBox.textContent = message;
    statusBox.className = `status-box ${type}`;
    statusBox.classList.remove('hidden');
  }

  function hideStatus() {
    statusBox.className = 'status-box hidden';
  }

  function formatRelativeTime(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return mins <= 1 ? 'just now' : `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return days === 1 ? 'yesterday' : `${days}d ago`;
  }

  function maskToken(raw) {
    if (!raw || raw.length <= 4) return '••••';
    return '••••••••' + raw.slice(-4);
  }

  // ── Render history ────────────────────────────────────────────────────────

  function renderHistory(history) {
    if (!history || history.length === 0) {
      historySection.classList.add('hidden');
      return;
    }

    historySection.classList.remove('hidden');

    while (historyList.firstChild) {
      historyList.removeChild(historyList.firstChild);
    }

    for (const entry of history) {
      const li = document.createElement('li');
      li.className = 'history-item';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'history-name';
      nameSpan.textContent = entry.name || 'Unknown';

      const timeSpan = document.createElement('span');
      timeSpan.className = 'history-time';
      timeSpan.textContent = formatRelativeTime(entry.timestamp);

      li.appendChild(nameSpan);
      li.appendChild(timeSpan);
      historyList.appendChild(li);
    }
  }

  // ── Load saved settings ───────────────────────────────────────────────────

  function loadSettings() {
    chrome.storage.sync.get(
      ['MONDAY_API_TOKEN', 'MONDAY_BOARD_ID', 'PIPELINE_HISTORY'],
      (result) => {
        if (result.MONDAY_API_TOKEN) {
          tokenInput.value = maskToken(result.MONDAY_API_TOKEN);
          tokenInput.dataset.masked = 'true';
        }
        if (result.MONDAY_BOARD_ID) {
          boardInput.value = result.MONDAY_BOARD_ID;
        }
        renderHistory(result.PIPELINE_HISTORY || []);
      }
    );
  }

  // ── Show/hide token ───────────────────────────────────────────────────────

  toggleToken.addEventListener('click', () => {
    if (tokenInput.dataset.masked === 'true') {
      // Reveal field so user can type new value
      tokenInput.value = '';
      tokenInput.dataset.masked = 'false';
      tokenInput.type = 'text';
      tokenInput.placeholder = 'Paste your new token';
      tokenInput.focus();
    } else if (tokenInput.type === 'password') {
      tokenInput.type = 'text';
    } else {
      tokenInput.type = 'password';
    }
  });

  // When user starts typing, clear the masked indicator
  tokenInput.addEventListener('input', () => {
    if (tokenInput.dataset.masked === 'true') {
      tokenInput.dataset.masked = 'false';
    }
  });

  // ── Save settings ─────────────────────────────────────────────────────────

  saveBtn.addEventListener('click', async () => {
    hideStatus();

    const boardId = boardInput.value.trim();
    let token = tokenInput.dataset.masked === 'true' ? null : tokenInput.value.trim();

    if (!boardId) {
      showStatus('Please enter a Board ID.', 'error');
      return;
    }

    if (!/^\d+$/.test(boardId)) {
      showStatus('Board ID must be numeric.', 'error');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    // If token field is masked, keep the existing stored token
    if (token === null) {
      const stored = await new Promise(resolve =>
        chrome.storage.sync.get(['MONDAY_API_TOKEN'], resolve)
      );
      token = stored.MONDAY_API_TOKEN || '';
    }

    if (!token) {
      showStatus('Please enter a Monday API token.', 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Settings';
      return;
    }

    // Save to storage
    await new Promise(resolve =>
      chrome.storage.sync.set({ MONDAY_API_TOKEN: token, MONDAY_BOARD_ID: boardId }, resolve)
    );

    // Mask the token field immediately after save
    tokenInput.value = maskToken(token);
    tokenInput.dataset.masked = 'true';
    tokenInput.type = 'password';

    // Verify connection
    saveBtn.textContent = 'Verifying...';

    chrome.runtime.sendMessage(
      { type: 'VERIFY_CONNECTION', payload: { token, boardId } },
      (response) => {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Settings';

        if (response && response.success) {
          showStatus(`✓ Connected to Monday\nBoard: ${response.boardName}`, 'success');
        } else {
          const msg = (response && response.error) || 'Connection failed';
          showStatus(`✗ ${msg}`, 'error');
        }
      }
    );
  });

  // ── Clear history ─────────────────────────────────────────────────────────

  clearHistory.addEventListener('click', () => {
    chrome.storage.sync.set({ PIPELINE_HISTORY: [] }, () => {
      renderHistory([]);
    });
  });

  // ── Init ──────────────────────────────────────────────────────────────────

  loadSettings();
})();

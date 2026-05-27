(() => {
  'use strict';

  const MONDAY_API_URL = 'https://api.monday.com/v2';
  const FETCH_TIMEOUT_MS = 30_000;
  const RATE_LIMIT_WAIT_MS = 30_000;

  // Message types the background worker accepts — all others are rejected
  const ALLOWED_MESSAGES = new Set([
    'ADD_TO_PIPELINE',
    'VERIFY_CONNECTION',
    'CHECK_CONFIG',
  ]);

  // ── Token masking ─────────────────────────────────────────────────────────

  function maskToken(str, token) {
    if (!token) return str;
    return str.replaceAll(token, '[REDACTED]');
  }

  // ── Safety guard ──────────────────────────────────────────────────────────

  const DANGEROUS_OPS = [
    'delete_item', 'delete_board', 'delete_column', 'delete_group',
    'delete_update', 'delete_workspace', 'archive_item', 'archive_board',
    'move_item_to_board', 'clear_item_updates', 'update_item',
    'duplicate_item', 'change_column_value', 'change_multiple_column_values',
  ];

  function assertSafe(query) {
    const normalized = query.replace(/\s+/g, ' ').toLowerCase();
    for (const op of DANGEROUS_OPS) {
      if (normalized.includes(op)) {
        throw new Error('SAFETY ERROR: blocked dangerous mutation: ' + op);
      }
    }
    const hasCreate = normalized.includes('create_item') || normalized.includes('create_update');
    if (!hasCreate) {
      throw new Error('SAFETY ERROR: query does not contain an allowed operation');
    }
  }

  // ── Storage helper — reads token+boardId once, never caches at module level ──

  async function readCredentials() {
    return new Promise(resolve =>
      chrome.storage.sync.get(['MONDAY_API_TOKEN', 'MONDAY_BOARD_ID'], resolve)
    );
  }

  // ── Fetch with timeout ────────────────────────────────────────────────────

  async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Monday API call — token read from storage inside, never passed as arg ──

  async function callMonday(query, variables) {
    assertSafe(query);

    const { MONDAY_API_TOKEN: token } = await readCredentials();
    if (!token) throw new Error('API token not configured');

    const body = JSON.stringify({ query, variables });
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': token,
      'API-Version': '2024-01',
    };

    let response = await fetchWithTimeout(MONDAY_API_URL, { method: 'POST', headers, body });

    if (response.status === 429) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_WAIT_MS));
      response = await fetchWithTimeout(MONDAY_API_URL, { method: 'POST', headers, body });
    }

    if (response.status === 401) {
      throw new Error('Invalid API token');
    }

    if (!response.ok) {
      throw new Error('Monday API request failed');
    }

    const json = await response.json();

    if (json.errors && json.errors.length > 0) {
      throw new Error('Monday API returned an error');
    }

    return json;
  }

  // ── Create Monday item — reads credentials internally ─────────────────────

  async function createItem(itemName) {
    const { MONDAY_BOARD_ID: boardId } = await readCredentials();
    if (!boardId) throw new Error('Board ID not configured');

    const query = `
      mutation CreateItem($boardId: ID!, $itemName: String!) {
        create_item(board_id: $boardId, item_name: $itemName) {
          id
          name
        }
      }
    `;
    const variables = {
      boardId: String(boardId),
      itemName: String(itemName).slice(0, 255),
    };
    const result = await callMonday(query, variables);
    return result.data.create_item.id;
  }

  // ── Post comment — reads credentials internally ────────────────────────────

  async function createUpdate(itemId, payload) {
    const date = new Date().toISOString().slice(0, 10);
    const body = [
      '🔗 LinkedIn: '  + (payload.linkedin_url  || ''),
      '🏭 Industry: '  + (payload.industry       || ''),
      '👥 Size: '      + (payload.size           || ''),
      '📍 HQ: '        + (payload.headquarters   || ''),
      '🌐 Website: '   + (payload.website        || ''),
      '📝 About: '     + (payload.description    || ''),
      '➕ Added via Pipeline Button on ' + date,
    ].join('\n');

    const query = `
      mutation CreateUpdate($itemId: ID!, $body: String!) {
        create_update(item_id: $itemId, body: $body) {
          id
        }
      }
    `;
    const variables = {
      itemId: String(itemId),
      body,
    };
    return callMonday(query, variables);
  }

  // ── Board name verification — reads token from storage, not from message ──

  async function getBoardName() {
    const { MONDAY_API_TOKEN: token, MONDAY_BOARD_ID: boardId } = await readCredentials();
    if (!token) throw new Error('Invalid API token');
    if (!boardId) throw new Error('Board ID not configured');

    const query = `
      query GetBoard($boardId: ID!) {
        boards(ids: [$boardId]) {
          name
        }
      }
    `;
    const response = await fetchWithTimeout(MONDAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token,
        'API-Version': '2024-01',
      },
      body: JSON.stringify({ query, variables: { boardId: String(boardId) } }),
    });

    if (response.status === 401) throw new Error('Invalid API token');
    if (!response.ok) throw new Error('Monday API request failed');

    const json = await response.json();
    if (json.errors && json.errors.length > 0) throw new Error('Monday API returned an error');

    const boards = json.data && json.data.boards;
    if (!boards || boards.length === 0) throw new Error('Board not found');
    return boards[0].name;
  }

  // ── Prototype-pollution guard ─────────────────────────────────────────────

  const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

  function isSafe(value) {
    return !DANGEROUS_KEYS.has(String(value).toLowerCase().trim());
  }

  // ── Message handler ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !ALLOWED_MESSAGES.has(message.type)) {
      sendResponse({ success: false, error: 'Unknown message type' });
      return false;
    }

    if (message.type === 'CHECK_CONFIG') {
      handleCheckConfig(sendResponse);
      return true;
    }

    if (message.type === 'ADD_TO_PIPELINE') {
      handleAddToPipeline(message.payload, sendResponse);
      return true;
    }

    if (message.type === 'VERIFY_CONNECTION') {
      handleVerifyConnection(sendResponse);
      return true;
    }
  });

  async function handleCheckConfig(sendResponse) {
    try {
      const { MONDAY_API_TOKEN, MONDAY_BOARD_ID } = await readCredentials();
      sendResponse({
        configured: !!(MONDAY_API_TOKEN && MONDAY_BOARD_ID),
      });
    } catch (_) {
      sendResponse({ configured: false });
    }
  }

  async function handleAddToPipeline(payload, sendResponse) {
    try {
      const { MONDAY_API_TOKEN, MONDAY_BOARD_ID } = await readCredentials();

      if (!MONDAY_API_TOKEN) {
        sendResponse({ success: false, error: 'API token not configured' });
        return;
      }
      if (!MONDAY_BOARD_ID) {
        sendResponse({ success: false, error: 'Board ID not configured' });
        return;
      }

      if (!payload || !isSafe(payload.name || '')) {
        sendResponse({ success: false, error: 'Invalid company name' });
        return;
      }

      const itemId = await createItem(payload.name || 'Unknown Company');
      await createUpdate(itemId, payload);

      const { PIPELINE_HISTORY = [] } = await new Promise(resolve =>
        chrome.storage.sync.get(['PIPELINE_HISTORY'], resolve)
      );

      const entry = {
        name: (payload.name || 'Unknown').slice(0, 100),
        timestamp: Date.now(),
        itemId,
      };
      const updated = [entry, ...PIPELINE_HISTORY].slice(0, 5);
      await new Promise(resolve => chrome.storage.sync.set({ PIPELINE_HISTORY: updated }, resolve));

      sendResponse({ success: true, itemId });
    } catch (err) {
      const safe = err.message === 'Invalid API token'
        ? 'Invalid API token'
        : 'Failed to add to pipeline';
      sendResponse({ success: false, error: safe });
    }
  }

  // VERIFY_CONNECTION reads token from storage — it is never in the message payload
  async function handleVerifyConnection(sendResponse) {
    try {
      const boardName = await getBoardName();
      sendResponse({ success: true, boardName });
    } catch (err) {
      const safe = err.message === 'Invalid API token'
        ? 'Invalid API token'
        : 'Connection failed';
      sendResponse({ success: false, error: safe });
    }
  }
})();

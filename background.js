(() => {
  'use strict';

  const MONDAY_API_URL = 'https://api.monday.com/v2';
  const FETCH_TIMEOUT_MS = 15_000;
  const RATE_LIMIT_WAIT_MS = 30_000;

  // ── Safety guard ──────────────────────────────────────────────────────────

  const ALLOWED_OPERATIONS = new Set(['create_item', 'create_update']);

  function assertSafe(query) {
    const normalized = query.replace(/\s+/g, ' ').toLowerCase();
    const dangerous = [
      'delete_item', 'delete_board', 'delete_column', 'delete_group',
      'delete_update', 'delete_workspace', 'archive_item', 'archive_board',
      'move_item_to_board', 'clear_item_updates',
    ];
    for (const op of dangerous) {
      if (normalized.includes(op)) {
        throw new Error(`SAFETY ERROR: blocked dangerous mutation: ${op}`);
      }
    }
    // Also require that only allowed operations are present
    const hasCreate = normalized.includes('create_item') || normalized.includes('create_update');
    if (!hasCreate) {
      throw new Error('SAFETY ERROR: query does not contain an allowed operation');
    }
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

  // ── Monday API call ───────────────────────────────────────────────────────

  async function callMonday(token, query, variables) {
    assertSafe(query);

    const body = JSON.stringify({ query, variables });

    let response = await fetchWithTimeout(MONDAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token,
        'API-Version': '2024-01',
      },
      body,
    });

    // Rate limit — wait and retry once
    if (response.status === 429) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_WAIT_MS));
      response = await fetchWithTimeout(MONDAY_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token,
          'API-Version': '2024-01',
        },
        body,
      });
    }

    if (response.status === 401) {
      throw new Error('Invalid API token');
    }

    if (!response.ok) {
      throw new Error(`Monday API error: ${response.status}`);
    }

    const json = await response.json();

    if (json.errors && json.errors.length > 0) {
      throw new Error(`Monday API error: ${json.errors[0].message}`);
    }

    return json;
  }

  // ── Create Monday item ────────────────────────────────────────────────────

  async function createItem(token, boardId, itemName) {
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
    const result = await callMonday(token, query, variables);
    return result.data.create_item.id;
  }

  // ── Post comment with details ─────────────────────────────────────────────

  async function createUpdate(token, itemId, payload) {
    const date = new Date().toISOString().slice(0, 10);
    const body = [
      `🔗 LinkedIn: ${payload.linkedin_url || ''}`,
      `🏭 Industry: ${payload.industry || ''}`,
      `👥 Size: ${payload.size || ''}`,
      `📍 HQ: ${payload.headquarters || ''}`,
      `🌐 Website: ${payload.website || ''}`,
      `📝 About: ${payload.description || ''}`,
      `➕ Added via Pipeline Button on ${date}`,
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
    return callMonday(token, query, variables);
  }

  // ── Board name verification (used by popup) ───────────────────────────────

  async function getBoardName(token, boardId) {
    const query = `
      query GetBoard($boardId: ID!) {
        boards(ids: [$boardId]) {
          name
        }
      }
    `;
    // Board query is read-only — bypass assertSafe which requires a create op
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
    if (!response.ok) throw new Error(`Monday API error: ${response.status}`);

    const json = await response.json();
    if (json.errors && json.errors.length > 0) throw new Error(json.errors[0].message);

    const boards = json.data && json.data.boards;
    if (!boards || boards.length === 0) throw new Error('Board not found');
    return boards[0].name;
  }

  // ── Message handler ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'ADD_TO_PIPELINE') {
      handleAddToPipeline(message.payload, sendResponse);
      return true; // keep channel open for async response
    }

    if (message.type === 'VERIFY_CONNECTION') {
      handleVerifyConnection(message.payload, sendResponse);
      return true;
    }

    if (message.type === 'OPEN_POPUP') {
      // No-op in MV3 — popup must be opened by user gesture
      return false;
    }
  });

  async function handleAddToPipeline(payload, sendResponse) {
    try {
      const { MONDAY_API_TOKEN, MONDAY_BOARD_ID } = await new Promise(resolve =>
        chrome.storage.sync.get(['MONDAY_API_TOKEN', 'MONDAY_BOARD_ID'], resolve)
      );

      if (!MONDAY_API_TOKEN || MONDAY_API_TOKEN === 'YOUR_TOKEN_HERE') {
        sendResponse({ success: false, error: 'API token not configured' });
        return;
      }

      if (!MONDAY_BOARD_ID) {
        sendResponse({ success: false, error: 'Board ID not configured' });
        return;
      }

      const itemId = await createItem(MONDAY_API_TOKEN, MONDAY_BOARD_ID, payload.name || 'Unknown Company');
      await createUpdate(MONDAY_API_TOKEN, itemId, payload);

      // Record in history (last 5)
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

  async function handleVerifyConnection(payload, sendResponse) {
    try {
      const name = await getBoardName(payload.token, payload.boardId);
      sendResponse({ success: true, boardName: name });
    } catch (err) {
      const safe = err.message === 'Invalid API token'
        ? 'Invalid API token'
        : 'Connection failed';
      sendResponse({ success: false, error: safe });
    }
  }
})();

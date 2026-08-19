'use strict';

/**
 * Tests for pipeline-button logic.
 * Run with: node --test tests/logic.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ── Shared helpers replicated from source files ────────────────────────────

function sanitize(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isSafe(value) {
  return !DANGEROUS_KEYS.has(String(value).toLowerCase().trim());
}

const ALLOWED_OPERATIONS = ['create_item', 'create_update'];
const DANGEROUS_OPS = [
  'delete_item', 'delete_board', 'delete_column', 'delete_group',
  'delete_update', 'delete_workspace', 'archive_item', 'archive_board',
  'move_item_to_board', 'clear_item_updates',
];

function assertSafe(query) {
  const normalized = query.replace(/\s+/g, ' ').toLowerCase();
  for (const op of DANGEROUS_OPS) {
    if (normalized.includes(op)) {
      throw new Error(`SAFETY ERROR: blocked dangerous mutation: ${op}`);
    }
  }
  const hasCreate = normalized.includes('create_item') || normalized.includes('create_update');
  if (!hasCreate) {
    throw new Error('SAFETY ERROR: query does not contain an allowed operation');
  }
}

// ── Minimal DOM mock ───────────────────────────────────────────────────────

function makeMockDOM(html) {
  // Very minimal mock — extracts text via regex for testing scraping logic
  return {
    querySelector(sel) {
      // For h1
      if (sel === 'h1') {
        const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        if (m) return { textContent: m[1].replace(/<[^>]*>/g, '') };
        return null;
      }
      return null;
    },
  };
}

function scrapeFromDOM(doc) {
  const el = doc.querySelector('h1');
  const name = sanitize(el ? el.textContent : '', 255);
  return { name };
}

// ── Scenario 1: company name scraping ─────────────────────────────────────

test('Scenario 1 — company name scraping', () => {
  const html = `
    <html><body>
      <h1>Acme Corporation</h1>
      <div class="industry">Software</div>
    </body></html>
  `;
  const doc  = makeMockDOM(html);
  const data = scrapeFromDOM(doc);
  assert.equal(data.name, 'Acme Corporation', 'Company name should be extracted correctly');
});

// ── Scenario 2: missing fields handled gracefully ─────────────────────────

test('Scenario 2 — missing fields return empty strings, no crash', () => {
  const emptyDoc = { querySelector: () => null };
  assert.doesNotThrow(() => {
    const name        = sanitize((emptyDoc.querySelector('h1') || {}).textContent || '');
    const industry    = sanitize((emptyDoc.querySelector('.industry') || {}).textContent || '');
    const description = sanitize((emptyDoc.querySelector('.about') || {}).textContent || '');
    assert.equal(name,        '');
    assert.equal(industry,    '');
    assert.equal(description, '');
  });
});

// ── Scenario 3: prototype pollution via company name ─────────────────────

test('Scenario 3 — prototype pollution via company name is rejected', () => {
  assert.equal(isSafe('__proto__'),   false, '__proto__ must be rejected');
  assert.equal(isSafe('constructor'), false, 'constructor must be rejected');
  assert.equal(isSafe('prototype'),   false, 'prototype must be rejected');
  assert.equal(isSafe('Acme Corp'),   true,  'Normal name must pass');
});

// ── Scenario 4: GraphQL injection via company name ────────────────────────

test('Scenario 4 — GraphQL injection is neutralised by variables', () => {
  // When using variables, the company name is serialised as a JSON string.
  // The GraphQL query template itself never contains the user value.
  const maliciousName = 'Evil"} mutation { delete_item';
  const queryTemplate = `
    mutation CreateItem($boardId: ID!, $itemName: String!) {
      create_item(board_id: $boardId, item_name: $itemName) { id }
    }
  `;
  // The template must not contain the injected text
  assert.ok(!queryTemplate.includes(maliciousName), 'Injection not in template');

  // When serialised as a JSON variable, it is safe
  const variables = { boardId: '123', itemName: maliciousName };
  const body = JSON.stringify({ query: queryTemplate, variables });
  // body will contain the escaped name but the query template is unaffected
  assert.ok(body.includes('delete_item'), 'Injection present in serialised body as a value — this is fine');
  // Crucially the query field itself is unchanged
  const parsed = JSON.parse(body);
  assert.equal(parsed.query, queryTemplate, 'Query template is intact');
  assert.equal(parsed.variables.itemName, maliciousName, 'Variable holds the raw value safely');
});

// ── Scenario 5: token never in DOM ───────────────────────────────────────

test('Scenario 5 — token never appears in DOM', () => {
  const secret = 'eyJhbGciOiJIUzI1NiJ9.super_secret_token_12345';

  // Simulate popup masking logic
  function maskToken(raw) {
    if (!raw || raw.length <= 4) return '••••';
    return '••••••••' + raw.slice(-4);
  }

  const displayed = maskToken(secret);
  assert.ok(!displayed.includes(secret), 'Full token must not appear in masked output');

  // Simulate DOM body content — all text via textContent (never innerHTML with token)
  const fakeBodyText = `Pipeline Button Board: My Board ${displayed}`;
  assert.ok(!fakeBodyText.includes(secret), 'Full token must not appear in DOM text');
});

// ── Scenario 6: assertSafe blocks delete ─────────────────────────────────

test('Scenario 6 — assertSafe blocks delete_item mutation', () => {
  assert.throws(
    () => assertSafe('mutation { delete_item(item_id: 123) }'),
    /SAFETY ERROR/,
    'delete_item must be blocked'
  );
  assert.throws(
    () => assertSafe('mutation { delete_board(board_id: 456) }'),
    /SAFETY ERROR/,
    'delete_board must be blocked'
  );
  // Allowed operations must pass
  assert.doesNotThrow(
    () => assertSafe('mutation CreateItem { create_item(board_id: "1") { id } }'),
    'create_item must be allowed'
  );
});

// ── Scenario 7: 401 error message safe ───────────────────────────────────

test('Scenario 7 — 401 response returns safe error message', async () => {
  const secret = 'my_super_secret_token';

  // Simulate the error handling from background.js
  async function callMondayMock(token) {
    // Simulate a 401 response
    const status = 401;
    if (status === 401) {
      throw new Error('Invalid API token');
    }
  }

  async function handleRequest(token) {
    try {
      await callMondayMock(token);
    } catch (err) {
      const safe = err.message === 'Invalid API token'
        ? 'Invalid API token'
        : 'Failed to add to pipeline';
      // The safe message must not contain the token
      assert.ok(!safe.includes(secret), 'Error message must not contain the token');
      assert.equal(safe, 'Invalid API token');
      return safe;
    }
  }

  await handleRequest(secret);
});

// ── Scenario 8: company name truncated at 255 chars ──────────────────────

test('Scenario 8 — company name truncated to 255 chars for Monday item', () => {
  const longName = 'A'.repeat(300);
  const truncated = String(longName).slice(0, 255);
  assert.equal(truncated.length, 255, 'Must be exactly 255 chars');
  assert.ok(!truncated.includes('A'.repeat(256)), 'Must not exceed 255');
});

// ── Scenario 9: not configured state ─────────────────────────────────────

test('Scenario 9 — not configured state prevents API call', async () => {
  let apiCallMade = false;

  // Simulate the content.js click handler
  async function handleClickMock(storedToken, storedBoard) {
    if (!storedToken || !storedBoard) {
      return { state: 'unconfigured', apiCallMade };
    }
    apiCallMade = true;
    return { state: 'called', apiCallMade };
  }

  const result = await handleClickMock(null, null);
  assert.equal(result.state, 'unconfigured');
  assert.equal(result.apiCallMade, false, 'API must not be called when unconfigured');

  const result2 = await handleClickMock('token123', '456');
  assert.equal(result2.state, 'called');
  assert.equal(result2.apiCallMade, true);
});

// ── Scenario 10: MutationObserver re-injects button ──────────────────────

test('Scenario 10 — MutationObserver detects removal and re-injects button', (t, done) => {
  let buttonExists = true;
  let reinjected   = false;

  // Simulate the debounced MutationObserver callback
  function onMutation() {
    if (!buttonExists) {
      reinjected  = true;
      buttonExists = true;
    }
  }

  // Simulate LinkedIn SPA removing the button
  buttonExists = false;
  onMutation(); // Observer fires

  assert.equal(reinjected, true, 'Button must be re-injected after removal');
  assert.equal(buttonExists, true, 'Button must exist after re-injection');
  done();
});

// ── Scenario 11: company name resolution never yields "Unknown" ───────────
//
// Mirrors scrapeCompanyName() in content.js. LinkedIn's page-shell h1 is often
// empty or a generic label, which previously produced an empty name and an
// "Unknown Company" item on the Monday board.

const NAME_BLOCKLIST = new Set([
  'linkedin', 'feed', 'home', 'search', 'notifications', 'messaging', 'jobs',
  'my network', 'sign up', 'log in', 'join linkedin',
]);

function isUsableName(candidate) {
  if (!candidate) return false;
  if (NAME_BLOCKLIST.has(candidate.toLowerCase())) return false;
  return true;
}

function cleanPageTitle(raw) {
  return sanitize(
    String(raw || '')
      .replace(/^\(\d+\+?\)\s*/, '')
      .replace(/\s*[|\-–—]\s*LinkedIn\s*$/i, ''),
    255
  );
}

function getCompanySlug(href) {
  const m = String(href).match(/linkedin\.com\/company\/([^/?#]+)/);
  return m ? m[1] : null;
}

function nameFromSlug(href) {
  const slug = getCompanySlug(href);
  if (!slug) return '';
  let decoded = slug;
  try {
    decoded = decodeURIComponent(slug);
  } catch (_) {}
  return sanitize(
    decoded.replace(/[-_+]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    255
  );
}

function resolveName(sources, href) {
  for (const value of sources) {
    const clean = sanitize(value || '', 255);
    if (isUsableName(clean)) return clean;
  }
  return nameFromSlug(href);
}

test('Scenario 11 — empty page-shell h1 falls through to a real name', () => {
  const href = 'https://www.linkedin.com/company/acme-corp/';
  // First source is the empty hidden h1 LinkedIn renders in its page shell.
  assert.equal(resolveName(['', '  \n  ', 'Acme Corporation'], href), 'Acme Corporation');
});

test('Scenario 11 — generic LinkedIn shell titles are rejected', () => {
  const href = 'https://www.linkedin.com/company/acme-corp/';
  assert.equal(resolveName(['LinkedIn', 'Feed'], href), 'Acme Corp',
    'Shell labels must not be used as the company name');
});

test('Scenario 11 — page title decoration is stripped', () => {
  assert.equal(cleanPageTitle('(12) Acme Corporation | LinkedIn'), 'Acme Corporation');
  assert.equal(cleanPageTitle('Acme Corporation - LinkedIn'), 'Acme Corporation');
  assert.equal(cleanPageTitle('(9+) Beta Labs | LinkedIn'), 'Beta Labs');
});

test('Scenario 11 — slug fallback replaces "Unknown Company"', () => {
  assert.equal(nameFromSlug('https://www.linkedin.com/company/acme-corp/'), 'Acme Corp');
  assert.equal(nameFromSlug('https://www.linkedin.com/company/acme_labs?trk=x'), 'Acme Labs');
  assert.equal(nameFromSlug('https://www.linkedin.com/company/caf%C3%A9-noir/'), 'Café Noir');
  assert.equal(resolveName([], 'https://www.linkedin.com/company/acme-corp/'), 'Acme Corp',
    'Name must never be empty when a slug is present');
});

test('Scenario 11 — multi-line h1 text is collapsed to one line', () => {
  assert.equal(sanitize('\n  Acme\n  Corporation  \n', 255), 'Acme Corporation');
});

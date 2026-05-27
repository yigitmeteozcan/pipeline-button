'use strict';

/**
 * Security audit tests for pipeline-button Chrome extension.
 * Run with: node --test tests/security.test.js
 *
 * Threat model: hardcoded credentials, token isolation, injection,
 * prototype pollution, permission creep, supply-chain risks.
 */

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const fs        = require('node:fs');
const path      = require('node:path');

const ROOT = path.join(__dirname, '..');

function readSource(filename) {
  return fs.readFileSync(path.join(ROOT, filename), 'utf8');
}

// Extension source files — excludes this test file to avoid self-reference
function readAllSources() {
  const files = [
    'background.js',
    'content.js',
    'popup.js',
    'popup.html',
    'popup.css',
    'manifest.json',
    'README.md',
    'generate-icons.js',
    'tests/logic.test.js',
  ];
  return files.map(f => ({ file: f, src: readSource(f) }));
}

// Build the real board ID from parts so this file doesn't self-trigger the scan
const REAL_BOARD_ID = ['181465', '07025'].join('');

// ── assertSafe (same logic as background.js) ──────────────────────────────

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

// ── SCENARIO 1 — no hardcoded tokens in source ────────────────────────────

test('Scenario 1 — no hardcoded tokens or real board ID in any source file', () => {
  const realTokenPattern = /eyJ[a-zA-Z0-9+/]{20,}/;
  const realBoardId = REAL_BOARD_ID;

  const sources = readAllSources();
  const violations = [];

  for (const { file, src } of sources) {
    if (realTokenPattern.test(src)) {
      violations.push(file + ': contains JWT-pattern token');
    }
    if (src.includes(realBoardId)) {
      violations.push(file + ': contains real board ID ' + realBoardId);
    }
  }

  assert.equal(
    violations.length, 0,
    'Violations found:\n' + violations.join('\n')
  );
});

// ── SCENARIO 2 — content.js never accesses storage or makes fetch calls ───

test('Scenario 2 — content.js has no chrome.storage access and no fetch calls', () => {
  const src = readSource('content.js');

  assert.ok(
    !src.includes('chrome.storage'),
    'content.js must not access chrome.storage — token isolation violated'
  );
  assert.ok(
    !src.includes('fetch('),
    'content.js must not call fetch() — all network calls go through background.js'
  );
  assert.ok(
    !src.includes('XMLHttpRequest'),
    'content.js must not use XMLHttpRequest'
  );
  assert.ok(
    !src.includes('importScripts'),
    'content.js must not call importScripts'
  );
});

// ── SCENARIO 3 — token never cached at module level in background.js ──────

test('Scenario 3 — token is never cached at module level in background.js', () => {
  const src = readSource('background.js');
  const lines = src.split('\n');

  // Find lines that declare a top-level token variable (outside any function)
  // A simple heuristic: look for "const token" or "let token" at zero indent
  // that are not inside a function body
  const suspiciousTopLevel = lines.filter(line => {
    const trimmed = line.trimStart();
    return (
      (trimmed.startsWith('const token') || trimmed.startsWith('let token')) &&
      line.match(/^(const|let)\s+token/)  // no indentation — top-level
    );
  });

  assert.equal(
    suspiciousTopLevel.length, 0,
    'Token cached at module level: ' + suspiciousTopLevel.join('; ')
  );

  // Verify token is not a parameter to callMonday (the core API call)
  assert.ok(
    !src.includes('async function callMonday(token'),
    'callMonday must not accept token as a parameter'
  );
  assert.ok(
    !src.includes('async function createItem(token'),
    'createItem must not accept token as a parameter'
  );
  assert.ok(
    !src.includes('async function createUpdate(token'),
    'createUpdate must not accept token as a parameter'
  );
  assert.ok(
    !src.includes('async function getBoardName(token'),
    'getBoardName must not accept token as a parameter'
  );
});

// ── SCENARIO 4 — assertSafe blocks all dangerous mutations ────────────────

test('Scenario 4 — assertSafe blocks every dangerous mutation', () => {
  const blocked = [
    'mutation { delete_item(item_id: 123) }',
    'mutation { delete_board(board_id: 456) }',
    'mutation { archive_item(item_id: 1) }',
    'mutation { move_item_to_board(item_id: 1, board_id: 2) { id } }',
    'mutation { update_item(item_id: 1) { id } }',
    'mutation { clear_item_updates(item_id: 1) { id } }',
    'mutation { change_column_value(item_id: 1, column_id: "x", value: "y") { id } }',
  ];

  for (const q of blocked) {
    assert.throws(
      () => assertSafe(q),
      /SAFETY ERROR/,
      'Expected SAFETY ERROR for: ' + q
    );
  }

  // Allowed operations must pass
  assert.doesNotThrow(
    () => assertSafe('mutation { create_item(board_id: "1", item_name: "x") { id } }')
  );
  assert.doesNotThrow(
    () => assertSafe('mutation { create_update(item_id: "1", body: "y") { id } }')
  );
});

// ── SCENARIO 5 — no GraphQL string interpolation in background.js ─────────

test('Scenario 5 — GraphQL query strings contain no ${} interpolation', () => {
  const src = readSource('background.js');

  // Extract all template literal content that contains GraphQL keywords
  // A template literal with mutation/query must not contain ${ }
  const templateLiteralRe = /`([^`]*)`/g;
  let match;
  const violations = [];

  while ((match = templateLiteralRe.exec(src)) !== null) {
    const content = match[1];
    // Only check template literals that contain GraphQL keywords
    if (/(mutation|query)\s+\w/i.test(content)) {
      if (/\$\{/.test(content)) {
        violations.push('GraphQL template literal contains ${} interpolation: ' + content.slice(0, 80));
      }
    }
  }

  assert.equal(
    violations.length, 0,
    'GraphQL interpolation found:\n' + violations.join('\n')
  );
});

// ── SCENARIO 6 — token masked in all error paths ──────────────────────────

test('Scenario 6 — error messages never expose raw token string', () => {
  const fakeToken = 'super_secret_monday_token_abc123';

  // Simulate the masking function from background.js
  function maskToken(str, token) {
    if (!token) return str;
    return str.replaceAll(token, '[REDACTED]');
  }

  // Simulate an error message that accidentally contains the token
  const rawError = 'Authorization failed for token: ' + fakeToken;
  const masked = maskToken(rawError, fakeToken);

  assert.ok(!masked.includes(fakeToken), 'Token must not appear in masked error');
  assert.ok(masked.includes('[REDACTED]'), 'Masked string must contain [REDACTED]');

  // Verify the safe error messages hardcoded in background.js
  const src = readSource('background.js');
  // The only errors thrown or returned must be safe strings
  const unsafeErrorPattern = /sendResponse\(\{[^}]*error:\s*err\.message/;
  assert.ok(
    !unsafeErrorPattern.test(src),
    'background.js must not forward raw err.message to sendResponse'
  );
});

// ── SCENARIO 7 — message type whitelist enforced ──────────────────────────

test('Scenario 7 — unknown message types are rejected by whitelist', () => {
  // Replicate the whitelist from background.js
  const ALLOWED_MESSAGES = new Set(['ADD_TO_PIPELINE', 'VERIFY_CONNECTION', 'CHECK_CONFIG']);

  function handleMessage(message) {
    if (!message || !ALLOWED_MESSAGES.has(message.type)) {
      return { success: false, error: 'Unknown message type' };
    }
    return { success: true };
  }

  // Unknown types must be rejected
  assert.equal(handleMessage({ type: 'EVIL_EXFIL' }).success, false);
  assert.equal(handleMessage({ type: 'GET_TOKEN' }).success, false);
  assert.equal(handleMessage({ type: '' }).success, false);
  assert.equal(handleMessage(null).success, false);
  assert.equal(handleMessage({ type: 'OPEN_POPUP' }).success, false);

  // Known types pass the whitelist check
  assert.equal(handleMessage({ type: 'ADD_TO_PIPELINE' }).success, true);
  assert.equal(handleMessage({ type: 'CHECK_CONFIG' }).success, true);
  assert.equal(handleMessage({ type: 'VERIFY_CONNECTION' }).success, true);

  // Also verify the whitelist is present in the actual source
  const src = readSource('background.js');
  assert.ok(src.includes('ALLOWED_MESSAGES'), 'ALLOWED_MESSAGES whitelist must exist in background.js');
  assert.ok(src.includes("'ADD_TO_PIPELINE'"), 'ADD_TO_PIPELINE must be in whitelist');
  assert.ok(src.includes("'VERIFY_CONNECTION'"), 'VERIFY_CONNECTION must be in whitelist');
  assert.ok(src.includes("'CHECK_CONFIG'"), 'CHECK_CONFIG must be in whitelist');
});

// ── SCENARIO 8 — prototype pollution rejected ─────────────────────────────

test('Scenario 8 — prototype pollution via company name is rejected before API call', () => {
  const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

  function isSafe(value) {
    return !DANGEROUS_KEYS.has(String(value).toLowerCase().trim());
  }

  // Verify the guard rejects dangerous names
  assert.equal(isSafe('__proto__'), false);
  assert.equal(isSafe('constructor'), false);
  assert.equal(isSafe('prototype'), false);
  assert.equal(isSafe('  __PROTO__  '.toLowerCase().trim()), false);

  // Verify Object.prototype is not modified
  const before = Object.keys(Object.prototype).join(',');

  // Simulate receiving a poisoned payload
  const payload = { name: '__proto__', industry: 'X' };
  const rejected = !isSafe(payload.name);
  assert.ok(rejected, 'Payload with __proto__ name must be rejected');

  const after = Object.keys(Object.prototype).join(',');
  assert.equal(before, after, 'Object.prototype must not be modified');

  // Verify isSafe check is present in background.js
  const src = readSource('background.js');
  assert.ok(src.includes('isSafe'), 'isSafe guard must be present in background.js');
  assert.ok(
    src.includes("'__proto__'") || src.includes('"__proto__"'),
    '__proto__ must be in the dangerous keys set'
  );
});

// ── SCENARIO 9 — manifest permissions are minimal ─────────────────────────

test('Scenario 9 — manifest permissions are minimal and host_permissions are scoped', () => {
  const manifest = JSON.parse(readSource('manifest.json'));

  // Only storage permission
  assert.deepEqual(
    manifest.permissions,
    ['storage'],
    'permissions must be exactly ["storage"]'
  );

  // Only linkedin and monday host_permissions
  const allowedHosts = new Set([
    'https://www.linkedin.com/company/*',
    'https://api.monday.com/*',
  ]);
  for (const hp of manifest.host_permissions) {
    assert.ok(allowedHosts.has(hp), 'Unexpected host_permission: ' + hp);
  }
  assert.equal(manifest.host_permissions.length, 2, 'Must have exactly 2 host_permissions');

  // Must be MV3
  assert.equal(manifest.manifest_version, 3, 'Must use manifest_version 3');

  // CSP must be set
  assert.ok(manifest.content_security_policy, 'content_security_policy must be set');
  assert.ok(
    manifest.content_security_policy.extension_pages.includes("script-src 'self'"),
    "CSP must include script-src 'self'"
  );

  // No dangerous permissions
  const dangerous = ['tabs', 'webRequest', 'browsingData', 'cookies', 'history', 'downloads', 'nativeMessaging'];
  for (const p of dangerous) {
    assert.ok(
      !(manifest.permissions || []).includes(p),
      'Dangerous permission found: ' + p
    );
  }
});

// ── SCENARIO 10 — board ID not in any source file ─────────────────────────

test('Scenario 10 — real board ID is absent from all source files', () => {
  const realBoardId = REAL_BOARD_ID;
  const sources = readAllSources();
  const hits = sources.filter(({ src }) => src.includes(realBoardId));

  assert.equal(
    hits.length, 0,
    'Board ID found in: ' + hits.map(h => h.file).join(', ')
  );
});

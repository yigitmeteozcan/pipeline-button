'use strict';

/**
 * Security audit tests for pipeline-button Chrome extension.
 * Run with: node --test tests/security.test.js
 *
 * Threat model: hardcoded credentials, token isolation, injection,
 * prototype pollution, permission creep, supply-chain risks, sender spoofing.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const ROOT = path.join(__dirname, '..');

function readSource(filename) {
  return fs.readFileSync(path.join(ROOT, filename), 'utf8');
}

// Extension source files — excludes this test file to avoid self-reference
function readAllSources() {
  return [
    'background.js',
    'content.js',
    'popup.js',
    'popup.html',
    'popup.css',
    'manifest.json',
    'README.md',
    'generate-icons.js',
    'tests/logic.test.js',
  ].map(f => ({ file: f, src: readSource(f) }));
}

// Build the real board ID from parts so this file doesn't self-trigger the scan
const REAL_BOARD_ID = ['181465', '07025'].join('');

// ── assertSafe replicated from background.js ──────────────────────────────

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
  const hasCreate =
    normalized.includes('create_item') || normalized.includes('create_update');
  if (!hasCreate) {
    throw new Error('SAFETY ERROR: query does not contain an allowed operation');
  }
}

// ── SCENARIO 1 — no hardcoded tokens in source ────────────────────────────

test('Scenario 1 — no hardcoded tokens or real board ID in any source file', () => {
  const realTokenPattern = /eyJ[a-zA-Z0-9+/]{20,}/;

  const violations = [];
  for (const { file, src } of readAllSources()) {
    if (realTokenPattern.test(src)) {
      violations.push(file + ': contains JWT-pattern token');
    }
    if (src.includes(REAL_BOARD_ID)) {
      violations.push(file + ': contains real board ID');
    }
  }

  assert.equal(violations.length, 0, 'Violations:\n' + violations.join('\n'));
});

// ── SCENARIO 2 — content.js never accesses storage or makes fetch calls ───

test('Scenario 2 — content.js has no direct storage access and no fetch calls', () => {
  const src = readSource('content.js');

  assert.ok(!src.includes('chrome.storage'),
    'content.js must not access chrome.storage — use CHECK_CONFIG message instead');
  assert.ok(!src.includes('fetch('),
    'content.js must not call fetch() — all network calls go through background.js');
  assert.ok(!src.includes('XMLHttpRequest'),
    'content.js must not use XMLHttpRequest');
  assert.ok(!src.includes('importScripts'),
    'content.js must not call importScripts');
});

// ── SCENARIO 3 — token never cached at module level ───────────────────────

test('Scenario 3 — token never cached at module level in background.js', () => {
  const src = readSource('background.js');
  const lines = src.split('\n');

  const suspiciousTopLevel = lines.filter(line =>
    (line.startsWith('const token') || line.startsWith('let token'))
  );

  assert.equal(suspiciousTopLevel.length, 0,
    'Token at top-level scope: ' + suspiciousTopLevel.join('; '));

  assert.ok(!src.includes('async function callMonday(token'),
    'callMonday must not accept token as a parameter');
  assert.ok(!src.includes('async function createItem(token'),
    'createItem must not accept token as a parameter');
  assert.ok(!src.includes('async function createUpdate(token'),
    'createUpdate must not accept token as a parameter');
  assert.ok(!src.includes('async function getBoardName(token'),
    'getBoardName must not accept token as a parameter');
  assert.ok(!src.includes('async function executeMondayRequest(token'),
    'executeMondayRequest must not accept token as a parameter');
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
    'mutation { duplicate_item(item_id: 1) { id } }',
    'mutation { change_multiple_column_values(item_id: 1) { id } }',
  ];

  for (const q of blocked) {
    assert.throws(() => assertSafe(q), /SAFETY ERROR/, 'Expected block for: ' + q);
  }

  assert.doesNotThrow(
    () => assertSafe('mutation { create_item(board_id: "1", item_name: "x") { id } }')
  );
  assert.doesNotThrow(
    () => assertSafe('mutation { create_update(item_id: "1", body: "y") { id } }')
  );
});

// ── SCENARIO 5 — no GraphQL string interpolation ──────────────────────────

test('Scenario 5 — GraphQL query strings contain no ${} interpolation', () => {
  const src = readSource('background.js');
  const templateLiteralRe = /`([^`]*)`/g;
  let match;
  const violations = [];

  while ((match = templateLiteralRe.exec(src)) !== null) {
    const content = match[1];
    if (/(mutation|query)\s+\w/i.test(content) && /\$\{/.test(content)) {
      violations.push('Interpolation in GraphQL literal: ' + content.slice(0, 80));
    }
  }

  assert.equal(violations.length, 0, violations.join('\n'));
});

// ── SCENARIO 6 — token masked in all error paths ──────────────────────────

test('Scenario 6 — error messages never expose raw token string', () => {
  const fakeToken = 'super_secret_monday_token_abc123';

  function maskToken(str, token) {
    if (!token) return str;
    return str.replaceAll(token, '[REDACTED]');
  }

  const rawError = 'Authorization failed for token: ' + fakeToken;
  const masked = maskToken(rawError, fakeToken);

  assert.ok(!masked.includes(fakeToken), 'Token must not appear in masked error');
  assert.ok(masked.includes('[REDACTED]'), 'Masked string must contain [REDACTED]');

  const src = readSource('background.js');
  // Raw err.message must never flow directly into sendResponse
  const unsafePattern = /sendResponse\(\{[^}]*error:\s*err\.message/;
  assert.ok(!unsafePattern.test(src),
    'background.js must not forward raw err.message to sendResponse');
});

// ── SCENARIO 7 — message type whitelist ───────────────────────────────────

test('Scenario 7 — unknown message types are rejected by whitelist', () => {
  const ALLOWED = new Set(['ADD_TO_PIPELINE', 'VERIFY_CONNECTION', 'CHECK_CONFIG']);

  function handle(msg) {
    if (!msg || !ALLOWED.has(msg.type)) return { success: false };
    return { success: true };
  }

  assert.equal(handle({ type: 'EVIL_EXFIL' }).success, false);
  assert.equal(handle({ type: 'GET_TOKEN' }).success, false);
  assert.equal(handle({ type: '' }).success, false);
  assert.equal(handle(null).success, false);
  assert.equal(handle({ type: 'OPEN_POPUP' }).success, false);
  assert.equal(handle({ type: 'ADD_TO_PIPELINE' }).success, true);
  assert.equal(handle({ type: 'CHECK_CONFIG' }).success, true);
  assert.equal(handle({ type: 'VERIFY_CONNECTION' }).success, true);

  const src = readSource('background.js');
  assert.ok(src.includes('ALLOWED_MESSAGES'), 'ALLOWED_MESSAGES must exist');
  assert.ok(src.includes("'ADD_TO_PIPELINE'"), 'ADD_TO_PIPELINE in whitelist');
  assert.ok(src.includes("'VERIFY_CONNECTION'"), 'VERIFY_CONNECTION in whitelist');
  assert.ok(src.includes("'CHECK_CONFIG'"), 'CHECK_CONFIG in whitelist');
});

// ── SCENARIO 8 — prototype pollution rejected ─────────────────────────────

test('Scenario 8 — prototype pollution via company name is rejected', () => {
  const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  function isSafe(v) { return !DANGEROUS_KEYS.has(String(v).toLowerCase().trim()); }

  assert.equal(isSafe('__proto__'), false);
  assert.equal(isSafe('constructor'), false);
  assert.equal(isSafe('prototype'), false);

  const before = Object.keys(Object.prototype).join(',');
  const payload = { name: '__proto__' };
  assert.ok(!isSafe(payload.name), 'Poisoned payload must be rejected');
  const after = Object.keys(Object.prototype).join(',');
  assert.equal(before, after, 'Object.prototype must not be modified');

  const src = readSource('background.js');
  assert.ok(src.includes('isSafe'), 'isSafe guard must be present');
  assert.ok(src.includes("'__proto__'") || src.includes('"__proto__"'),
    '__proto__ must be in dangerous keys');
});

// ── SCENARIO 9 — manifest permissions are minimal ─────────────────────────

test('Scenario 9 — manifest permissions are minimal and host_permissions are scoped', () => {
  const manifest = JSON.parse(readSource('manifest.json'));

  assert.deepEqual(manifest.permissions, ['storage'],
    'permissions must be exactly ["storage"]');

  const allowed = new Set([
    'https://www.linkedin.com/company/*',
    'https://api.monday.com/*',
  ]);
  for (const hp of manifest.host_permissions) {
    assert.ok(allowed.has(hp), 'Unexpected host_permission: ' + hp);
  }
  assert.equal(manifest.host_permissions.length, 2, 'Must have exactly 2 host_permissions');
  assert.equal(manifest.manifest_version, 3, 'Must use MV3');
  assert.ok(manifest.content_security_policy, 'CSP must be set');
  assert.ok(
    manifest.content_security_policy.extension_pages.includes("script-src 'self'"),
    "CSP must include script-src 'self'"
  );

  const dangerous = ['tabs', 'webRequest', 'browsingData', 'cookies', 'history', 'downloads', 'nativeMessaging'];
  for (const p of dangerous) {
    assert.ok(!(manifest.permissions || []).includes(p), 'Dangerous permission: ' + p);
  }
});

// ── SCENARIO 10 — board ID absent from all source files ───────────────────

test('Scenario 10 — real board ID is absent from all source files', () => {
  const hits = readAllSources().filter(({ src }) => src.includes(REAL_BOARD_ID));
  assert.equal(hits.length, 0,
    'Board ID found in: ' + hits.map(h => h.file).join(', '));
});

// ── SCENARIO 11 — sender validation in message handler ───────────────────
//
// Prevents a page script on linkedin.com (e.g. via XSS) from sending
// chrome.runtime messages to the background service worker and triggering
// Monday API calls with attacker-controlled payloads.

test('Scenario 11 — message handler rejects messages from unknown senders', () => {
  const src = readSource('background.js');

  // The listener must check sender.id
  assert.ok(
    src.includes('sender.id') && src.includes('chrome.runtime.id'),
    'Message handler must validate sender.id === chrome.runtime.id'
  );

  // The handler must not ignore the sender parameter
  assert.ok(
    !src.includes('_sender'),
    'sender must not be unused (_sender) — it must be validated'
  );

  // Simulate the guard logic
  const myExtId = 'abc123extensionid';

  function handleMessage(message, sender) {
    if (!sender || sender.id !== myExtId) return false; // rejected
    return true; // accepted
  }

  assert.equal(handleMessage({}, { id: myExtId }), true,  'Own extension allowed');
  assert.equal(handleMessage({}, { id: 'evil' }),  false, 'Foreign extension blocked');
  assert.equal(handleMessage({}, null),            false, 'Null sender blocked');
  assert.equal(handleMessage({}, {}),              false, 'No ID blocked');
  // A content script injected by a malicious page would have a different origin
  assert.equal(handleMessage({}, { id: 'mallory-ext' }), false, 'Malicious extension blocked');
});

// ── SCENARIO 12 — URL protocol validation blocks javascript: and data: URLs ─
//
// A tampered LinkedIn DOM could inject javascript:/data:/blob: URLs into
// website links. safeUrl() must reject anything that doesn't start with https://.

test('Scenario 12 — safeUrl rejects non-https URLs including javascript: and data:', () => {
  // Replicate safeUrl from content.js
  function sanitize(str, maxLen = 500) {
    if (typeof str !== 'string') return '';
    return str.replace(/<[^>]*>/g, '').trim().slice(0, maxLen);
  }

  function safeUrl(raw, maxLen = 500) {
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!trimmed.startsWith('https://')) return '';
    return sanitize(trimmed, maxLen);
  }

  // Dangerous URLs — must all return empty string
  const dangerous = [
    'javascript:alert(document.cookie)',
    'javascript:void(0)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://linkedin.com/xyz',
    'http://attacker.com',
    'ftp://files.example.com',
    '//attacker.com/steal',
    '',
    null,
    undefined,
  ];

  for (const url of dangerous) {
    assert.equal(safeUrl(url), '',
      'Must reject: ' + String(url).slice(0, 60));
  }

  // Safe URLs — must be returned (sanitized)
  assert.equal(
    safeUrl('https://www.linkedin.com/company/acme/'),
    'https://www.linkedin.com/company/acme/',
    'Valid LinkedIn URL must pass'
  );
  assert.equal(
    safeUrl('https://acme.com'),
    'https://acme.com',
    'Valid website URL must pass'
  );

  // Verify safeUrl is present in content.js source
  const src = readSource('content.js');
  assert.ok(src.includes('safeUrl'), 'safeUrl function must exist in content.js');
  assert.ok(
    src.includes("startsWith('https://')") || src.includes('startsWith("https://")'),
    'safeUrl must check https:// prefix'
  );
  assert.ok(
    !src.includes('sanitize(window.location.href)'),
    'window.location.href must use safeUrl not raw sanitize'
  );
  assert.ok(
    !src.includes('sanitize(link.href)'),
    'link.href must use safeUrl not raw sanitize'
  );
});

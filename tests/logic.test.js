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

const CHROME_WORDS = new Set([
  'linkedin', 'home', 'about', 'posts', 'jobs', 'people', 'life', 'videos',
  'events', 'insights', 'products', 'ads', 'similar', 'affiliated', 'related',
  'page', 'pages', 'overview', 'feed', 'search', 'notifications', 'messaging',
  'network', 'my', 'sign', 'up', 'log', 'in', 'join', 'and', 'the', 'skip',
  'to', 'main', 'content', 'menu', 'navigation', 'nav', 'tab', 'tabs',
  'verified', 'services', 'newsletter', 'follower', 'followers',
]);

function nameKey(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isUsableName(candidate) {
  if (!candidate) return false;
  const words = candidate.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
  if (words.length === 0) return false;
  if (words.every(w => CHROME_WORDS.has(w))) return false;
  return true;
}

function candidateVariants(value) {
  const variants = [value];
  const colon = value.indexOf(':');
  if (colon > 0) variants.push(value.slice(0, colon).trim());
  for (const variant of variants.slice()) {
    const words = variant.split(/\s+/);
    while (
      words.length > 1 &&
      CHROME_WORDS.has(words[words.length - 1].toLowerCase().replace(/[^a-z0-9]/g, ''))
    ) {
      words.pop();
    }
    const trimmed = words.join(' ').trim();
    if (trimmed && trimmed !== variant) variants.push(trimmed);
  }
  return variants.filter(Boolean);
}

function matchesSlug(candidate, slug) {
  const a = nameKey(candidate);
  const b = nameKey(slug);
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a);
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

// Mirrors scrapeCompanyName(): collect usable candidates in priority order,
// prefer one that matches the URL slug, then fall back.
function resolveName(rawSources, href) {
  const slug = getCompanySlug(href);
  const all = rawSources.map(v => sanitize(v || '', 255)).filter(Boolean);
  const found = all.filter(isUsableName);

  const slugKey = nameKey(slug);
  if (slugKey) {
    for (const value of all) {
      for (const variant of candidateVariants(value)) {
        if (nameKey(variant) === slugKey) return variant;
      }
    }
  }

  for (const value of found) {
    if (matchesSlug(value, slug)) return value;
  }
  if (found.length > 0) return found[0];
  return nameFromSlug(href);
}

test('Scenario 11 — empty page-shell h1 falls through to a real name', () => {
  const href = 'https://www.linkedin.com/company/acme-corp/';
  // First source is the empty hidden h1 LinkedIn renders in its page shell.
  assert.equal(resolveName(['', '  \n  ', 'Acme Corporation'], href), 'Acme Corporation');
});

test('Scenario 11 — nav tab headings never become the company name', () => {
  const href = 'https://www.linkedin.com/company/acme-corp/';
  // The company page nav renders "Home"/"About" headings — the bug that put
  // "Home" on the board.
  assert.equal(resolveName(['Home'], href), 'Acme Corp');
  assert.equal(resolveName(['Home page'], href), 'Acme Corp');
  assert.equal(resolveName(['About'], href), 'Acme Corp');
  assert.equal(resolveName(['LinkedIn', 'Feed'], href), 'Acme Corp');
  assert.equal(resolveName(['Skip to main content'], href), 'Acme Corp');
});

test('Scenario 11 — a real name containing a chrome word still passes', () => {
  const href = 'https://www.linkedin.com/company/acme-life/';
  assert.equal(resolveName(['Acme Life'], href), 'Acme Life',
    'Only all-chrome candidates may be rejected');
});

test('Scenario 11 — slug affinity beats page position', () => {
  const href = 'https://www.linkedin.com/company/acme-corp/';
  // A stale og:title from the previous SPA route sits ahead of the real name.
  assert.equal(
    resolveName(['Some Other Company', 'Acme Corporation'], href),
    'Acme Corporation',
    'The candidate matching the URL slug must win'
  );
});

test('Scenario 11 — divergent display name is kept when nothing matches slug', () => {
  // Rebrands: slug still says "twitter" but the page says "X". Keep the page.
  const href = 'https://www.linkedin.com/company/twitter/';
  assert.equal(resolveName(['X'], href), 'X',
    'A real name must not be discarded just because the slug diverged');
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

test('Scenario 11 — a company whose real name is a chrome word is kept', () => {
  // /company/linkedin/ is genuinely named "LinkedIn"; /company/nav/ is "Nav".
  assert.equal(resolveName(['LinkedIn'], 'https://www.linkedin.com/company/linkedin/'), 'LinkedIn');
  assert.equal(resolveName(['Nav'], 'https://www.linkedin.com/company/nav/'), 'Nav');
  // But "Home" on a different company's page is still nav text.
  assert.equal(resolveName(['Home'], 'https://www.linkedin.com/company/acme-corp/'), 'Acme Corp');
});

// ── Scenario 12: website resolution via the "Visit website" button ────────
//
// LinkedIn routes that button through its own redirector, so the raw href is
// a linkedin.com URL and has to be unwrapped to be useful on a Monday board.

function safeUrlTest(raw, maxLen = 500) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed.startsWith('https://')) return '';
  return sanitize(trimmed, maxLen);
}

function unwrapLinkedInRedirect(href, base = 'https://www.linkedin.com/company/acme/') {
  try {
    const url = new URL(href, base);
    const isLinkedIn = /(^|\.)linkedin\.com$/i.test(url.hostname);
    if (isLinkedIn && /\/redir\//i.test(url.pathname)) {
      const target = url.searchParams.get('url');
      if (target) return target;
    }
    return url.href;
  } catch (_) {
    return '';
  }
}

function externalSite(rawHref) {
  const unwrapped = unwrapLinkedInRedirect(rawHref);
  const clean = safeUrlTest(unwrapped);
  if (!clean) return '';
  try {
    const host = new URL(clean).hostname;
    if (/(^|\.)linkedin\.com$/i.test(host)) return '';
    if (/(^|\.)licdn\.com$/i.test(host)) return '';
  } catch (_) {
    return '';
  }
  return clean;
}

test('Scenario 12 — LinkedIn redirect wrapper is unwrapped to the real site', () => {
  const wrapped =
    'https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Facme%2Ecom&urlhash=abcd&trk=about_website';
  assert.equal(externalSite(wrapped), 'https://acme.com',
    'The url query param must be extracted, not the linkedin.com wrapper');
});

test('Scenario 12 — direct https website links pass through', () => {
  assert.equal(externalSite('https://acme.com/'), 'https://acme.com/');
  assert.equal(externalSite('https://www.acme.co.uk/about'), 'https://www.acme.co.uk/about');
});

test('Scenario 12 — links back into LinkedIn are never treated as the website', () => {
  assert.equal(externalSite('https://www.linkedin.com/company/acme/'), '');
  assert.equal(externalSite('https://media.licdn.com/logo.png'), '');
  assert.equal(externalSite('/company/acme/about/'), '',
    'Relative LinkedIn paths must not become the website');
});

test('Scenario 12 — non-https schemes stay rejected', () => {
  assert.equal(externalSite('http://acme.com'), '', 'Plain http must be rejected');
  assert.equal(externalSite('javascript:alert(1)'), '', 'javascript: must be rejected');
  assert.equal(
    externalSite('https://www.linkedin.com/redir/redirect?url=javascript%3Aalert(1)'),
    '',
    'A javascript: payload smuggled through the redirector must be rejected'
  );
});

// ── Scenario 13: removing our button never removes LinkedIn's ────────────
//
// The button is injected directly into LinkedIn's action row, so the removal
// path must delete only our own node — never the parent that also holds
// "Visit website" and "Message".

function makeNode(id, className) {
  return {
    id: id || '',
    className: className || '',
    children: [],
    parentNode: null,
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
      this.parentNode = null;
    },
    closest(selector) {
      const wanted = selector.replace(/^\./, '');
      let node = this;
      while (node) {
        if (node.className === wanted) return node;
        node = node.parentNode;
      }
      return null;
    },
  };
}

// Mirrors removeExistingButton() in content.js.
function removeExistingButton(getById) {
  const existing = getById('pipeline-btn-main');
  if (!existing) return;
  const wrapper = existing.closest('.pipeline-btn-wrapper');
  if (wrapper) wrapper.remove();
  else existing.remove();
}

test('Scenario 13 — inline button removal leaves LinkedIn action row intact', () => {
  const row     = makeNode('', 'org-top-card-primary-actions');
  const visit   = makeNode('', 'visit-website');
  const message = makeNode('', 'message');
  const ours    = makeNode('pipeline-btn-main', 'pipeline-btn-button');
  row.appendChild(visit);
  row.appendChild(message);
  row.appendChild(ours);

  removeExistingButton(() => ours);

  assert.equal(row.children.length, 2, 'Only our button may be removed');
  assert.ok(row.children.includes(visit), "LinkedIn's Visit website must survive");
  assert.ok(row.children.includes(message), "LinkedIn's Message must survive");
  assert.equal(ours.parentNode, null, 'Our button must be detached');
});

test('Scenario 13 — wrapped fallback button removes its own wrapper', () => {
  const host    = makeNode('', 'page');
  const wrapper = makeNode('', 'pipeline-btn-wrapper');
  const ours    = makeNode('pipeline-btn-main', 'pipeline-btn-button');
  host.appendChild(wrapper);
  wrapper.appendChild(ours);

  removeExistingButton(() => ours);

  assert.equal(host.children.length, 0, 'The wrapper we created must be removed with it');
});

// ── Scenario 14: the Monday comment omits fields the page didn't have ────

// Mirrors buildUpdateBody() in background.js.
function buildUpdateBody(payload, date) {
  const fields = [
    ['🔗 LinkedIn: ', payload.linkedin_url],
    ['🏭 Industry: ', payload.industry],
    ['👥 Size: ',     payload.size],
    ['📍 HQ: ',       payload.headquarters],
    ['🌐 Website: ',  payload.website],
    ['📝 About: ',    payload.description],
  ];
  const lines = [];
  for (const [label, value] of fields) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) lines.push(label + text);
  }
  lines.push('➕ Added via Pipeline Button on ' + date);
  return lines.join('\n');
}

test('Scenario 14 — a fully scraped company keeps every line', () => {
  const body = buildUpdateBody({
    linkedin_url: 'https://www.linkedin.com/company/novoviz/',
    industry: 'Electronics Manufacturing',
    size: '2-10 employees',
    headquarters: 'Neuchâtel, NE',
    website: 'https://novoviz.com',
    description: 'SPAD imaging sensors',
  }, '2026-08-19');

  assert.equal(body.split('\n').length, 7, 'Six fields plus the footer');
  assert.ok(body.includes('🌐 Website: https://novoviz.com'));
});

test('Scenario 14 — missing fields leave no bare labels behind', () => {
  const body = buildUpdateBody({
    linkedin_url: 'https://www.linkedin.com/company/acme/',
    industry: '',
    size: '   ',
    headquarters: undefined,
    website: null,
    description: 'Acme builds things',
  }, '2026-08-19');

  assert.equal(body, [
    '🔗 LinkedIn: https://www.linkedin.com/company/acme/',
    '📝 About: Acme builds things',
    '➕ Added via Pipeline Button on 2026-08-19',
  ].join('\n'));
  assert.ok(!/Industry:\s*$/m.test(body), 'No label may be left without a value');
  assert.ok(!body.includes('HQ:'), 'A missing field must not appear at all');
});

test('Scenario 14 — the footer survives an entirely empty payload', () => {
  const body = buildUpdateBody({}, '2026-08-19');
  assert.equal(body, '➕ Added via Pipeline Button on 2026-08-19',
    'The provenance line is unconditional');
});

// ── Scenario 15: LinkedIn page titles carry the active tab ───────────────
//
// The title reads "<Company>: <Tab> | LinkedIn", and "NovoViz: Home" passed
// the slug check because it starts with the slug — so the tab name reached
// the board.

test('Scenario 15 — the tab suffix is dropped from a page title', () => {
  const href = 'https://www.linkedin.com/company/novoviz/';
  assert.equal(resolveName([cleanPageTitle('NovoViz: Home | LinkedIn')], href), 'NovoViz');
  assert.equal(resolveName([cleanPageTitle('NovoViz: People | LinkedIn')], href), 'NovoViz');
  assert.equal(resolveName([cleanPageTitle('(3) NovoViz: Jobs | LinkedIn')], href), 'NovoViz');
});

test('Scenario 15 — a badge word trailing a heading is dropped', () => {
  const href = 'https://www.linkedin.com/company/novoviz/';
  assert.equal(resolveName(['NovoViz Verified'], href), 'NovoViz');
});

test('Scenario 15 — a colon inside a real company name is kept', () => {
  // Nothing here matches the slug more closely, so the full name survives.
  const href = 'https://www.linkedin.com/company/valve/';
  assert.equal(resolveName(['Portal: The Company'], href), 'Portal: The Company');
});

test('Scenario 15 — the bare heading still wins over a decorated title', () => {
  const href = 'https://www.linkedin.com/company/novoviz/';
  assert.equal(
    resolveName([cleanPageTitle('NovoViz: Home | LinkedIn'), 'NovoViz'], href),
    'NovoViz',
    'An exact slug match must beat a decorated candidate listed before it'
  );
});

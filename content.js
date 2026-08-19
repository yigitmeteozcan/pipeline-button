(() => {
  'use strict';

  const BTN_ID     = 'pipeline-btn-main';
  const BTN_PREFIX = 'pipeline-btn';

  // Shared palette — same values as the popup's design tokens.
  const BRAND        = '#0a66c2';
  const BRAND_HOVER  = '#08528f';
  const NEUTRAL      = '#5d6b7a';
  const SUCCESS      = '#047857';
  const DANGER       = '#b3261e';
  const DANGER_HOVER = '#8f1e17';

  // Only inject the button on company pages — the content script itself runs
  // on all of linkedin.com so it can catch SPA navigations from feed/search/
  // profiles to company pages without needing a full page reload.
  const COMPANY_URL_RE = /^https:\/\/www\.linkedin\.com\/company\//;

  function isOnCompanyPage() {
    return COMPANY_URL_RE.test(window.location.href);
  }

  // ── Scraping helpers ──────────────────────────────────────────────────────

  function sanitize(str, maxLen = 500) {
    if (typeof str !== 'string') return '';
    // Collapse the newlines and padding LinkedIn leaves inside its elements so
    // the Monday item name is a single clean line.
    return str
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen);
  }

  function safeUrl(raw, maxLen = 500) {
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!trimmed.startsWith('https://')) return '';
    return sanitize(trimmed, maxLen);
  }

  // ── Company name resolution ───────────────────────────────────────────────
  //
  // The first `h1` on a LinkedIn company page is often not the company name:
  // the logged-in layout renders a visually-hidden `h1` for the page shell, and
  // the public (logged-out) layout uses a different class entirely. Reading it
  // blindly produced empty names, which the service worker then stored as
  // "Unknown Company". Instead we walk a list of sources, most specific first,
  // and reject anything empty or obviously not a company name.

  // Words LinkedIn uses for its own chrome — nav tabs, page shell, auth links.
  // A candidate built only from these is never a company name: the company page
  // nav renders headings like "Home" and "About", which is how "Home" ended up
  // on the board.
  const CHROME_WORDS = new Set([
    'linkedin', 'home', 'about', 'posts', 'jobs', 'people', 'life', 'videos',
    'events', 'insights', 'products', 'ads', 'similar', 'affiliated', 'related',
    'page', 'pages', 'overview', 'feed', 'search', 'notifications', 'messaging',
    'network', 'my', 'sign', 'up', 'log', 'in', 'join', 'and', 'the', 'skip',
    'to', 'main', 'content', 'menu', 'navigation', 'nav', 'tab', 'tabs',
  ]);

  // Comparison key: lowercase alphanumerics only, so "Acme Corp." and
  // "acme-corp" reduce to the same string.
  function nameKey(str) {
    return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function isUsableName(candidate) {
    if (!candidate) return false;
    const words = candidate.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
    if (words.length === 0) return false;
    // Reject when every word is LinkedIn chrome ("Home", "About", "Home page").
    // A real name containing one such word ("Acme Life") still passes.
    if (words.every(w => CHROME_WORDS.has(w))) return false;
    return true;
  }

  // The company page URL slug is the one thing on the page that is always about
  // this company, so it is used to tell a real name apart from stray page text.
  // Matches loosely in both directions: slug "acme-corp" accepts "Acme
  // Corporation" (slug is a prefix) and "Acme" (name is a prefix).
  function matchesSlug(candidate, slug) {
    const a = nameKey(candidate);
    const b = nameKey(slug);
    if (!a || !b) return false;
    return a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a);
  }

  // Strips LinkedIn's page-title decoration: an unread badge like "(3) " in
  // front, and a " | LinkedIn" / " - LinkedIn" suffix at the end.
  function cleanPageTitle(raw) {
    return sanitize(
      String(raw || '')
        .replace(/^\(\d+\+?\)\s*/, '')
        .replace(/\s*[|\-–—]\s*LinkedIn\s*$/i, ''),
      255
    );
  }

  // Last resort: derive a readable name from the URL slug, e.g.
  // /company/acme-corp/ → "Acme Corp". Still far more useful than "Unknown".
  function nameFromSlug(href) {
    const slug = getCompanySlug(href);
    if (!slug) return '';
    let decoded = slug;
    try {
      decoded = decodeURIComponent(slug);
    } catch (_) {}
    return sanitize(
      decoded
        .replace(/[-_+]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase()),
      255
    );
  }

  function textOf(selector) {
    try {
      const el = document.querySelector(selector);
      return el ? sanitize(el.textContent || '', 255) : '';
    } catch (_) {
      return '';
    }
  }

  function nameFromHeadings() {
    // The company name is inside `main` when LinkedIn renders the top card;
    // only fall back to a page-wide h1 if that layout is unfamiliar. These are
    // two separate queries because querySelectorAll returns document order,
    // not selector order.
    for (const selector of ['main h1', 'h1']) {
      try {
        for (const el of document.querySelectorAll(selector)) {
          const t = sanitize(el.textContent || '', 255);
          if (isUsableName(t)) return t;
        }
      } catch (_) {}
    }
    return '';
  }

  function nameFromStructuredData() {
    try {
      const blocks = document.querySelectorAll('script[type="application/ld+json"]');
      for (const block of blocks) {
        let parsed;
        try {
          parsed = JSON.parse(block.textContent || '');
        } catch (_) {
          continue;
        }
        // LinkedIn nests its entities under @graph on some layouts.
        const nodes = []
          .concat(parsed || [])
          .concat((parsed && parsed['@graph']) || []);
        for (const node of nodes) {
          if (!node || typeof node !== 'object') continue;
          const type = String(node['@type'] || '');
          if (!/organization|corporation|company/i.test(type)) continue;
          const t = sanitize(node.name || '', 255);
          if (isUsableName(t)) return t;
        }
      }
    } catch (_) {}
    return '';
  }

  function scrapeCompanyName() {
    const href = window.location.href;
    const slug = getCompanySlug(href);

    const sources = [
      // Logged-in company top card.
      () => textOf('.org-top-card-summary__title'),
      () => textOf('[data-test-id="org-top-card-summary__title"]'),
      () => textOf('[class*="org-top-card-summary__title"]'),
      // Public / logged-out company page.
      () => textOf('.top-card-layout__title'),
      () => textOf('[data-test-id="about-us__name"] dd'),
      // Metadata — present before the top card hydrates, but can be stale for a
      // moment after an SPA navigation, which the slug pass below screens out.
      nameFromStructuredData,
      () => {
        try {
          const meta = document.querySelector('meta[property="og:title"]');
          return meta ? cleanPageTitle(meta.getAttribute('content')) : '';
        } catch (_) {
          return '';
        }
      },
      () => cleanPageTitle(document.title),
      // Headings last: on a company page the nav renders its own headings
      // ("Home", "About"), so these are the least trustworthy source.
      nameFromHeadings,
    ];

    const all = [];
    for (const read of sources) {
      let value = '';
      try {
        value = read();
      } catch (_) {
        value = '';
      }
      if (value) all.push(value);
    }
    const found = all.filter(isUsableName);

    // Pass 0 — a candidate identical to the slug is this company by definition,
    // even when it reads as LinkedIn chrome: /company/linkedin/ is really named
    // "LinkedIn", /company/nav/ is really named "Nav".
    const slugKey = nameKey(slug);
    if (slugKey) {
      for (const value of all) {
        if (nameKey(value) === slugKey) return value;
      }
    }

    // Pass 1 — the first candidate that actually corresponds to this company's
    // URL slug. This is what rejects nav text like "Home" and stale metadata
    // left over from the previous SPA route.
    for (const value of found) {
      if (matchesSlug(value, slug)) return value;
    }

    // Pass 2 — no candidate matched the slug. Happens legitimately when the
    // display name and the slug diverge (rebrands, legacy slugs), so take the
    // highest-priority candidate rather than discarding a real name.
    if (found.length > 0) return found[0];

    // Pass 3 — nothing usable in the DOM; the slug always names the company.
    return nameFromSlug(href);
  }

  // ── Website resolution ────────────────────────────────────────────────────
  //
  // The "Visit website" button in the top card is the most reliable source, but
  // LinkedIn routes it through its own redirector
  // (linkedin.com/redir/redirect?url=https%3A%2F%2Facme.com&urlhash=…), so the
  // href has to be unwrapped before it is any use on a Monday board.

  function unwrapLinkedInRedirect(href) {
    try {
      const url = new URL(href, window.location.href);
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

  // A company's own site — not a link back into LinkedIn, and https only (the
  // existing safeUrl guard).
  function externalSite(rawHref) {
    const unwrapped = unwrapLinkedInRedirect(rawHref);
    const clean = safeUrl(unwrapped);
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

  function websiteFromStructuredData() {
    try {
      const blocks = document.querySelectorAll('script[type="application/ld+json"]');
      for (const block of blocks) {
        let parsed;
        try {
          parsed = JSON.parse(block.textContent || '');
        } catch (_) {
          continue;
        }
        const nodes = []
          .concat(parsed || [])
          .concat((parsed && parsed['@graph']) || []);
        for (const node of nodes) {
          if (!node || typeof node !== 'object') continue;
          const type = String(node['@type'] || '');
          if (!/organization|corporation|company/i.test(type)) continue;
          const candidates = [].concat(node.url || [], node.sameAs || []);
          for (const candidate of candidates) {
            const site = externalSite(String(candidate || ''));
            if (site) return site;
          }
        }
      }
    } catch (_) {}
    return '';
  }

  function scrapeWebsite() {
    // 1. Explicit website fields on the About tab and the public layout.
    const selectors = [
      '[data-test-id="about-us__website"] a',
      'a[data-tracking-control-name*="website"]',
      '.org-top-card-primary-actions a[href*="/redir/"]',
      '.org-about-us-company-module__company-page-url a',
      '.top-card-layout__entity-info a[href*="/redir/"]',
    ];
    for (const selector of selectors) {
      try {
        for (const el of document.querySelectorAll(selector)) {
          const site = externalSite(el.getAttribute('href') || el.href || '');
          if (site) return site;
        }
      } catch (_) {}
    }

    // 2. The "Visit website" button itself, found by its label. Matched against
    //    a few localisations of the same action, then by any top-card link that
    //    leaves LinkedIn.
    const LABEL_RE = /visit\s*(the\s*)?website|website\s*besuchen|voir\s*le\s*site|sitio\s*web|visita\s*il\s*sito/i;
    try {
      for (const el of document.querySelectorAll('a[href]')) {
        const label = sanitize(el.textContent || '', 80);
        const aria  = sanitize(el.getAttribute('aria-label') || '', 80);
        if (!LABEL_RE.test(label) && !LABEL_RE.test(aria)) continue;
        const site = externalSite(el.getAttribute('href') || el.href || '');
        if (site) return site;
      }
    } catch (_) {}

    // 3. Structured data, which carries the canonical url on many company pages.
    const fromData = websiteFromStructuredData();
    if (fromData) return fromData;

    // 4. Any outbound link in the top card, as a last resort.
    try {
      const card = document.querySelector('.org-top-card, .top-card-layout');
      if (card) {
        for (const el of card.querySelectorAll('a[href]')) {
          const site = externalSite(el.getAttribute('href') || el.href || '');
          if (site) return site;
        }
      }
    } catch (_) {}

    return '';
  }

  function scrapeCompany() {
    const name = scrapeCompanyName() || nameFromSlug(window.location.href);

    const industry = sanitize(
      (document.querySelector(
        '.org-top-card-summary-info-list__info-item, [data-test-id="about-us__industry"] dd, .basic-info-item'
      ) || {}).textContent || ''
    );

    const size = (() => {
      try {
        const els = document.querySelectorAll(
          '.org-top-card-summary-info-list__info-item, [data-test-id="about-us__size"] dd'
        );
        for (const el of els) {
          const t = sanitize(el.textContent);
          if (/\d/.test(t) && /employee/i.test(t)) return t;
        }
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          const t = node.textContent.trim();
          if (/\d[\d,\s]*employees/i.test(t)) return sanitize(t);
        }
        return '';
      } catch (_) {
        return '';
      }
    })();

    const description = sanitize(
      (document.querySelector(
        '[data-test-id="about-us__description"] p, .org-about-us-organization-description, .org-page-details__definition-text'
      ) || {}).textContent || ''
    );

    const headquarters = sanitize(
      (document.querySelector(
        '[data-test-id="about-us__headquarters"] dd, [data-test-id="about-us__location"] dd'
      ) || {}).textContent || ''
    );

    const website = scrapeWebsite();

    const linkedin_url = safeUrl(window.location.href);

    return { name, industry, size, description, headquarters, website, linkedin_url };
  }

  // ── Button state setters ──────────────────────────────────────────────────

  function createButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = BTN_PREFIX + '-button';

    Object.assign(btn.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '6px',
      padding: '8px 20px',
      background: BRAND,
      color: '#ffffff',
      border: 'none',
      borderRadius: '24px',
      fontSize: '14px',
      fontWeight: '600',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      cursor: 'pointer',
      margin: '8px 0',
      boxShadow: '0 1px 2px rgba(16, 24, 40, 0.14)',
      transition: 'background 0.15s ease, box-shadow 0.15s ease, transform 0.08s ease',
      lineHeight: '1.4',
      whiteSpace: 'nowrap',
      zIndex: '9999',
    });

    // Hover and press feedback, matching the popup's primary button. Skipped
    // once the button is disabled so the success state stays visually settled.
    btn.addEventListener('mouseenter', () => {
      if (btn.disabled) return;
      btn.style.background = btn.dataset.hover || BRAND_HOVER;
      btn.style.boxShadow = '0 4px 12px rgba(16, 24, 40, 0.18)';
    });
    btn.addEventListener('mouseleave', () => {
      if (btn.disabled) return;
      btn.style.background = btn.dataset.base || BRAND;
      btn.style.boxShadow = '0 1px 2px rgba(16, 24, 40, 0.14)';
    });
    btn.addEventListener('mousedown', () => {
      if (!btn.disabled) btn.style.transform = 'translateY(1px)';
    });
    btn.addEventListener('mouseup', () => { btn.style.transform = 'none'; });

    setDefaultState(btn);
    return btn;
  }

  // Applies one palette entry and records it so the hover handlers restore the
  // right colour for whichever state the button is currently in.
  function paint(btn, base, hover) {
    btn.dataset.base = base;
    btn.dataset.hover = hover || base;
    btn.style.background = base;
    btn.style.color = '#ffffff';
  }

  function setDefaultState(btn) {
    btn.textContent = '＋ Add to Pipeline';
    paint(btn, BRAND, BRAND_HOVER);
    btn.style.opacity = '1';
    btn.disabled = false;
    btn.style.cursor = 'pointer';
  }

  function setLoadingState(btn) {
    btn.textContent = 'Adding…';
    paint(btn, NEUTRAL);
    btn.style.opacity = '0.8';
    btn.disabled = true;
    btn.style.cursor = 'progress';
  }

  function setSuccessState(btn, name) {
    // Show the captured name so a wrong scrape is obvious immediately, instead
    // of only being visible after switching to the Monday board.
    const label = name ? '✓ Added ' + (name.length > 28 ? name.slice(0, 27) + '…' : name)
                       : '✓ Added to Pipeline';
    btn.textContent = label;
    paint(btn, SUCCESS);
    btn.style.opacity = '1';
    btn.disabled = true;
    btn.style.cursor = 'default';
  }

  function setErrorState(btn) {
    btn.textContent = '✗ Failed — retry?';
    paint(btn, DANGER, DANGER_HOVER);
    btn.style.opacity = '1';
    btn.disabled = false;
    btn.style.cursor = 'pointer';
  }

  function setUnconfiguredState(btn) {
    btn.textContent = '⚙ Set up Pipeline Button';
    paint(btn, NEUTRAL);
    btn.style.opacity = '1';
    btn.disabled = false;
    btn.style.cursor = 'pointer';
  }

  // ── Message helpers ───────────────────────────────────────────────────────

  function sendMsg(msg) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(msg, response => {
        // Must read lastError to suppress Chrome's "unchecked error" warning.
        // This fires with response=undefined when the service worker is dormant
        // and restarting; we handle that case in the callers below.
        void chrome.runtime.lastError;
        resolve(response);
      });
    });
  }

  // Retries for read-only CHECK_CONFIG only — safe because it has no side
  // effects. ADD_TO_PIPELINE is intentionally single-shot to prevent duplicate
  // Monday items if the service worker processed the request before the channel
  // dropped.
  async function sendMsgRetry(msg) {
    for (let i = 0; i < 3; i++) {
      const r = await sendMsg(msg);
      if (r !== undefined) return r;
      if (i < 2) await new Promise(ok => setTimeout(ok, 500));
    }
    return undefined;
  }

  // ── Click handler ─────────────────────────────────────────────────────────

  async function handleClick(btn) {
    try {
      const configResponse = await sendMsgRetry({ type: 'CHECK_CONFIG' });

      if (!configResponse) {
        // Service worker unreachable after retries — reset to default so the
        // user can click again once the worker has had time to restart.
        setDefaultState(btn);
        return;
      }

      if (!configResponse.configured) {
        setUnconfiguredState(btn);
        return;
      }

      setLoadingState(btn);

      const data = scrapeCompany();

      // Diagnostic for when a page scrapes wrong — open DevTools on the company
      // page and this shows exactly what was captured before it was sent.
      try {
        console.debug('[Pipeline Button] scraped:', data);
      } catch (_) {}

      // Single attempt — see note on sendMsgRetry above.
      const response = await sendMsg({ type: 'ADD_TO_PIPELINE', payload: data });

      if (response && response.success) {
        setSuccessState(btn, data.name);
      } else {
        setErrorState(btn);
      }
    } catch (_) {
      setErrorState(btn);
    }
  }

  // ── Injection ─────────────────────────────────────────────────────────────

  // The row holding "Visit website", "Message" and "Following". Injecting here
  // puts the button where a LinkedIn action button belongs, instead of letting
  // it land in the page grid as its own block.
  function findActionsRow() {
    const direct = [
      '.org-top-card-primary-actions__inner',
      '.org-top-card-primary-actions',
      '[class*="org-top-card-primary-actions"]',
    ];
    for (const selector of direct) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch (_) {}
    }

    // Newer layouts drop those class names, so derive the row from the action
    // buttons themselves. Scoped to the top card so the global nav — which has
    // its own "Messaging" control — can never match.
    const ACTION_RE = /visit\s*website|^\s*message\s*$|^\s*following\s*$|^\s*follow\s*$/i;
    let card = null;
    try {
      card = document.querySelector('.org-top-card, .top-card-layout, main');
    } catch (_) {}
    if (!card) return null;

    try {
      for (const el of card.querySelectorAll('a, button')) {
        const label = sanitize(el.textContent || '', 60);
        const aria  = sanitize(el.getAttribute('aria-label') || '', 60);
        if (!ACTION_RE.test(label) && !ACTION_RE.test(aria)) continue;
        // Walk up until we find the element that groups several controls —
        // that is the row, not the button's own wrapper.
        let node = el.parentElement;
        for (let depth = 0; node && depth < 3; depth++) {
          if (node.querySelectorAll('a, button').length >= 2) return node;
          node = node.parentElement;
        }
      }
    } catch (_) {}
    return null;
  }

  function findInsertionPoint() {
    const candidates = [
      '.org-top-card__primary-content',
      '.org-top-card',
      '.artdeco-card .ph5',
      'main section:first-of-type',
      'h1',
    ];
    for (const sel of candidates) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function removeExistingButton() {
    const existing = document.getElementById(BTN_ID);
    if (!existing) return;
    // Only ever remove our own nodes. The button is now injected directly into
    // LinkedIn's action row, so falling back to parentNode here would delete
    // LinkedIn's own buttons along with ours.
    const wrapper = existing.closest('.' + BTN_PREFIX + '-wrapper');
    if (wrapper) wrapper.remove();
    else existing.remove();
  }

  // Sizing that matches an artdeco pill button, applied when the button sits in
  // LinkedIn's own action row.
  function applyInlineActionStyle(btn) {
    Object.assign(btn.style, {
      margin: '0 0 0 8px',
      padding: '6px 16px',
      minHeight: '32px',
      borderRadius: '20px',
      fontSize: '14px',
      alignSelf: 'center',
      flexShrink: '0',
      verticalAlign: 'middle',
    });
  }

  function injectButton() {
    if (!isOnCompanyPage()) return;
    if (document.getElementById(BTN_ID)) return;

    const btn = createButton();
    btn.addEventListener('click', () => handleClick(btn));

    // Preferred: sit inside the action row, beside "Visit website".
    const actionsRow = findActionsRow();
    if (actionsRow) {
      applyInlineActionStyle(btn);
      actionsRow.appendChild(btn);
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = BTN_PREFIX + '-wrapper';
    wrapper.appendChild(btn);

    const anchor = findInsertionPoint();

    if (anchor && anchor.parentNode) {
      // Next best: a block of its own directly below the top card.
      Object.assign(wrapper.style, { margin: '8px 0', display: 'block' });
      anchor.parentNode.insertBefore(wrapper, anchor.nextSibling);
    } else {
      // Fallback: LinkedIn's DOM isn't ready or doesn't match known selectors.
      // Append to document.body directly — it is never touched by React's
      // reconciler, so the button survives any LinkedIn re-render cycle.
      Object.assign(wrapper.style, {
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        margin: '0',
        zIndex: '2147483647',
      });
      document.body.appendChild(wrapper);
    }
  }

  // Retry injection with backoff — LinkedIn renders content asynchronously
  // after document_idle, so a single attempt at load time is not enough.
  function scheduleInjectionAttempts() {
    injectButton();
    for (const ms of [300, 700, 1500, 3000, 6000]) {
      setTimeout(injectButton, ms);
    }
  }

  // ── SPA navigation detection + persistent heartbeat ─────────────────────
  //
  // LinkedIn is a React SPA. Two problems to solve:
  //   1. pushState navigations don't re-inject content scripts.
  //   2. React re-renders can remove the button at any time during a session.
  //
  // Solution: a single 1-second heartbeat that handles both. We track only the
  // company slug (not the full URL) so that query-param changes like ?trk=…
  // and sub-page navigations like /company/acme/about/ don't trigger a removal.

  function getCompanySlug(href) {
    const m = href.match(/linkedin\.com\/company\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  let lastSlug = getCompanySlug(window.location.href);

  const heartbeat = setInterval(() => {
    const slug = getCompanySlug(window.location.href);

    if (slug !== lastSlug) {
      // Navigated to a different company or left company pages entirely
      removeExistingButton();
      lastSlug = slug;
    }

    if (slug && !document.getElementById(BTN_ID)) {
      injectButton();
    }
  }, 1000);

  // ── MutationObserver — catches async DOM rendering on same URL ────────────

  let debounceTimer = null;

  const observer = new MutationObserver(() => {
    if (!isOnCompanyPage()) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!document.getElementById(BTN_ID)) {
        injectButton();
      }
    }, 300);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('unload', () => {
    clearInterval(heartbeat);
    observer.disconnect();
  });

  // ── Initial injection ─────────────────────────────────────────────────────

  scheduleInjectionAttempts();
})();

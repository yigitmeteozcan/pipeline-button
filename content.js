(() => {
  'use strict';

  const BTN_ID     = 'pipeline-btn-main';
  const BTN_PREFIX = 'pipeline-btn';

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

  // Titles LinkedIn renders in its page shell — never a real company.
  const NAME_BLOCKLIST = new Set([
    'linkedin', 'feed', 'home', 'search', 'notifications', 'messaging', 'jobs',
    'my network', 'sign up', 'log in', 'join linkedin',
  ]);

  function isUsableName(candidate) {
    if (!candidate) return false;
    if (NAME_BLOCKLIST.has(candidate.toLowerCase())) return false;
    return true;
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
    const candidates = [
      // Logged-in company top card.
      () => textOf('.org-top-card-summary__title'),
      () => textOf('[data-test-id="org-top-card-summary__title"]'),
      // Public / logged-out company page.
      () => textOf('.top-card-layout__title'),
      () => textOf('[data-test-id="about-us__name"] dd'),
      // Generic headings, skipping the empty page-shell h1.
      nameFromHeadings,
      // Metadata LinkedIn ships even before the top card hydrates.
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
      // Never send an empty name — the URL always carries the slug.
      () => nameFromSlug(window.location.href),
    ];

    for (const resolve of candidates) {
      let value = '';
      try {
        value = resolve();
      } catch (_) {
        value = '';
      }
      if (isUsableName(value)) return value;
    }
    return '';
  }

  function scrapeCompany() {
    const name = scrapeCompanyName();

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

    const website = (() => {
      try {
        const link = document.querySelector(
          '[data-test-id="about-us__website"] a, a[href*="//"][data-tracking-control-name*="website"]'
        );
        return link ? safeUrl(link.href) : '';
      } catch (_) {
        return '';
      }
    })();

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
      gap: '6px',
      padding: '8px 20px',
      background: '#0a66c2',
      color: '#ffffff',
      border: 'none',
      borderRadius: '24px',
      fontSize: '14px',
      fontWeight: '600',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      cursor: 'pointer',
      margin: '8px 0',
      transition: 'background 0.2s',
      lineHeight: '1.4',
      whiteSpace: 'nowrap',
      zIndex: '9999',
    });

    setDefaultState(btn);
    return btn;
  }

  function setDefaultState(btn) {
    btn.textContent = '＋ Add to Pipeline';
    btn.style.background = '#0a66c2';
    btn.style.color = '#ffffff';
    btn.disabled = false;
    btn.style.cursor = 'pointer';
  }

  function setLoadingState(btn) {
    btn.textContent = 'Adding...';
    btn.style.background = '#999999';
    btn.style.color = '#ffffff';
    btn.disabled = true;
    btn.style.cursor = 'not-allowed';
  }

  function setSuccessState(btn) {
    btn.textContent = '✓ Added to Pipeline';
    btn.style.background = '#057642';
    btn.style.color = '#ffffff';
    btn.disabled = true;
    btn.style.cursor = 'default';
  }

  function setErrorState(btn) {
    btn.textContent = '✗ Failed — retry?';
    btn.style.background = '#cc1016';
    btn.style.color = '#ffffff';
    btn.disabled = false;
    btn.style.cursor = 'pointer';
  }

  function setUnconfiguredState(btn) {
    btn.textContent = '⚙ Set up Pipeline Button';
    btn.style.background = '#666666';
    btn.style.color = '#ffffff';
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

      // Single attempt — see note on sendMsgRetry above.
      const response = await sendMsg({ type: 'ADD_TO_PIPELINE', payload: data });

      if (response && response.success) {
        setSuccessState(btn);
      } else {
        setErrorState(btn);
      }
    } catch (_) {
      setErrorState(btn);
    }
  }

  // ── Injection ─────────────────────────────────────────────────────────────

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
    if (existing) {
      const wrapper = existing.closest('.' + BTN_PREFIX + '-wrapper') || existing.parentNode;
      if (wrapper && wrapper !== document.body) wrapper.remove();
    }
  }

  function injectButton() {
    if (!isOnCompanyPage()) return;
    if (document.getElementById(BTN_ID)) return;

    const btn = createButton();
    btn.addEventListener('click', () => handleClick(btn));

    const wrapper = document.createElement('div');
    wrapper.className = BTN_PREFIX + '-wrapper';
    wrapper.appendChild(btn);

    const anchor = findInsertionPoint();

    if (anchor && anchor.parentNode) {
      // Preferred: inject inline next to the company top-card element.
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

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
    return str.replace(/<[^>]*>/g, '').trim().slice(0, maxLen);
  }

  function safeUrl(raw, maxLen = 500) {
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!trimmed.startsWith('https://')) return '';
    return sanitize(trimmed, maxLen);
  }

  function scrapeCompany() {
    const name = sanitize(
      (document.querySelector('h1') || {}).textContent || '',
      255
    );

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

  // ── Click handler ─────────────────────────────────────────────────────────

  async function handleClick(btn) {
    try {
      const configResponse = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: 'CHECK_CONFIG' }, resolve)
      );

      if (!configResponse || !configResponse.configured) {
        setUnconfiguredState(btn);
        return;
      }

      setLoadingState(btn);

      const data = scrapeCompany();

      const response = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: 'ADD_TO_PIPELINE', payload: data }, resolve)
      );

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

    const anchor = findInsertionPoint();
    if (!anchor) return;

    const btn = createButton();
    btn.addEventListener('click', () => handleClick(btn));

    const wrapper = document.createElement('div');
    wrapper.className = BTN_PREFIX + '-wrapper';
    Object.assign(wrapper.style, { margin: '8px 0', display: 'block' });
    wrapper.appendChild(btn);

    if (anchor.parentNode) {
      anchor.parentNode.insertBefore(wrapper, anchor.nextSibling);
    } else {
      anchor.appendChild(wrapper);
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

  // ── SPA navigation detection ──────────────────────────────────────────────
  //
  // LinkedIn is a React SPA. Navigating from /feed or /search to /company/xyz
  // changes the URL via pushState — Chrome does NOT re-inject content scripts
  // for pushState navigations, so we must detect these ourselves.

  let lastUrl = window.location.href;

  function onUrlChange(newUrl) {
    if (isOnCompanyPage()) {
      // Entering a company page — clean up any stale button and re-inject
      removeExistingButton();
      scheduleInjectionAttempts();
    } else {
      // Leaving a company page — clean up
      removeExistingButton();
    }
  }

  const urlPollInterval = setInterval(() => {
    const current = window.location.href;
    if (current !== lastUrl) {
      lastUrl = current;
      onUrlChange(current);
    }
  }, 500);

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
    clearInterval(urlPollInterval);
    observer.disconnect();
  });

  // ── Initial injection ─────────────────────────────────────────────────────

  scheduleInjectionAttempts();
})();

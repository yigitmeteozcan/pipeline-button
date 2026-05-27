(() => {
  'use strict';

  const BTN_ID = 'pipeline-btn-main';
  const BTN_PREFIX = 'pipeline-btn';

  // ── Scraping helpers ──────────────────────────────────────────────────────

  function sanitize(str, maxLen = 500) {
    if (typeof str !== 'string') return '';
    return str.replace(/<[^>]*>/g, '').trim().slice(0, maxLen);
  }

  function queryText(selector) {
    try {
      const el = document.querySelector(selector);
      return el ? sanitize(el.textContent) : '';
    } catch (_) {
      return '';
    }
  }

  function scrapeCompany() {
    const name = sanitize(
      (document.querySelector('h1') || {}).textContent || '',
      255
    );

    // Industry — appears in the about section sidebar
    const industry = sanitize(
      (document.querySelector(
        '.org-top-card-summary-info-list__info-item, [data-test-id="about-us__industry"] dd, .basic-info-item'
      ) || {}).textContent || ''
    );

    // Employee count
    const size = (() => {
      try {
        const els = document.querySelectorAll(
          '.org-top-card-summary-info-list__info-item, [data-test-id="about-us__size"] dd'
        );
        for (const el of els) {
          const t = sanitize(el.textContent);
          if (/\d/.test(t) && /employee/i.test(t)) return t;
        }
        // Fallback: look for "employees" near any text
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          null
        );
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

    // About / description
    const description = sanitize(
      (document.querySelector(
        '[data-test-id="about-us__description"] p, .org-about-us-organization-description, .org-page-details__definition-text'
      ) || {}).textContent || ''
    );

    // Headquarters
    const headquarters = sanitize(
      (document.querySelector(
        '[data-test-id="about-us__headquarters"] dd, [data-test-id="about-us__location"] dd'
      ) || {}).textContent || ''
    );

    // Website
    const website = (() => {
      try {
        const link = document.querySelector(
          '[data-test-id="about-us__website"] a, a[href*="//"][data-tracking-control-name*="website"]'
        );
        return link ? sanitize(link.href) : '';
      } catch (_) {
        return '';
      }
    })();

    const linkedin_url = sanitize(window.location.href);

    return { name, industry, size, description, headquarters, website, linkedin_url };
  }

  // ── Prototype-pollution guard ─────────────────────────────────────────────

  const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

  function isSafe(value) {
    return !DANGEROUS_KEYS.has(String(value).toLowerCase().trim());
  }

  // ── Button injection ──────────────────────────────────────────────────────

  function createButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = `${BTN_PREFIX}-button`;

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
      const { MONDAY_API_TOKEN, MONDAY_BOARD_ID } = await new Promise(resolve =>
        chrome.storage.sync.get(['MONDAY_API_TOKEN', 'MONDAY_BOARD_ID'], resolve)
      );

      if (!MONDAY_API_TOKEN || !MONDAY_BOARD_ID) {
        setUnconfiguredState(btn);
        // Open popup
        chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
        return;
      }

      setLoadingState(btn);

      const data = scrapeCompany();

      if (!isSafe(data.name)) {
        setErrorState(btn);
        return;
      }

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

  // ── Injection logic ───────────────────────────────────────────────────────

  function findInsertionPoint() {
    // Try various LinkedIn selectors for the header area
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

  function injectButton() {
    if (document.getElementById(BTN_ID)) return; // already injected

    const anchor = findInsertionPoint();
    if (!anchor) return;

    const btn = createButton();
    btn.addEventListener('click', () => handleClick(btn));

    // Wrap in a container with unique class to avoid LinkedIn CSS clashes
    const wrapper = document.createElement('div');
    wrapper.className = `${BTN_PREFIX}-wrapper`;
    Object.assign(wrapper.style, {
      margin: '8px 0',
      display: 'block',
    });
    wrapper.appendChild(btn);

    // Insert after the anchor element
    if (anchor.parentNode) {
      anchor.parentNode.insertBefore(wrapper, anchor.nextSibling);
    } else {
      anchor.appendChild(wrapper);
    }
  }

  // ── MutationObserver for LinkedIn SPA navigation ──────────────────────────

  let debounceTimer = null;

  function onMutation() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!document.getElementById(BTN_ID)) {
        injectButton();
      }
    }, 300);
  }

  const observer = new MutationObserver(onMutation);
  observer.observe(document.body, { childList: true, subtree: true });

  // Initial injection
  injectButton();
})();

(() => {
  'use strict';
  const C = XCountryCore;
  const ARTICLE = 'article[data-testid="tweet"]';
  let settings = C.normalizeSettings();
  let cache = Object.create(null);
  let loaded = false;
  let scanTimer;
  let inFlight = null;
  let nextLookup = 0;
  let pausedUntil = 0;
  const failures = new Map();
  const visibleHandles = new Set();
  const observedArticles = new Set();
  const viewportArticles = new Set();
  const state = new WeakMap();
  const dirtyArticles = new Set();

  function send(message) {
    try { return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => null); } catch { return Promise.resolve(null); }
  }
  function cacheRecord(handle) {
    return Object.hasOwn(cache, handle) && C.isFresh(cache[handle]) ? cache[handle] : null;
  }
  function profileHandle(anchor) {
    try {
      const url = new URL(anchor.getAttribute('href'), location.origin);
      if (url.origin !== location.origin) return null;
      const match = /^\/([a-zA-Z0-9_]{1,15})\/?$/.exec(url.pathname);
      return match ? C.normalizeHandle(match[1]) : null;
    } catch { return null; }
  }
  function author(article) {
    const header = [...article.querySelectorAll('[data-testid="User-Name"]')].find(el => el.closest(ARTICLE) === article);
    if (!header) return null;
    const links = [...header.querySelectorAll('a[href]')].filter(anchor => !anchor.classList.contains('xcl-badge') && profileHandle(anchor));
    if (!links.length) return null;
    const handle = profileHandle(links[0]);
    // X places the display-name profile link first, before the @handle.
    // Use its position without moving any React-owned nodes.
    const anchor = links[0];
    return { handle, anchor, header };
  }
  function hideTarget(article) {
    const cell = article.closest('[data-testid="cellInnerDiv"]');
    return cell && cell.querySelectorAll(ARTICLE).length === 1 ? cell : article;
  }
  function restore(article) {
    const previous = state.get(article);
    previous?.target?.classList.remove('xcl-filtered');
    previous?.badge?.remove();
    if (previous) {
      previous.header.classList.remove('xcl-header');
      resize.unobserve(previous.header);
    }
    state.delete(article);
  }
  function positionLabel(record) {
    if (record.target.classList.contains('xcl-filtered')) return;
    const header = record.header.getBoundingClientRect();
    const displayName = record.anchor.getBoundingClientRect();
    const left = Math.max(0, displayName.left - header.left - record.header.clientLeft);
    const top = displayName.bottom - header.top - record.header.clientTop;
    record.badge.style.left = `${left}px`;
    record.badge.style.top = `${top}px`;
    record.badge.style.maxWidth = `${Math.min(175, Math.max(0, record.header.clientWidth - left))}px`;
  }
  function render(article) {
    const current = author(article);
    let previous = state.get(article);
    if (!current || !settings.enabled) { restore(article); return; }
    if (previous && (previous.handle !== current.handle || !previous.badge.isConnected || previous.anchor !== current.anchor || previous.header !== current.header)) {
      restore(article);
      previous = null;
    }
    const record = cacheRecord(current.handle);
    const place = record?.location || null;
    if (!previous) {
      const badge = document.createElement('a');
      badge.className = 'xcl-badge';
      badge.href = '/' + current.handle + '/about';
      badge.addEventListener('click', event => event.stopPropagation());
      current.header.classList.add('xcl-header');
      current.header.append(badge);
      resize.observe(current.header);
      previous = { ...current, badge, target: hideTarget(article) };
      state.set(article, previous);
    }
    const newTarget = hideTarget(article);
    if (newTarget !== previous.target) { previous.target.classList.remove('xcl-filtered'); previous.target = newTarget; }
    const label = place ? place.label : 'Unknown';
    if (previous.badge.textContent !== label) previous.badge.textContent = label;
    const kind = place?.kind || 'unknown';
    if (previous.badge.dataset.kind !== kind) previous.badge.dataset.kind = kind;
    const title = place
      ? `X reports @${current.handle} is based in ${place.label}. ${place.kind === 'region' ? 'Region or unrecognized location label; no country inferred. ' : ''}This is an IP-based estimate, not nationality. Click to open About this account.`
      : record ? `X did not provide a country or region for @${current.handle}. Click to open About this account.`
        : `Country or region has not been resolved for @${current.handle}. Click to open About this account.`;
    if (previous.badge.title !== title) {
      previous.badge.title = title;
      previous.badge.setAttribute('aria-label', label + '. ' + title);
    }
    previous.target.classList.toggle('xcl-filtered', C.shouldHide(place, settings, !record));
    positionLabel(previous);
  }
  const resize = new ResizeObserver(entries => {
    for (const entry of entries) {
      const article = entry.target.closest(ARTICLE);
      if (article) dirtyArticles.add(article);
    }
    schedule(false);
  });
  const intersection = new IntersectionObserver(entries => {
    for (const entry of entries) {
      // Remember eligibility while filtered: display:none should not cancel a lookup.
      if (entry.isIntersecting) viewportArticles.add(entry.target);
      else if (!state.get(entry.target)?.target.classList.contains('xcl-filtered')) viewportArticles.delete(entry.target);
    }
    schedule(false);
  }, { rootMargin: '600px 0px' });

  function scan() {
    scanTimer = null;
    if (!loaded) return;
    visibleHandles.clear();
    for (const article of observedArticles) {
      if (!article.isConnected) {
        restore(article);
        observedArticles.delete(article);
        viewportArticles.delete(article);
        intersection.unobserve(article);
      }
    }
    for (const article of observedArticles) {
      if (dirtyArticles.has(article)) render(article);
      const record = state.get(article);
      // Hidden unresolved posts cannot intersect again. Keep them in the bounded,
      // sequential lookup queue so turning on hideUnknown does not strand them.
      if (record && (viewportArticles.has(article) || ((settings.hideUnknown || settings.hidePending) && !cacheRecord(record.handle)))) visibleHandles.add(record.handle);
    }
    dirtyArticles.clear();
    pump();
  }
  function discover(node) {
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return;
    const articles = node.matches?.(ARTICLE) ? [node, ...node.querySelectorAll(ARTICLE)] : node.querySelectorAll(ARTICLE);
    for (const article of articles) {
      if (!observedArticles.has(article)) {
        observedArticles.add(article);
        intersection.observe(article);
        const rect = article.getBoundingClientRect();
        if (rect.bottom >= -600 && rect.top <= innerHeight + 600) viewportArticles.add(article);
      }
      dirtyArticles.add(article);
    }
  }
  function schedule(all = true) {
    if (all) for (const article of observedArticles) dirtyArticles.add(article);
    if (!scanTimer) scanTimer = setTimeout(scan, 80);
  }
  async function pump() {
    const now = Date.now();
    if (!loaded || !settings.enabled || !settings.autoLookup || inFlight || now < nextLookup || now < pausedUntil) return;
    let handle;
    for (const candidate of visibleHandles) {
      if (!cacheRecord(candidate) && (failures.get(candidate) || 0) < now) { handle = candidate; break; }
    }
    if (!handle) return;
    inFlight = handle;
    nextLookup = now + 2100;
    // Browser runtime responses are bound to this isolated-world request. No
    // page-origin messages can submit results or initiate extension lookups.
    const data = await send({ type: 'LOOKUP', handle });
    inFlight = null;
    if (!settings.enabled) return;
    const record = C.normalizeRecord(data?.record);
    if ((data?.status === 'ok' || data?.status === 'unknown') && record) {
      cache[handle] = record;
      failures.delete(handle);
      schedule();
    } else {
      const delay = Number.isFinite(data?.retryAfter) ? Math.min(86400000, Math.max(1000, data.retryAfter)) : 60000;
      pausedUntil = Date.now() + delay;
      if (!['waiting', 'paused', 'rate-limited'].includes(data?.status)) failures.set(handle, pausedUntil + 5 * 60 * 1000);
    }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = C.normalizeSettings(changes.settings.newValue);
      pausedUntil = 0;
    }
    if (changes.providerStatus?.newValue?.state === 'ready') pausedUntil = 0;
    if (changes.countryCache) cache = C.normalizeCache(changes.countryCache.newValue);
    schedule();
  });
  chrome.storage.local.get(['settings', 'countryCache', 'cacheVersion']).then(saved => {
    settings = C.normalizeSettings(saved.settings);
    cache = saved.cacheVersion === 2 ? C.normalizeCache(saved.countryCache) : Object.create(null);
    loaded = true;
    discover(document);
    schedule();
  }).catch(() => {});
  const observer = new MutationObserver(mutations => {
    let changed = false;
    for (const mutation of mutations) {
      const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
      if (target?.closest('.xcl-badge')) continue;
      // Badge insertion/removal is ours and cannot change an account identity.
      if (mutation.type === 'childList' && [...mutation.addedNodes, ...mutation.removedNodes].every(node => node.nodeType === Node.ELEMENT_NODE && node.matches('.xcl-badge'))) continue;
      const article = target?.closest(ARTICLE);
      if (article) dirtyArticles.add(article);
      for (const node of mutation.addedNodes) discover(node);
      changed = true;
    }
    if (changed) schedule(false);
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  // Pump independently of DOM updates so cooldowns expire on a stationary feed.
  setInterval(() => { pump(); }, 1000);
  setInterval(() => { failures.forEach((expiry, handle) => { if (expiry <= Date.now()) failures.delete(handle); }); schedule(); }, 60000);
})();

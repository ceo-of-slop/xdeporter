(() => {
  'use strict';
  const C = XCountryCore;
  const ARTICLE = 'article[data-testid="tweet"]';
  let settings = C.normalizeSettings();
  let cache = Object.create(null);
  let loaded = false;
  let ready = false;
  let scanTimer;
  let inFlight = null;
  let requestNumber = 0;
  let nextLookup = 0;
  let pausedUntil = 0;
  let lastStatus = '';
  const failures = new Map();
  const visibleHandles = new Set();
  const observedArticles = new Set();
  const viewportArticles = new Set();
  const state = new WeakMap();
  const runId = Math.random().toString(36).slice(2);

  function send(message) {
    try { return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => null); } catch { return Promise.resolve(null); }
  }
  function status(stateName, message) {
    const signature = stateName + message;
    if (signature === lastStatus) return;
    lastStatus = signature;
    send({ type: 'PROVIDER_STATUS', state: stateName, message });
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
    // X normally has separate display-name and @username links. Anchor the
    // location to the visible username, without moving any React-owned nodes.
    const anchor = links.find(link => profileHandle(link) === handle && /^@[a-zA-Z0-9_]{1,15}$/.test(link.textContent.trim())) || links[0];
    const username = [...anchor.querySelectorAll('span,div')].reverse().find(node => /^@[a-zA-Z0-9_]{1,15}$/.test(node.textContent.trim())) || anchor;
    return { handle, anchor, username, header };
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
    const username = record.username.getBoundingClientRect();
    const left = Math.max(0, username.left - header.left - record.header.clientLeft);
    const top = username.bottom - header.top - record.header.clientTop;
    record.badge.style.left = `${left}px`;
    record.badge.style.top = `${top}px`;
    record.badge.style.maxWidth = `${Math.min(175, Math.max(0, record.header.clientWidth - left))}px`;
  }
  function render(article) {
    const current = author(article);
    let previous = state.get(article);
    if (!current || !settings.enabled) { restore(article); return; }
    if (previous && (previous.handle !== current.handle || !previous.badge.isConnected || previous.anchor !== current.anchor || previous.username !== current.username || previous.header !== current.header)) {
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
    previous.target.classList.toggle('xcl-filtered', C.shouldHide(place, settings));
    positionLabel(previous);
  }
  const resize = new ResizeObserver(() => schedule());
  const intersection = new IntersectionObserver(entries => {
    for (const entry of entries) {
      // Remember eligibility while filtered: display:none should not cancel a lookup.
      if (entry.isIntersecting) viewportArticles.add(entry.target);
      else if (!state.get(entry.target)?.target.classList.contains('xcl-filtered')) viewportArticles.delete(entry.target);
    }
    schedule();
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
    for (const article of document.querySelectorAll(ARTICLE)) {
      if (!observedArticles.has(article)) {
        observedArticles.add(article);
        intersection.observe(article);
        const rect = article.getBoundingClientRect();
        if (rect.bottom >= -600 && rect.top <= innerHeight + 600) viewportArticles.add(article);
      }
      render(article);
      const record = state.get(article);
      // Hidden unresolved posts cannot intersect again. Keep them in the bounded,
      // sequential lookup queue so turning on hideUnknown does not strand them.
      if (record && (viewportArticles.has(article) || (settings.hideUnknown && !cacheRecord(record.handle)))) visibleHandles.add(record.handle);
    }
    pump();
  }
  function schedule() {
    if (!scanTimer) scanTimer = setTimeout(scan, 80);
  }
  function pump() {
    const now = Date.now();
    if (!loaded || !ready || !settings.enabled || !settings.autoLookup || inFlight || now < nextLookup || now < pausedUntil) return;
    let handle;
    for (const candidate of visibleHandles) {
      if (!cacheRecord(candidate) && (failures.get(candidate) || 0) < now) { handle = candidate; break; }
    }
    if (!handle) return;
    const requestId = runId + ':' + (++requestNumber);
    const timeout = setTimeout(() => {
      if (inFlight?.requestId !== requestId) return;
      failures.set(handle, Date.now() + 5 * 60 * 1000);
      inFlight = null;
      pausedUntil = Date.now() + 60000;
      status('unavailable', 'X did not answer. Lookups will resume after a short pause.');
    }, 15000);
    inFlight = { handle, requestId, timeout };
    nextLookup = now + 2100;
    window.postMessage({ source: 'x-country-lens-content', type: 'LOOKUP', requestId, handle }, location.origin);
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== 'x-country-lens-page') return;
    if (data.type === 'READY') {
      ready = true;
      pausedUntil = 0;
      status('ready', 'Connected to X. Country lookups are available.');
      pump();
      return;
    }
    if (data.type === 'STATUS') {
      if (data.state === 'rate-limited') pausedUntil = Date.now() + 15 * 60 * 1000;
      if (typeof data.message === 'string') status(data.state, data.message.slice(0, 220));
      return;
    }
    if (data.type !== 'RESULT') return;
    const handle = C.normalizeHandle(data.handle);
    if (!handle) return;
    if (data.requestId) {
      if (inFlight?.requestId !== data.requestId || inFlight.handle !== handle) return;
      clearTimeout(inFlight.timeout);
      inFlight = null;
    }
    if (!settings.enabled) return;
    if (data.status === 'ok' || data.status === 'unknown') {
      const place = C.normalizeLocation(data.country);
      if (data.status === 'ok' && !place) return;
      cache[handle] = { location: place, checkedAt: Date.now(), source: 'x-about-account' };
      failures.delete(handle);
      send({ type: 'CACHE_RECORD', handle, country: place?.label || null, status: place ? 'ok' : 'unknown' });
      if (Date.now() >= pausedUntil) status('ready', 'Connected to X. Country lookups are available.');
      schedule();
    } else if (data.status === 'rate-limited' || data.status === 'unavailable') {
      pausedUntil = Date.now() + (data.status === 'rate-limited' ? 15 * 60 * 1000 : 60000);
      // Skip this account after the global pause, allowing other authors through.
      failures.set(handle, pausedUntil + 5 * 60 * 1000);
      status(data.status, typeof data.message === 'string' ? data.message.slice(0, 220) : 'X country lookups are temporarily unavailable.');
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) settings = C.normalizeSettings(changes.settings.newValue);
    if (changes.countryCache) cache = Object.assign(Object.create(null), changes.countryCache.newValue || {});
    schedule();
  });
  chrome.storage.local.get(['settings', 'countryCache']).then(saved => {
    settings = C.normalizeSettings(saved.settings);
    cache = Object.assign(Object.create(null), saved.countryCache || {});
    loaded = true;
    schedule();
    window.postMessage({ source: 'x-country-lens-content', type: 'HELLO' }, location.origin);
    if (!ready) status('waiting', 'Waiting for an X session. Sign in and refresh your X tab.');
  }).catch(() => status('unavailable', 'Unable to read extension settings. Reload the extension.'));
  const observer = new MutationObserver(mutations => {
    if (mutations.some(mutation => !mutation.target.parentElement?.closest('.xcl-badge') && !mutation.target.classList?.contains('xcl-badge'))) schedule();
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  // Pump independently of DOM updates so cooldowns expire on a stationary feed.
  setInterval(() => { pump(); }, 1000);
  setInterval(() => { failures.forEach((expiry, handle) => { if (expiry <= Date.now()) failures.delete(handle); }); schedule(); }, 60000);
})();

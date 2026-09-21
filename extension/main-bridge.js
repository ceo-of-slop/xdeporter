/*
 * Runs in X's MAIN world. Credentials stay in this closure, in memory only.
 * The bridge can perform only one read-only, same-origin AboutAccountQuery.
 * See docs/SOURCES.md for the independently inspected operation and schema.
 */
(() => {
  'use strict';

  if (window.top !== window || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(location.hostname)) return;

  const ORIGIN = location.origin;
  const CONTENT_SOURCE = 'x-country-lens-content';
  const PAGE_SOURCE = 'x-country-lens-page';
  const FALLBACK_OPERATION = 'XRqGa7EeokUU5kppkh13EA';
  const MIN_INTERVAL_MS = 2000;
  const REQUEST_TIMEOUT_MS = 12000;
  const MAX_RESPONSE_BYTES = 262144;
  const nativeFetch = window.fetch;
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const xhrRequests = new WeakMap();
  const ALLOWED_HEADERS = new Set([
    'authorization', 'x-csrf-token', 'x-twitter-active-user', 'x-twitter-auth-type'
  ]);

  let authHeaders = null;
  let operationId = FALLBACK_OPERATION;
  let queryOptions = {};
  let inFlight = false;
  let lastRequestAt = 0;
  let cooldownUntil = 0;
  let authBlockedUntil = 0;
  let endpointUnavailable = false;
  let cooldownTimer = null;
  let lastState = '';
  let lastStatus = null;
  let lastHelloAt = 0;
  let messageWindowStart = 0;
  let messageCount = 0;

  function emit(payload) {
    window.postMessage({ source: PAGE_SOURCE, ...payload }, ORIGIN);
  }

  function status(state, message) {
    const key = state + ':' + message;
    if (key === lastState) return;
    lastState = key;
    lastStatus = { state, message };
    emit({ type: 'STATUS', state, message });
  }

  function validHandle(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(value);
  }

  function usableAuth() {
    return Boolean(authHeaders && authHeaders.authorization && authHeaders['x-csrf-token']);
  }

  function signalReady() {
    if (!usableAuth() || Date.now() < cooldownUntil || Date.now() < authBlockedUntil || endpointUnavailable) return;
    status('ready', 'Connected to X. Looking up accounts as you browse.');
    emit({ type: 'READY' });
  }

  function readCsrfCookie() {
    try {
      const cookie = document.cookie.match(/(?:^|;\s*)ct0=([^;]*)/);
      const value = cookie ? decodeURIComponent(cookie[1]) : '';
      return value && value.length <= 4096 && !/[\r\n]/.test(value) ? value : null;
    } catch { return null; }
  }

  function normalizedHeaders(input) {
    const result = {};
    try {
      new Headers(input).forEach((value, name) => {
        if (ALLOWED_HEADERS.has(name) && value.length <= 4096 && !/[\r\n]/.test(value)) {
          result[name] = value;
        }
      });
    } catch { /* Ignore malformed/unsupported headers without affecting X. */ }
    return result;
  }

  function captureAuth(input) {
    const headers = normalizedHeaders(input);
    if (!/^Bearer\s+\S+$/i.test(headers.authorization || '')) return;
    const csrf = readCsrfCookie() || headers['x-csrf-token'];
    if (!csrf) return;
    headers['x-csrf-token'] = csrf;
    const changed = !authHeaders || authHeaders.authorization !== headers.authorization ||
      authHeaders['x-csrf-token'] !== csrf;
    authHeaders = headers;
    if (changed) {
      authBlockedUntil = 0;
      signalReady();
    }
  }

  function requestInfo(input, init) {
    try {
      const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
      if (typeof rawUrl !== 'string') return null;
      const url = new URL(rawUrl, ORIGIN);
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      if (url.origin !== ORIGIN || !['GET', 'POST'].includes(method)) return null;
      const match = url.pathname.match(/^\/i\/api\/graphql\/([A-Za-z0-9_-]{1,100})\/([A-Za-z0-9_]{1,100})$/);
      if (!match) return null;
      let handle = null;
      if (match[2] === 'AboutAccountQuery') {
        const raw = url.searchParams.get('variables');
        if (raw && raw.length <= 8192) {
          const variables = JSON.parse(raw);
          if (validHandle(variables?.screenName)) handle = variables.screenName.toLowerCase();
        }
      }
      return { url, operation: match[2], operationId: match[1], method, handle };
    } catch { return null; }
  }

  function captureTemplate(info) {
    if (info.operation !== 'AboutAccountQuery' || info.method !== 'GET' || !info.handle) return;
    // Preserve only bounded JSON feature switches, never a caller-supplied URL.
    const options = {};
    for (const name of ['features', 'fieldToggles']) {
      const raw = info.url.searchParams.get(name);
      if (!raw || raw.length > 16384) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
            Object.keys(parsed).length <= 150 &&
            Object.values(parsed).every(value => typeof value === 'boolean')) {
          options[name] = JSON.stringify(parsed);
        }
      } catch { /* Ignore unrecognized query options. */ }
    }
    if (operationId !== info.operationId || JSON.stringify(queryOptions) !== JSON.stringify(options)) {
      endpointUnavailable = false;
    }
    operationId = info.operationId;
    queryOptions = options;
  }

  function parseCountry(data, handle) {
    // Verified path: data.user_result_by_screen_name.result.about_profile.account_based_in.
    // X's own About panel is the source; profile location and biography are never used.
    if (!data || typeof data !== 'object' || (Array.isArray(data.errors) && data.errors.length)) {
      return { status: 'unavailable', country: null, message: 'X did not return usable account data.' };
    }
    const user = data.data?.user_result_by_screen_name?.result;
    if (!user || typeof user !== 'object') {
      return { status: 'unavailable', country: null, message: 'Account information is unavailable from X.' };
    }
    const returnedHandle = user.core?.screen_name;
    if (typeof returnedHandle === 'string' && returnedHandle.toLowerCase() !== handle.toLowerCase()) {
      return { status: 'unavailable', country: null, message: 'X returned a different account; result ignored.' };
    }
    if (!user.about_profile || typeof user.about_profile !== 'object') {
      return { status: 'unknown', country: null, message: 'X does not publish an account country for this account.' };
    }
    const raw = user.about_profile.account_based_in;
    if (raw == null || raw === '') {
      return { status: 'unknown', country: null, message: 'X does not publish an account country for this account.' };
    }
    if (typeof raw !== 'string' || raw.length > 100 || /[\u0000-\u001f\u007f]/.test(raw)) {
      return { status: 'unavailable', country: null, message: 'X returned an unrecognized country value.' };
    }
    const country = raw.trim();
    return country ? { status: 'ok', country } : { status: 'unknown', country: null };
  }

  async function readJson(response) {
    const declaredSize = Number(response.headers?.get('content-length'));
    if (declaredSize > MAX_RESPONSE_BYTES) throw new Error('Response too large');
    if (!response.body?.getReader) {
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error('Response too large');
      return JSON.parse(text);
    }
    const reader = response.body.getReader();
    const bodyTimeout = setTimeout(() => { void reader.cancel().catch(() => {}); }, REQUEST_TIMEOUT_MS);
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => {});
          throw new Error('Response too large');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return JSON.parse(text);
    } finally { clearTimeout(bodyTimeout); reader.releaseLock(); }
  }

  function rateLimitDeadline(getHeader) {
    const now = Date.now();
    const reset = Number(getHeader('x-rate-limit-reset')) * 1000;
    const retryAfter = getHeader('retry-after');
    const retryNumber = Number(retryAfter);
    const retry = retryAfter ? (Number.isFinite(retryNumber) ? now + retryNumber * 1000 : Date.parse(retryAfter)) : 0;
    // A missing/invalid reset gets a conservative fifteen-minute pause.
    const candidates = [reset, retry].filter(value => Number.isFinite(value) && value > now);
    return Math.min(now + 86400000, candidates.length ? Math.max(...candidates) : now + 900000);
  }

  function setCooldown(deadline) {
    cooldownUntil = Math.max(cooldownUntil, deadline);
    const minutes = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 60000));
    status('rate-limited', `X lookup limit reached. Lookups resume in about ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => signalReady(), Math.max(0, cooldownUntil - Date.now()) + 20);
  }

  async function observeResponse(info, response) {
    if (info.operation !== 'AboutAccountQuery' || !info.handle) return;
    try {
      if (response.status === 429) {
        setCooldown(rateLimitDeadline(name => response.headers.get(name)));
        emit({ type: 'RESULT', handle: info.handle, status: 'rate-limited', country: null });
        return;
      }
      if (!response.ok) return;
      const result = parseCountry(await readJson(response.clone()), info.handle);
      if (result.status === 'ok' || result.status === 'unknown') {
        endpointUnavailable = false;
        signalReady();
      }
      emit({ type: 'RESULT', handle: info.handle, ...result });
    } catch { /* A passive observer must never interfere with the original response. */ }
  }

  // Keep X's original arguments, response and errors intact. Our lookups use nativeFetch.
  window.fetch = function (...args) {
    let info = null;
    try {
      info = requestInfo(args[0], args[1]);
      if (info) {
        captureTemplate(info);
        captureAuth(args[1]?.headers !== undefined ? args[1].headers : args[0]?.headers);
      }
    } catch { /* Do not break X on an unexpected request shape. */ }
    const promise = Reflect.apply(nativeFetch, this, args);
    if (info?.operation === 'AboutAccountQuery') {
      void promise.then(response => observeResponse(info, response)).catch(() => {});
    }
    return promise;
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const result = Reflect.apply(nativeOpen, this, [method, url, ...rest]);
    xhrRequests.set(this, { info: requestInfo(url, { method }), headers: {} });
    return result;
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    const result = Reflect.apply(nativeSetHeader, this, [name, value]);
    const entry = xhrRequests.get(this);
    const normalized = String(name).toLowerCase();
    if (entry && ALLOWED_HEADERS.has(normalized)) {
      entry.headers[normalized] = entry.headers[normalized] ? `${entry.headers[normalized]}, ${String(value)}` : String(value);
    }
    return result;
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const entry = xhrRequests.get(this);
    if (entry?.info) {
      try {
        captureTemplate(entry.info);
        captureAuth(entry.headers);
        if (entry.info.operation === 'AboutAccountQuery' && entry.info.handle) {
          this.addEventListener('load', () => {
            try {
              if (xhrRequests.get(this) !== entry) return;
              if (this.status === 429) {
                setCooldown(rateLimitDeadline(name => this.getResponseHeader(name)));
                emit({ type: 'RESULT', handle: entry.info.handle, status: 'rate-limited', country: null });
                return;
              }
              if (this.status < 200 || this.status >= 300) return;
              let data;
              if (this.responseType === 'json') data = this.response;
              else if ((!this.responseType || this.responseType === 'text') && this.responseText.length <= MAX_RESPONSE_BYTES) {
                data = JSON.parse(this.responseText);
              } else return;
              const result = parseCountry(data, entry.info.handle);
              if (result.status === 'ok' || result.status === 'unknown') {
                endpointUnavailable = false;
                signalReady();
              }
              emit({ type: 'RESULT', handle: entry.info.handle, ...result });
            } catch { /* Ignore unrecognized passive data. */ }
          }, { once: true });
        }
      } catch { /* Preserve XHR behavior if observation fails. */ }
    }
    return Reflect.apply(nativeSend, this, args);
  };

  async function lookup(handle) {
    const now = Date.now();
    if (now < cooldownUntil) return { status: 'rate-limited', country: null, message: 'X lookups are paused until its rate limit resets.' };
    if (!usableAuth()) {
      status('waiting', 'Waiting for a signed-in X session. Refresh X after signing in.');
      return { status: 'unavailable', country: null, message: 'No signed-in X request has been observed yet.' };
    }
    if (now < authBlockedUntil) return { status: 'unavailable', country: null, message: 'X rejected the lookup. Please try again later.' };
    if (endpointUnavailable) return { status: 'unavailable', country: null, message: 'X changed its lookup endpoint. Open an account’s About page to reconnect.' };
    if (inFlight) return { status: 'rate-limited', country: null, message: 'Another account lookup is already running.' };

    inFlight = true;
    let timeout;
    try {
      const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      if (Date.now() < cooldownUntil) return { status: 'rate-limited', country: null };
      lastRequestAt = Date.now();
      const url = new URL(`/i/api/graphql/${operationId}/AboutAccountQuery`, ORIGIN);
      url.searchParams.set('variables', JSON.stringify({ screenName: handle }));
      for (const [name, value] of Object.entries(queryOptions)) url.searchParams.set(name, value);
      const headers = { ...authHeaders, accept: 'application/json', 'accept-language': 'en-US,en;q=0.9', 'x-twitter-client-language': 'en' };
      const csrf = readCsrfCookie();
      if (csrf) headers['x-csrf-token'] = csrf;
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const response = await Reflect.apply(nativeFetch, window, [url.href, {
        method: 'GET', credentials: 'include', redirect: 'error', headers, signal: controller.signal
      }]);
      if (response.status === 429) {
        setCooldown(rateLimitDeadline(name => response.headers.get(name)));
        return { status: 'rate-limited', country: null, message: 'X lookup limit reached. Cached labels remain available.' };
      }
      if (response.status === 401 || response.status === 403) {
        authBlockedUntil = Date.now() + 60000;
        status('unavailable', 'X rejected account lookups. Sign in or open an account’s About page; this X endpoint may have changed.');
        return { status: 'unavailable', country: null, message: 'X rejected this lookup; no country was inferred.' };
      }
      if (response.status === 400 || response.status === 404) {
        endpointUnavailable = true;
        status('unavailable', 'X’s account lookup is unavailable. Open an account’s About page to refresh the lookup connection.');
        return { status: 'unavailable', country: null, message: 'X’s account lookup could not be used.' };
      }
      if (!response.ok) {
        authBlockedUntil = Date.now() + 30000;
        return { status: 'unavailable', country: null, message: 'X could not complete the account lookup.' };
      }
      const result = parseCountry(await readJson(response), handle);
      const remaining = response.headers.get('x-rate-limit-remaining');
      if (remaining !== null && Number(remaining) === 0) {
        setCooldown(rateLimitDeadline(name => response.headers.get(name)));
      } else if (result.status === 'ok' || result.status === 'unknown') signalReady();
      return result;
    } catch {
      return { status: 'unavailable', country: null, message: 'The X lookup timed out or could not be read.' };
    } finally {
      clearTimeout(timeout);
      inFlight = false;
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    const data = event.data;
    if (!data || data.source !== CONTENT_SOURCE) return;
    if (data.type === 'HELLO') {
      if (Date.now() - lastHelloAt < 1000) return;
      lastHelloAt = Date.now();
      if (usableAuth() && Date.now() >= cooldownUntil && Date.now() >= authBlockedUntil && !endpointUnavailable) signalReady();
      else emit({ type: 'STATUS', ...(lastStatus || { state: 'waiting', message: 'Waiting for X to load a signed-in session.' }) });
      return;
    }
    if (data.type !== 'LOOKUP') return;
    if (!validHandle(data.handle)) return;
    const idValid = (typeof data.requestId === 'string' && data.requestId.length > 0 && data.requestId.length <= 128) ||
      (typeof data.requestId === 'number' && Number.isSafeInteger(data.requestId) && data.requestId >= 0);
    if (!idValid) return;
    const now = Date.now();
    if (now - messageWindowStart >= 60000) { messageWindowStart = now; messageCount = 0; }
    if (++messageCount > 60) return;
    const handle = data.handle.toLowerCase();
    const requestId = data.requestId;
    void lookup(handle).then(result => emit({ type: 'RESULT', requestId, handle, ...result }));
  });

  status('waiting', 'Waiting for X to load a signed-in session.');
})();

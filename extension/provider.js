/* X account lookups run only in the extension service worker. No page messages. */
(function (root) {
  'use strict';
  const HOSTS = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'];
  const MATCHES = HOSTS.map(host => `https://${host}/i/api/graphql/*`);
  const OPERATION = 'XRqGa7EeokUU5kppkh13EA';
  const HEADERS = new Set(['authorization', 'x-csrf-token', 'x-twitter-active-user', 'x-twitter-auth-type']);
  const MAX_BODY = 262144;
  const REQUEST_TIMEOUT = 12000;
  const MIN_INTERVAL = 2000;
  const MAX_PENDING = 50;
  const MAX_OBSERVED = 128;
  const AUTH_TTL = 30 * 60 * 1000;
  const failure = (status, message, retryAfter) => ({ status, message, ...(retryAfter ? { retryAfter } : {}) });

  function originOf(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && HOSTS.includes(url.hostname) && !url.port && !url.username && !url.password ? url.origin : null;
    } catch { return null; }
  }

  function observedRequest(details) {
    if (typeof details.url !== 'string' || details.url.length > 32768) return null;
    const origin = originOf(details.url);
    if (!origin || originOf(details.initiator) !== origin || details.tabId < 0 || !Number.isInteger(details.tabId) ||
        details.frameId !== 0 || details.type !== 'xmlhttprequest' || !['GET', 'POST'].includes(details.method)) return null;
    const url = new URL(details.url);
    if (!/^\/i\/api\/graphql\/[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9_]{1,100}$/.test(url.pathname)) return null;
    return origin;
  }

  function readHeaders(entries) {
    const headers = Object.create(null);
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (typeof entry.name !== 'string') continue;
      const name = entry.name.toLowerCase();
      if (!HEADERS.has(name)) continue;
      // Duplicate or malformed security headers invalidate the entire candidate.
      if (Object.hasOwn(headers, name) || typeof entry.value !== 'string' || !entry.value ||
          entry.value.length > 4096 || /[\u0000-\u001f\u007f]/.test(entry.value)) return null;
      headers[name] = entry.value;
    }
    return /^Bearer +\S+$/i.test(headers.authorization || '') && headers['x-csrf-token'] ? headers : null;
  }

  function parseCountry(data, handle, core) {
    if (!data || typeof data !== 'object' || (Array.isArray(data.errors) && data.errors.length)) {
      return failure('unavailable', 'X did not return usable account data.');
    }
    const user = data.data?.user_result_by_screen_name?.result;
    // Never cache a response whose account identity is absent or different.
    if (!user || core.normalizeHandle(user.core?.screen_name) !== handle) {
      return failure('unavailable', 'X returned an unverified account; result ignored.');
    }
    const raw = user.about_profile?.account_based_in;
    if (raw == null || (typeof raw === 'string' && !raw.trim())) return { status: 'unknown', location: null };
    if (typeof raw !== 'string' || /[\p{Cc}\p{Cf}<>]/u.test(raw)) return failure('unavailable', 'X returned an invalid location.');
    const location = core.normalizeLocation(raw);
    if (!location) return failure('unavailable', 'X returned an invalid location.');
    return { status: 'ok', location };
  }

  async function readJson(response) {
    if (Number(response.headers.get('content-length')) > MAX_BODY || !response.body?.getReader) throw new Error('Invalid response size');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) {
          void reader.cancel().catch(() => {});
          throw new Error('Response too large');
        }
        text += decoder.decode(value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } finally { reader.releaseLock(); }
  }

  function rateLimitDeadline(headers, now) {
    const retryAfter = headers.get('retry-after');
    const retry = retryAfter ? (Number.isFinite(Number(retryAfter)) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter)) : 0;
    const reset = Number(headers.get('x-rate-limit-reset')) * 1000;
    const candidates = [retry, reset].filter(time => Number.isFinite(time) && time > now);
    return Math.min(now + 86400000, candidates.length ? Math.max(...candidates) : now + 900000);
  }

  function createProvider({ core, fetch: doFetch = root.fetch.bind(root), now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, persistThrottle = async () => {}, onStatus = () => {} }) {
    let active = false;
    let epoch = 0;
    let running = false;
    let controller = null;
    let nextRequestAt = 0;
    let cooldownUntil = 0;
    let unavailableUntil = 0;
    let lastStatus = '';
    const observations = new Map();
    const candidates = new Map();
    const auth = new Map();
    const pending = new Map();
    let queue = [];

    function status(state, message) {
      const key = `${state}:${message}`;
      if (key === lastStatus) return;
      lastStatus = key;
      onStatus({ state, message, updatedAt: now() });
    }
    function throttle() { return { nextRequestAt, cooldownUntil, unavailableUntil }; }
    function restoreThrottle(value) {
      const sane = time => Number.isFinite(time) && time > now() && time <= now() + 86400000 ? time : 0;
      nextRequestAt = Math.min(sane(value?.nextRequestAt), now() + MIN_INTERVAL);
      cooldownUntil = sane(value?.cooldownUntil);
      unavailableUntil = Math.min(sane(value?.unavailableUntil), now() + 60000);
    }
    function configure(settings) {
      const enabled = settings.enabled === true && settings.autoLookup !== false;
      if (enabled === active) {
        if (!active) status('paused', 'Account lookups are paused.');
        return;
      }
      active = enabled;
      epoch++;
      observations.clear();
      candidates.clear();
      auth.clear();
      controller?.abort();
      for (const task of pending.values()) task.resolve(failure('paused', 'Account lookups are paused.'));
      pending.clear();
      queue = [];
      status(active ? 'waiting' : 'paused', active ? 'Waiting for a successful signed-in X request. Refresh X to connect.' : 'Account lookups are paused.');
    }
    function beforeRequest(details) {
      if (!active) return;
      observations.delete(details.requestId);
      const origin = observedRequest(details);
      const headers = origin && readHeaders(details.requestHeaders);
      if (!headers || typeof details.requestId !== 'string') return;
      for (const [id, entry] of observations) if (entry.at + REQUEST_TIMEOUT < now()) observations.delete(id);
      if (observations.size >= MAX_OBSERVED) observations.delete(observations.keys().next().value);
      observations.set(details.requestId, { origin, headers, at: now(), url: details.url, tabId: details.tabId, epoch });
    }
    function completed(details) {
      const entry = observations.get(details.requestId);
      observations.delete(details.requestId);
      if (!active || !entry || entry.epoch !== epoch || entry.at + REQUEST_TIMEOUT < now() || entry.url !== details.url ||
          entry.tabId !== details.tabId || details.frameId !== 0 || !Number.isInteger(details.statusCode) || details.statusCode < 200 || details.statusCode >= 300) return;
      candidates.set(entry.origin, { headers: entry.headers, expires: now() + AUTH_TTL });
      // Failed/redirected requests never replace credentials or endpoint state.
      // The operation is fixed in extension code, never accepted from the page.
      if (now() >= cooldownUntil && now() >= unavailableUntil) status('ready', 'Connected to X. Looking up accounts as you browse.');
    }
    function discarded(details) { observations.delete(details.requestId); }
    function unavailable(message, delay = 30000) {
      unavailableUntil = now() + delay;
      status('unavailable', message);
      return failure('unavailable', message, delay);
    }
    async function request(task) {
      const taskEpoch = epoch;
      let timeout;
      try {
        const wait = Math.max(0, nextRequestAt - now());
        if (wait) await new Promise(resolve => setTimer(resolve, wait));
        if (!active || taskEpoch !== epoch) return failure('paused', 'Account lookups are paused.');
        if (now() < cooldownUntil) return failure('rate-limited', 'X lookup limit reached.', cooldownUntil - now());
        if (now() < unavailableUntil) return failure('unavailable', 'X account lookups are temporarily unavailable.', unavailableUntil - now());
        const verifiedSession = auth.get(task.origin);
        const candidateSession = candidates.get(task.origin);
        // Successful observation makes a candidate usable, but cannot replace
        // credentials already verified by a valid account response.
        const session = verifiedSession?.expires > now() ? verifiedSession : candidateSession;
        if (!session || session.expires <= now()) {
          auth.delete(task.origin);
          candidates.delete(task.origin);
          status('waiting', 'Waiting for a successful signed-in X request. Refresh X to connect.');
          return failure('waiting', 'Waiting for a signed-in X session.', 15000);
        }
        // Persist pacing before the request so service-worker restarts cannot reset it.
        nextRequestAt = now() + MIN_INTERVAL;
        await persistThrottle(throttle());
        if (!active || taskEpoch !== epoch) return failure('paused', 'Account lookups are paused.');
        const url = new URL(`/i/api/graphql/${OPERATION}/AboutAccountQuery`, task.origin);
        url.searchParams.set('variables', JSON.stringify({ screenName: task.handle }));
        if (url.origin !== task.origin || !originOf(url.href)) throw new Error('Invalid lookup origin');
        controller = new AbortController();
        timeout = setTimer(() => controller?.abort(), REQUEST_TIMEOUT);
        const response = await doFetch(url.href, { method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store',
          headers: { ...session.headers, accept: 'application/json', 'accept-language': 'en-US,en;q=0.9', 'x-twitter-client-language': 'en' }, signal: controller.signal });
        if (!active || taskEpoch !== epoch) return failure('paused', 'Account lookups are paused.');
        if (response.status === 429) {
          cooldownUntil = Math.max(cooldownUntil, rateLimitDeadline(response.headers, now()));
          await persistThrottle(throttle());
          status('rate-limited', 'X lookup limit reached. Cached labels remain available.');
          return failure('rate-limited', 'X lookup limit reached.', cooldownUntil - now());
        }
        if (response.status === 401 || response.status === 403) {
          if (auth.get(task.origin) === session) auth.delete(task.origin);
          if (candidates.get(task.origin) === session) candidates.delete(task.origin);
          const result = unavailable('X rejected the lookup. Sign in and refresh X to reconnect.', 60000);
          await persistThrottle(throttle());
          return result;
        }
        if (!response.ok) {
          const result = unavailable('X account lookups are temporarily unavailable.');
          await persistThrottle(throttle());
          return result;
        }
        const result = parseCountry(await readJson(response), task.handle, core);
        if (!active || taskEpoch !== epoch) return failure('paused', 'Account lookups are paused.');
        if (result.status === 'ok' || result.status === 'unknown') {
          auth.set(task.origin, { headers: session.headers, expires: now() + AUTH_TTL });
          if (candidates.get(task.origin) === session) candidates.delete(task.origin);
        } else if (candidates.get(task.origin) === session) {
          candidates.delete(task.origin);
        }
        if (response.headers.get('x-rate-limit-remaining') === '0') {
          cooldownUntil = Math.max(cooldownUntil, rateLimitDeadline(response.headers, now()));
          await persistThrottle(throttle());
          status('rate-limited', 'X lookup limit reached. Cached labels remain available.');
        } else if (result.status === 'ok' || result.status === 'unknown') {
          status('ready', 'Connected to X. Looking up accounts as you browse.');
        }
        return result.status === 'ok' || result.status === 'unknown'
          ? { status: result.status, record: { location: result.location, checkedAt: now(), source: 'x-about-account' } }
          : result;
      } catch {
        return failure(active && taskEpoch === epoch ? 'unavailable' : 'paused', 'The X lookup stopped or could not be read.', 15000);
      } finally { clearTimer(timeout); controller = null; }
    }
    async function pump() {
      if (running) return;
      running = true;
      try {
        while (queue.length) {
          const task = queue.shift();
          const result = await request(task);
          // A disabled/re-enabled provider may now have a new task with the same key.
          if (pending.get(task.key) === task) {
            pending.delete(task.key);
            task.resolve(result);
          }
        }
      } finally { running = false; }
    }
    function lookup(handle, origin) {
      handle = core.normalizeHandle(handle);
      if (!handle || originOf(origin) !== origin) return Promise.resolve(failure('unavailable', 'Invalid account lookup.'));
      if (!active) return Promise.resolve(failure('paused', 'Account lookups are paused.'));
      const key = `${origin}:${handle}`;
      if (pending.has(key)) return pending.get(key).promise;
      if (pending.size >= MAX_PENDING) return Promise.resolve(failure('rate-limited', 'The lookup queue is full. Try again shortly.', 15000));
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      const task = { key, origin, handle, promise, resolve };
      pending.set(key, task);
      queue.push(task);
      void pump();
      return promise;
    }
    return { configure, beforeRequest, completed, discarded, lookup, restoreThrottle, isActive: () => active };
  }

  const api = { createProvider, originOf, parseCountry, readHeaders, observedRequest, MATCHES, MIN_INTERVAL, MAX_BODY, OPERATION };
  root.XCountryProvider = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);

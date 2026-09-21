const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setImmediate: nextTurn } = require('node:timers/promises');
const C = require('../extension/core.js');

const extensionDir = path.join(__dirname, '../extension');
const extensionId = 'test-country-lens';
const popupUrl = `chrome-extension://${extensionId}/popup.html`;
const xSender = { id: extensionId, frameId: 0, url: 'https://x.com/home', tab: { id: 1, url: 'https://x.com/home' }, documentLifecycle: 'active' };
const popupSender = { id: extensionId, url: popupUrl };
const account = (handle, country = 'Japan') => ({ data: { user_result_by_screen_name: { result: {
  core: { screen_name: handle }, about_profile: { account_based_in: country }
} } } });
const validRecord = (country = 'Japan', checkedAt = Date.now()) => ({ location: C.normalizeLocation(country), checkedAt, source: 'x-about-account' });

function event() {
  const listeners = new Set();
  return { addListener(callback) { listeners.add(callback); }, removeListener(callback) { listeners.delete(callback); },
    emit(...args) { for (const callback of [...listeners]) callback(...args); }, get count() { return listeners.size; } };
}
function createBackground(initial = {}, fetcher) {
  const saved = structuredClone(initial);
  const session = {};
  const calls = [];
  const writes = [];
  let clock = Date.now();
  let messageListener;
  let failNextWrite = false;
  const changed = event();
  function storageArea(target, area) {
    return {
      async get(keys) {
        const result = {};
        for (const name of Array.isArray(keys) ? keys : [keys]) if (Object.hasOwn(target, name)) result[name] = structuredClone(target[name]);
        await nextTurn();
        return result;
      },
      async set(values) {
        const snapshot = structuredClone(values);
        await nextTurn();
        if (area === 'local' && failNextWrite) { failNextWrite = false; throw new Error('Simulated storage failure'); }
        const changes = {};
        for (const [key, value] of Object.entries(snapshot)) changes[key] = { oldValue: structuredClone(target[key]), newValue: value };
        Object.assign(target, snapshot);
        writes.push({ area, values: snapshot });
        changed.emit(changes, area);
      }
    };
  }
  const chrome = {
    runtime: { id: extensionId, getURL: file => `chrome-extension://${extensionId}/${file}`,
      onMessage: { addListener(callback) { messageListener = callback; } } },
    storage: { local: storageArea(saved, 'local'), session: storageArea(session, 'session'), onChanged: changed },
    webRequest: { onBeforeSendHeaders: event(), onCompleted: event(), onErrorOccurred: event(), onBeforeRedirect: event() }
  };
  const context = vm.createContext({ chrome, URL, TextDecoder, AbortController,
    Date: class extends Date { static now() { return clock; } },
    setTimeout(callback, ms) {
      if (ms < 12000) { clock += ms; return setTimeout(callback, 0); }
      return setTimeout(callback, ms);
    }, clearTimeout,
    async fetch(url, options) {
      calls.push({ url, options });
      return fetcher ? fetcher(url, options) : Response.json(account(JSON.parse(new URL(url).searchParams.get('variables')).screenName));
    }
  });
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(extensionDir, file), 'utf8'), context, { filename: file });
  };
  vm.runInContext(fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  return {
    saved, session, chrome, calls, writes,
    async ready() { await vm.runInContext('ready', context); await nextTurn(); },
    holdWrites() {
      let release;
      context.writeBarrier = new Promise(resolve => { release = resolve; });
      vm.runInContext('serial = writeBarrier', context);
      delete context.writeBarrier;
      return release;
    },
    failNextWrite() { failNextWrite = true; },
    observe(value = 'valid', statusCode = 200, extra = {}) {
      const details = { requestId: 'request-1', url: 'https://x.com/i/api/graphql/Current/HomeTimeline', initiator: 'https://x.com',
        tabId: 1, frameId: 0, method: 'GET', type: 'xmlhttprequest', requestHeaders: [
          { name: 'authorization', value: `Bearer ${value}` }, { name: 'x-csrf-token', value: `csrf-${value}` }
        ], ...extra };
      chrome.webRequest.onBeforeSendHeaders.emit(details);
      chrome.webRequest.onCompleted.emit({ ...details, statusCode });
    },
    dispatch(message, sender = xSender) {
      return new Promise((resolve, reject) => {
        try {
          const asynchronous = messageListener(message, sender, response => resolve(structuredClone(response)));
          if (asynchronous !== true) resolve(undefined);
        } catch (error) { reject(error); }
      });
    }
  };
}

test('migration clears all pre-fix country records while preserving settings', async () => {
  const settings = { ...C.DEFAULT_SETTINGS, countries: ['US'] };
  const h = createBackground({ settings, countryCache: { poisoned: validRecord('Russia') } });
  await h.ready();
  assert.deepEqual(h.saved.countryCache, {});
  assert.equal(h.saved.cacheVersion, 2);
  assert.deepEqual(h.saved.settings, settings);
});

test('legacy cache/status messages are rejected even with a valid content-script sender', async () => {
  const h = createBackground();
  await h.ready();
  for (const type of ['CACHE_RECORD', 'PROVIDER_STATUS', 'RESULT']) {
    assert.equal(await h.dispatch({ type, handle: 'alice', country: 'Russia', status: 'ok', state: 'ready' }), undefined);
  }
  assert.deepEqual(h.saved.countryCache, {});
  assert.equal(h.calls.length, 0);
});

test('only this extension’s active top-frame X content script may initiate a lookup', async () => {
  const h = createBackground();
  await h.ready();
  h.observe();
  for (const sender of [
    {}, { ...xSender, id: 'different-extension' }, { ...xSender, frameId: 1 }, { ...xSender, frameId: undefined },
    { ...xSender, tab: undefined }, { ...xSender, tab: { id: -1, url: xSender.url } },
    { ...xSender, tab: { id: 1, url: 'https://evil.example' } }, { ...xSender, url: 'https://x.com.evil.example' },
    { ...xSender, url: 'https://x.com:8443' }, { ...xSender, url: 'http://x.com' },
    { ...xSender, documentLifecycle: 'prerender' }, popupSender
  ]) assert.equal(await h.dispatch({ type: 'LOOKUP', handle: 'alice' }, sender), undefined);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.saved.countryCache, {});
  assert.equal((await h.dispatch({ type: 'LOOKUP', handle: 'alice' })).record.location.key, 'JP');
});

test('malformed handles never become network requests or cache keys', async () => {
  const h = createBackground();
  await h.ready();
  h.observe();
  for (const handle of ['', '../home', '@someone', 'has spaces', 'a'.repeat(16), null, 123]) {
    assert.equal((await h.dispatch({ type: 'LOOKUP', handle })).status, 'unavailable');
  }
  assert.equal(h.calls.length, 0);
});

test('concurrent verified results preserve cache entries; duplicates make one network request/write', async () => {
  const h = createBackground();
  await h.ready();
  h.observe();
  const results = await Promise.all([
    h.dispatch({ type: 'LOOKUP', handle: 'alice' }),
    h.dispatch({ type: 'LOOKUP', handle: 'ALICE' }, { ...xSender, tab: { ...xSender.tab, id: 2 } }),
    h.dispatch({ type: 'LOOKUP', handle: 'bob' })
  ]);
  assert.equal(results.every(result => result.status === 'ok'), true);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(Object.keys(h.saved.countryCache).sort(), ['alice', 'bob']);
  assert.equal(h.writes.filter(write => write.values.countryCache?.alice).length, 2);
  assert.equal(JSON.stringify(h.saved).includes('Bearer'), false);
  assert.equal(JSON.stringify(h.session).includes('csrf'), false);
  assert.ok(h.session.providerThrottle.nextRequestAt);
});

test('missing or wrong identity and provider errors never become cache records', async () => {
  for (const response of [Response.json(account('bob')), Response.json(account(undefined)), new Response('', { status: 503 })]) {
    const h = createBackground({}, () => response);
    await h.ready();
    h.observe();
    const result = await h.dispatch({ type: 'LOOKUP', handle: 'alice' });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.record, undefined);
    assert.deepEqual(h.saved.countryCache, {});
  }
});

test('only exact popup can clear cache and settings survive', async () => {
  const settings = { ...C.DEFAULT_SETTINGS, countries: ['US'] };
  const h = createBackground({ cacheVersion: 2, settings, countryCache: { alice: validRecord() } });
  await h.ready();
  for (const sender of [xSender, { ...popupSender, id: 'different' }, { ...popupSender, url: popupUrl + '?spoof=1' }]) {
    assert.equal(await h.dispatch({ type: 'CLEAR_CACHE' }, sender), undefined);
  }
  assert.ok(h.saved.countryCache.alice);
  assert.deepEqual(await h.dispatch({ type: 'CLEAR_CACHE' }, popupSender), { ok: true });
  assert.deepEqual(h.saved.countryCache, {});
  assert.deepEqual(h.saved.settings, settings);
});

test('disabled settings remove observers, abort requests and require fresh auth after re-enable', async () => {
  let signal;
  const h = createBackground({}, (url, options) => new Promise((resolve, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
  }));
  await h.ready();
  h.observe();
  const pending = h.dispatch({ type: 'LOOKUP', handle: 'alice' });
  while (!signal) await nextTurn();
  await h.chrome.storage.local.set({ settings: { ...C.DEFAULT_SETTINGS, enabled: false } });
  assert.equal(signal.aborted, true);
  assert.equal((await pending).status, 'paused');
  assert.equal(h.chrome.webRequest.onBeforeSendHeaders.count, 0);
  assert.equal(h.chrome.webRequest.onCompleted.count, 0);
  h.observe('ignored');
  await h.chrome.storage.local.set({ settings: C.DEFAULT_SETTINGS });
  assert.equal(h.chrome.webRequest.onBeforeSendHeaders.count, 1);
  assert.equal((await h.dispatch({ type: 'LOOKUP', handle: 'alice' })).status, 'waiting');
  assert.deepEqual(h.saved.countryCache, {});
});

test('auto lookup off removes observation and a disabled startup never captures auth', async () => {
  for (const settings of [{ ...C.DEFAULT_SETTINGS, enabled: false }, { ...C.DEFAULT_SETTINGS, autoLookup: false }]) {
    const h = createBackground({ settings });
    h.observe('early');
    await h.ready();
    assert.equal(h.chrome.webRequest.onBeforeSendHeaders.count, 0);
    assert.equal((await h.dispatch({ type: 'LOOKUP', handle: 'alice' })).status, 'paused');
    assert.equal(h.calls.length, 0);
    await h.chrome.storage.local.set({ settings: C.DEFAULT_SETTINGS });
    assert.equal((await h.dispatch({ type: 'LOOKUP', handle: 'alice' })).status, 'waiting');
  }
});

test('a result queued for storage before disable/re-enable cannot repopulate the cache', async () => {
  const h = createBackground();
  await h.ready();
  h.observe();
  const release = h.holdWrites();
  const lookup = h.dispatch({ type: 'LOOKUP', handle: 'alice' });
  while (!h.calls.length) await nextTurn();
  await nextTurn();
  await h.chrome.storage.local.set({ settings: { ...C.DEFAULT_SETTINGS, enabled: false } });
  await h.chrome.storage.local.set({ settings: C.DEFAULT_SETTINGS });
  release();
  assert.equal((await lookup).status, 'paused');
  assert.deepEqual(h.saved.countryCache, {});
});

test('full cache evicts oldest entries and retains a newly verified account', async () => {
  const countryCache = Object.fromEntries(Array.from({ length: 5000 }, (_, n) => [`user${n}`, validRecord('Japan', Date.now() - 100000 - n)]));
  const h = createBackground({ cacheVersion: 2, countryCache });
  await h.ready();
  h.observe();
  assert.equal((await h.dispatch({ type: 'LOOKUP', handle: 'newuser' })).status, 'ok');
  assert.equal(Object.keys(h.saved.countryCache).length, 5000);
  assert.equal(h.saved.countryCache.newuser.location.key, 'JP');
  assert.equal(h.saved.countryCache.user4999, undefined);
});

test('a failed storage write does not poison later queued writes', async () => {
  const h = createBackground({ cacheVersion: 2, countryCache: { alice: validRecord() } });
  await h.ready();
  h.failNextWrite();
  assert.equal((await h.dispatch({ type: 'CLEAR_CACHE' }, popupSender)).ok, false);
  assert.deepEqual(await h.dispatch({ type: 'CLEAR_CACHE' }, popupSender), { ok: true });
  assert.deepEqual(h.saved.countryCache, {});
});

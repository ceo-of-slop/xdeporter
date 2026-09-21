const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setImmediate: nextTurn } = require('node:timers/promises');

const extensionDir = path.join(__dirname, '../extension');
const extensionId = 'test-country-lens';
const popupUrl = `chrome-extension://${extensionId}/popup.html`;
const xSender = { id: extensionId, url: 'https://x.com/home' };
const popupSender = { id: extensionId, url: popupUrl };

function createBackground(initial = {}) {
  const saved = structuredClone(initial);
  let listener;
  let failNextRead = false;
  const chrome = {
    runtime: {
      id: extensionId,
      getURL: file => `chrome-extension://${extensionId}/${file}`,
      onInstalled: { addListener() {} },
      onMessage: { addListener(callback) { listener = callback; } }
    },
    storage: { local: {
      async get(keys) {
        if (failNextRead) { failNextRead = false; throw new Error('Simulated storage failure'); }
        const names = Array.isArray(keys) ? keys : [keys];
        const result = {};
        for (const name of names) if (Object.hasOwn(saved, name)) result[name] = structuredClone(saved[name]);
        // Model Chrome's asynchronous storage and separate read snapshots. A
        // nonserialized read/modify/write implementation loses records here.
        await nextTurn();
        return result;
      },
      async set(values) {
        const snapshot = structuredClone(values);
        await nextTurn();
        Object.assign(saved, snapshot);
      }
    } }
  };
  const context = vm.createContext({ chrome, URL });
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(extensionDir, file), 'utf8'), context, { filename: file });
  };
  vm.runInContext(fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  return {
    saved,
    failNextRead() { failNextRead = true; },
    dispatch(message, sender = xSender) {
      return new Promise((resolve, reject) => {
        try {
          const asynchronous = listener(message, sender, response => resolve(structuredClone(response)));
          if (asynchronous !== true) resolve(undefined);
        } catch (error) { reject(error); }
      });
    }
  };
}

const record = (handle, country = 'United States', status = 'ok') => ({ type: 'CACHE_RECORD', handle, country, status });

test('concurrent messages preserve separate country records across asynchronous storage writes', async () => {
  const background = createBackground();
  const results = await Promise.all([
    background.dispatch(record('First_User')),
    background.dispatch(record('second_user', 'Japan')),
    background.dispatch(record('third_user', 'Canada'))
  ]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
  assert.deepEqual(Object.keys(background.saved.countryCache).sort(), ['first_user', 'second_user', 'third_user']);
  assert.equal(background.saved.countryCache.first_user.location.key, 'US');
  assert.equal(background.saved.countryCache.second_user.location.key, 'JP');
  assert.equal(background.saved.countryCache.third_user.location.key, 'CA');
  for (const cached of Object.values(background.saved.countryCache)) {
    assert.equal(cached.source, 'x-about-account');
    assert.equal(typeof cached.checkedAt, 'number');
  }
});

test('untrusted or malformed sender URLs cannot add cache records', async () => {
  const background = createBackground();
  for (const sender of [
    {},
    { id: extensionId, url: 'not a URL' },
    { id: extensionId, url: 'https://x.com.attacker.example/home' },
    { id: extensionId, url: 'http://x.com/home' },
    { id: extensionId, url: 'https://example.com/home' },
    { id: 'different-extension', url: popupUrl }
  ]) {
    assert.equal(await background.dispatch(record('someone'), sender), undefined);
  }
  assert.deepEqual(background.saved, {});
});

test('invalid account handles and invalid successful country values are rejected', async () => {
  const background = createBackground();
  for (const handle of ['', '../home', '@someone', 'has spaces', 'a'.repeat(16), null, 123]) {
    assert.deepEqual(await background.dispatch(record(handle)), { ok: false });
  }
  for (const country of [null, '', 'Unknown', '<script>', 'x'.repeat(101)]) {
    assert.deepEqual(await background.dispatch(record('someone', country)), { ok: false });
  }
  assert.deepEqual(background.saved, {});
});

test('provider failures never overwrite known countries or become negative cache records', async () => {
  const background = createBackground();
  await background.dispatch(record('known_user', 'Japan'));
  const original = structuredClone(background.saved.countryCache.known_user);
  for (const status of ['unavailable', 'rate-limited', 'error', 'timeout']) {
    assert.deepEqual(await background.dispatch(record('known_user', null, status)), { ok: false });
    assert.deepEqual(await background.dispatch(record('failed_user', null, status)), { ok: false });
  }
  assert.deepEqual(background.saved.countryCache.known_user, original);
  assert.equal(Object.hasOwn(background.saved.countryCache, 'failed_user'), false);
  assert.deepEqual(await background.dispatch(record('unknown_user', null, 'unknown')), { ok: true });
  assert.equal(background.saved.countryCache.unknown_user.location, null);
});

test('only the extension popup can clear cache and settings survive the clear', async () => {
  const settings = { enabled: true, mode: 'block', countries: ['US'] };
  const background = createBackground({ settings });
  await background.dispatch(record('someone'));
  assert.equal(await background.dispatch({ type: 'CLEAR_CACHE' }), undefined);
  assert.equal(await background.dispatch({ type: 'CLEAR_CACHE' }, { id: 'different-extension', url: popupUrl }), undefined);
  assert.equal(await background.dispatch({ type: 'CLEAR_CACHE' }, { id: extensionId, url: popupUrl + '?spoof=1' }), undefined);
  assert.equal(Object.hasOwn(background.saved.countryCache, 'someone'), true);
  assert.deepEqual(await background.dispatch({ type: 'CLEAR_CACHE' }, popupSender), { ok: true });
  assert.deepEqual(background.saved.countryCache, {});
  assert.deepEqual(background.saved.settings, settings);
});

test('a failed storage operation does not poison later queued writes', async () => {
  const background = createBackground();
  background.failNextRead();
  const [failed, succeeded] = await Promise.all([
    background.dispatch(record('first_user')),
    background.dispatch(record('second_user', 'Japan'))
  ]);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /storage/i);
  assert.deepEqual(succeeded, { ok: true });
  assert.deepEqual(Object.keys(background.saved.countryCache), ['second_user']);
});

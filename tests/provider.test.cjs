const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../extension/core.js');
const P = require('../extension/provider.js');

const authHeaders = value => [
  { name: 'Authorization', value: `Bearer ${value}` },
  { name: 'x-csrf-token', value: `csrf-${value}` },
  { name: 'Cookie', value: 'never-retain=this' },
  { name: 'x-not-allowed', value: 'not-retained' }
];
const observed = (id = 'request-1', value = 'good', extra = {}) => ({
  requestId: id, url: 'https://x.com/i/api/graphql/AnyOperation/HomeTimeline', initiator: 'https://x.com',
  tabId: 1, frameId: 0, type: 'xmlhttprequest', method: 'GET', requestHeaders: authHeaders(value), ...extra
});
const account = (handle, country = 'Japan') => ({ data: { user_result_by_screen_name: { result: {
  core: { screen_name: handle }, about_profile: { account_based_in: country }
} } } });
function setup(fetcher) {
  let clock = 100000;
  let timerId = 0;
  const calls = [];
  const statuses = [];
  const throttles = [];
  const timeouts = new Map();
  const provider = P.createProvider({ core: C, now: () => clock,
    setTimer(fn, ms) {
      const id = ++timerId;
      if (ms < 12000) { clock += ms; queueMicrotask(fn); }
      else timeouts.set(id, fn);
      return id;
    },
    clearTimer(id) { timeouts.delete(id); },
    async persistThrottle(value) { throttles.push(structuredClone(value)); },
    onStatus(value) { statuses.push(value); },
    async fetch(url, options) {
      calls.push({ url, options, at: clock });
      return fetcher ? fetcher(url, options) : Response.json(account(JSON.parse(new URL(url).searchParams.get('variables')).screenName));
    }
  });
  provider.configure(C.DEFAULT_SETTINGS);
  function observe(value = 'good', extra = {}, statusCode = 200) {
    const details = observed(`r${++timerId}`, value, extra);
    provider.beforeRequest(details);
    provider.completed({ ...details, statusCode });
    return details;
  }
  return { provider, calls, statuses, throttles, observe, timeouts, advance(ms) { clock += ms; } };
}

test('only fixed-origin lookups use allowlisted headers and require verified response identity', async () => {
  const h = setup();
  h.observe();
  const result = await h.provider.lookup('Alice', 'https://x.com');
  assert.equal(result.status, 'ok');
  assert.equal(result.record.location.key, 'JP');
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  const url = new URL(call.url);
  assert.equal(url.pathname, `/i/api/graphql/${P.OPERATION}/AboutAccountQuery`);
  assert.equal(url.origin, 'https://x.com');
  assert.equal(call.options.credentials, 'include');
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.headers.authorization, 'Bearer good');
  assert.equal(call.options.headers['x-csrf-token'], 'csrf-good');
  assert.equal(call.options.headers.Cookie, undefined);
  assert.equal(call.options.headers['x-not-allowed'], undefined);
  assert.equal(h.throttles[0].nextRequestAt, call.at + P.MIN_INTERVAL);
});

test('failed, redirected, aborted, stale, wrong-origin and iframe observations never commit auth', async () => {
  for (const change of [
    { statusCode: 401 }, { statusCode: 403 }, { statusCode: 302 }, { statusCode: 500 },
    { discarded: true }, { expired: true }, { extra: { frameId: 2 } }, { extra: { tabId: -1 } },
    { extra: { initiator: 'https://evil.example' } }, { extra: { url: 'https://x.com.evil.example/i/api/graphql/Fake/HomeTimeline' } },
    { extra: { url: 'https://x.com:8443/i/api/graphql/Fake/HomeTimeline' } },
    { extra: { url: 'https://x.com/other' } }, { extra: { type: 'image' } },
    { extra: { requestHeaders: [{ name: 'Authorization', value: 'Bearer no-csrf' }] } }
  ]) {
    const h = setup();
    const details = observed('test', 'bad', change.extra);
    h.provider.beforeRequest(details);
    if (change.discarded) h.provider.discarded(details);
    if (change.expired) h.advance(13000);
    h.provider.completed({ ...details, statusCode: change.statusCode || 200 });
    assert.equal((await h.provider.lookup('alice', 'https://x.com')).status, 'waiting');
    assert.equal(h.calls.length, 0);
  }
});

test('failed request cannot replace good headers or redirect the fixed operation', async () => {
  const h = setup();
  h.observe('good');
  h.observe('poison', { url: 'https://x.com/i/api/graphql/Evil/AboutAccountQuery?features=bad' }, 403);
  const result = await h.provider.lookup('alice', 'https://x.com');
  assert.equal(result.status, 'ok');
  assert.equal(h.calls[0].options.headers.authorization, 'Bearer good');
  assert.equal(new URL(h.calls[0].url).searchParams.has('features'), false);
});

test('successful unrelated observation cannot replace credentials verified by an account response', async () => {
  const h = setup();
  h.observe('good');
  assert.equal((await h.provider.lookup('alice', 'https://x.com')).status, 'ok');
  h.observe('unproven', {}, 200);
  assert.equal((await h.provider.lookup('bob', 'https://x.com')).status, 'ok');
  assert.equal(h.calls[1].options.headers.authorization, 'Bearer good');
});

test('auth observed on one host is never forwarded to another host', async () => {
  const h = setup();
  h.observe();
  for (const origin of ['https://twitter.com', 'https://www.x.com', 'https://evil.example', 'http://x.com', 'https://x.com:8443']) {
    assert.notEqual((await h.provider.lookup('alice', origin)).status, 'ok');
  }
  assert.equal(h.calls.length, 0);
});

test('strict account identity and control-character checks prevent cache poisoning', () => {
  for (const data of [
    account('bob'), account(undefined), { data: { user_result_by_screen_name: { result: { about_profile: { account_based_in: 'Russia' } } } } },
    account('alice', 'United\u202eStates'), account('alice', 'Jap\u200ban'), account('alice', '<Japan>'),
    { ...account('alice'), errors: [{ message: 'not valid' }] }
  ]) assert.equal(P.parseCountry(data, 'alice', C).status, 'unavailable');
  assert.equal(P.parseCountry(account('ALICE', 'Japan'), 'alice', C).status, 'ok');
  assert.equal(P.parseCountry(account('alice', null), 'alice', C).status, 'unknown');
});

test('all tabs share one paced queue and duplicate pending handles share one request', async () => {
  const h = setup();
  h.observe();
  const first = h.provider.lookup('alice', 'https://x.com');
  const duplicate = h.provider.lookup('ALICE', 'https://x.com');
  const other = h.provider.lookup('bob', 'https://x.com');
  assert.equal(first, duplicate);
  await Promise.all([first, duplicate, other]);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls[1].at - h.calls[0].at >= P.MIN_INTERVAL);
});

test('rate-limit cooldown persists and blocks every tab/origin', async () => {
  const h = setup(() => new Response('', { status: 429, headers: { 'retry-after': '60' } }));
  h.observe();
  h.observe('other', { url: 'https://twitter.com/i/api/graphql/Any/HomeTimeline', initiator: 'https://twitter.com' });
  const first = await h.provider.lookup('alice', 'https://x.com');
  assert.equal(first.status, 'rate-limited');
  assert.equal(first.retryAfter, 60000);
  assert.equal((await h.provider.lookup('bob', 'https://twitter.com')).status, 'rate-limited');
  assert.equal(h.calls.length, 1);
  assert.ok(h.throttles.at(-1).cooldownUntil > 0);
  const restarted = setup();
  restarted.provider.restoreThrottle(h.throttles.at(-1));
  restarted.observe();
  assert.equal((await restarted.provider.lookup('alice', 'https://x.com')).status, 'rate-limited');
  assert.equal(restarted.calls.length, 0);
});

test('disabling aborts active fetch, resolves queued work and forgets auth', async () => {
  let signal;
  const h = setup((url, options) => new Promise((resolve, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }));
  h.observe();
  const pending = h.provider.lookup('alice', 'https://x.com');
  const queued = h.provider.lookup('bob', 'https://x.com');
  await new Promise(resolve => setImmediate(resolve));
  h.provider.configure({ enabled: false, autoLookup: true });
  assert.equal(signal.aborted, true);
  assert.equal((await pending).status, 'paused');
  assert.equal((await queued).status, 'paused');
  h.observe('ignored');
  assert.equal((await h.provider.lookup('alice', 'https://x.com')).status, 'paused');
  h.provider.configure(C.DEFAULT_SETTINGS);
  assert.equal((await h.provider.lookup('alice', 'https://x.com')).status, 'waiting');
  assert.equal(h.calls.length, 1);
});

test('bounded queue rejects floods and timeout aborts a stalled request', async () => {
  const h = setup((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }));
  h.observe();
  const tasks = Array.from({ length: 51 }, (_, index) => h.provider.lookup(`user${index}`, 'https://x.com'));
  assert.equal((await tasks[50]).status, 'rate-limited');
  await new Promise(resolve => setImmediate(resolve));
  const timeout = [...h.timeouts.values()][0];
  timeout();
  assert.equal((await tasks[0]).status, 'unavailable');
  h.provider.configure({ enabled: false });
  await Promise.all(tasks);
});

test('oversized response and malformed JSON are rejected without records', async () => {
  for (const response of [
    new Response('x'.repeat(P.MAX_BODY + 1)),
    new Response('{}', { headers: { 'content-length': String(P.MAX_BODY + 1) } }),
    new Response('not json'),
    Response.json(account('other'))
  ]) {
    const h = setup(() => response);
    h.observe();
    const result = await h.provider.lookup('alice', 'https://x.com');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.record, undefined);
  }
});

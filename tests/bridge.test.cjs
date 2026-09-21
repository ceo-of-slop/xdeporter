const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'main-bridge.js'), 'utf8');
const ORIGIN = 'https://x.com';
function environment(hostname = 'x.com') {
  let now = Date.now();
  class TestDate extends Date { static now() { return now; } }
  class XHR {
    constructor() { this.listeners = []; this.headers = {}; this.responseType = ''; this.status = 200; }
    open(method, url) { this.method = method; this.url = url; this.headers = {}; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    addEventListener(type, cb) { if (type === 'load') this.listeners.push(cb); }
    send() {}
    load(body) { this.responseText = JSON.stringify(body); const listeners = this.listeners.splice(0); for (const cb of listeners) cb(); }
    getResponseHeader() { return null; }
  }
  const calls = [], messages = [], listeners = [];
  let makeResponse = url => new Response(JSON.stringify(url.includes('/AboutAccountQuery') ? account('alice', 'Japan') : {}), { status: 200 });
  const window = {
    postMessage(data, origin) { assert.equal(origin, ORIGIN); messages.push(data); },
    addEventListener(type, cb) { if (type === 'message') listeners.push(cb); },
    fetch(...args) { calls.push(args); const url = typeof args[0] === 'string' ? args[0] : args[0].url; return Promise.resolve(makeResponse(url)); }
  };
  window.top = window;
  const context = vm.createContext({ window, location: { hostname, origin: ORIGIN }, document: { cookie: 'ct0=csrf-test' }, XMLHttpRequest: XHR,
    URL, Headers, Request, Response, TextDecoder, AbortController, Date: TestDate,
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout });
  vm.runInContext(source, context);
  return {
    window, calls, messages, XHR,
    hello() { for (const cb of listeners) cb({ source: window, origin: ORIGIN, data: { source: 'x-country-lens-content', type: 'HELLO' } }); },
    next() { now += 3000; },
    response(fn) { makeResponse = fn; },
    async auth(request = '/i/api/graphql/test/HomeTimeline') {
      await window.fetch(request, { headers: { authorization: 'Bearer bearer-test', 'x-csrf-token': 'csrf-test', 'unwanted-secret': 'do-not-forward' } });
      await tick();
    },
    async lookup(handle = 'alice', id = 'id', origin = ORIGIN) {
      for (const cb of listeners) cb({ source: window, origin, data: { source: 'x-country-lens-content', type: 'LOOKUP', requestId: id, handle } });
      await tick();
      return messages.findLast(m => m.type === 'RESULT' && m.requestId === id);
    },
  };
}
function account(handle, country) { return { data: { user_result_by_screen_name: { result: { core: { screen_name: handle }, about_profile: { account_based_in: country } } } } }; }
function tick() { return new Promise(resolve => setTimeout(resolve, 20)); }

test('bridge requires signed-in same-origin requests and rejects invalid lookup messages', async () => {
  const e = environment();
  assert.equal((await e.lookup()).status, 'unavailable');
  assert.equal(e.calls.length, 0);
  await e.auth('https://example.com/i/api/graphql/test/HomeTimeline');
  assert.equal((await e.lookup('alice', 'external')).status, 'unavailable');
  await e.auth();
  assert(e.messages.some(m => m.type === 'READY'));
  const beforeInvalid = e.calls.length;
  assert.equal(await e.lookup('../settings', 'invalid'), undefined);
  assert.equal(await e.lookup('alice', 'wrong-origin', 'https://evil.example'), undefined);
  assert.equal(e.calls.length, beforeInvalid);
});

test('bridge reads the account country using minimized headers without exposing credentials', async () => {
  const e = environment();
  await e.auth();
  assert.equal((await e.lookup('ALICE', 'valid')).country, 'Japan');
  const [requestUrl, requestInit] = e.calls.at(-1);
  assert(requestUrl.includes('/XRqGa7EeokUU5kppkh13EA/AboutAccountQuery'));
  assert.equal(JSON.parse(new URL(requestUrl).searchParams.get('variables')).screenName, 'alice');
  assert.equal(requestInit.credentials, 'include');
  assert.equal(requestInit.method, 'GET');
  assert.equal(requestInit.headers['unwanted-secret'], undefined);
  assert.equal(requestInit.headers.authorization, 'Bearer bearer-test');
  assert(!JSON.stringify(e.messages).includes('bearer-test'));
  assert(!JSON.stringify(e.messages).includes('csrf-test'));
});

test('bridge rejects mismatched accounts and distinguishes absent country from lookup errors', async () => {
  const e = environment();
  await e.auth();
  e.response(() => new Response(JSON.stringify(account('bob', 'France'))));
  assert.equal((await e.lookup('alice', 'mismatch')).status, 'unavailable');
  e.next();
  e.response(() => new Response(JSON.stringify(account('alice', null))));
  assert.equal((await e.lookup('alice', 'unknown')).status, 'unknown');
  e.next();
  e.response(() => new Response(JSON.stringify({ errors: [{ message: 'auth secret raw' }] })));
  assert.equal((await e.lookup('alice', 'graphql-error')).status, 'unavailable');
  assert(!JSON.stringify(e.messages).includes('auth secret raw'));
});

test('passive AboutAccount responses update the operation and feature template', async () => {
  const p = environment();
  await p.auth();
  await p.window.fetch('/i/api/graphql/newId/AboutAccountQuery?variables=%7B%22screenName%22%3A%22alice%22%7D&features=%7B%22example%22%3Atrue%7D', { headers: { authorization: 'Bearer bearer-test', 'x-csrf-token': 'csrf-test' } });
  await tick();
  assert(p.messages.some(m => m.type === 'RESULT' && !('requestId' in m) && m.country === 'Japan'));
  await p.lookup('alice', 'new-op');
  assert(p.calls.at(-1)[0].includes('/newId/AboutAccountQuery'));
  assert.equal(new URL(p.calls.at(-1)[0]).searchParams.get('features'), '{"example":true}');
});

test('rate-limited lookups honor the cooldown without sending repeated requests', async () => {
  const r = environment();
  await r.auth();
  r.response(() => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }));
  assert.equal((await r.lookup('alice', 'limited')).status, 'rate-limited');
  const afterRateLimit = r.calls.length;
  r.next();
  assert.equal((await r.lookup('alice', 'still-limited')).status, 'rate-limited');
  assert.equal(r.calls.length, afterRateLimit);
});

test('reused XHR instances do not associate a newer response with an older handle', () => {
  const x = environment();
  const xhr = new x.XHR();
  xhr.open('GET', '/i/api/graphql/newXhrId/AboutAccountQuery?variables=%7B%22screenName%22%3A%22alice%22%7D');
  xhr.setRequestHeader('Authorization', 'Bearer bearer-test');
  xhr.setRequestHeader('X-Csrf-Token', 'csrf-test');
  xhr.send();
  // Reopening after an aborted request must not report the newer response for alice.
  xhr.open('GET', '/i/api/graphql/newXhrId/AboutAccountQuery?variables=%7B%22screenName%22%3A%22bob%22%7D');
  xhr.setRequestHeader('Authorization', 'Bearer bearer-test');
  xhr.setRequestHeader('X-Csrf-Token', 'csrf-test');
  xhr.send();
  xhr.load(account('bob', 'Canada'));
  assert.equal(x.messages.filter(m => m.type === 'RESULT').length, 1);
  assert.equal(x.messages.find(m => m.type === 'RESULT').handle, 'bob');
});

test('Request and Headers inputs supply authentication and lookups request English country labels', async () => {
  const q = environment();
  await q.window.fetch(new Request(`${ORIGIN}/i/api/graphql/requestId/HomeTimeline`, { headers: new Headers({ authorization: 'Bearer request-token', 'x-csrf-token': 'csrf-test' }) }));
  assert.equal((await q.lookup('alice', 'request')).status, 'ok');
  assert.equal(q.calls.at(-1)[1].headers.authorization, 'Bearer request-token');
  assert.equal(q.calls.at(-1)[1].headers['x-twitter-client-language'], 'en');
});

test('www host and HELLO recover status messages missed before content initialization', async () => {
  const h = environment('www.x.com');
  h.messages.length = 0;
  h.hello();
  assert.equal(h.messages[0].state, 'waiting');
  await h.auth();
  h.messages.length = 0;
  h.next();
  h.hello();
  assert(h.messages.some(m => m.type === 'READY'));
});

test('changed observed features recover an unavailable endpoint even when its operation ID is unchanged', async () => {
  const h = environment();
  await h.auth();
  h.response(() => new Response('{}', { status: 404 }));
  assert.equal((await h.lookup('alice', 'old-endpoint')).status, 'unavailable');
  const priorLockedCalls = h.calls.length;
  h.next();
  assert.equal((await h.lookup('alice', 'locked')).status, 'unavailable');
  assert.equal(h.calls.length, priorLockedCalls);
  h.response(url => url.includes('features') ? new Response('{}', { status: 500 }) : new Response('{}'));
  await h.window.fetch('/i/api/graphql/XRqGa7EeokUU5kppkh13EA/AboutAccountQuery?variables=%7B%22screenName%22%3A%22alice%22%7D&features=%7B%22newFeature%22%3Atrue%7D');
  await tick();
  h.response(() => new Response(JSON.stringify(account('alice', 'Canada'))));
  assert.equal((await h.lookup('alice', 'feature-recovery')).status, 'ok');
});

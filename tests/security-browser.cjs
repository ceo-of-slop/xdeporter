/*
 * Real unpacked-extension security regression tests. Only dummy credentials are
 * used. Chromium resolves every allowed X host to an ephemeral localhost HTTPS
 * server; all other hostnames fail resolution. Real network traffic is required:
 * Playwright route.fulfill skips Chrome's onBeforeSendHeaders event.
 *
 * Requires Playwright Chromium and openssl (Git for Windows also supplies it).
 * This verifies extension isolation and request handling, not live X API access.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const extension = path.resolve(process.env.SECURITY_EXTENSION_DIR || path.join(__dirname, '../extension'));
const OPERATION = 'XRqGa7EeokUU5kppkh13EA';
const GOOD_AUTH = 'Bearer TEST_ONLY_VALID_SESSION';
const GOOD_CSRF = 'TEST_ONLY_VALID_CSRF';
const ALLOWED_HOSTS = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'];
const fixture = '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><main></main></body></html>';

async function eventually(predicate, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}

async function authors(page, handles) {
  await page.evaluate(handles => {
    document.querySelector('main').innerHTML = handles.map(handle => `<div data-testid="cellInnerDiv"><article data-testid="tweet" id="${handle}"><div data-testid="User-Name"><div><a href="/${handle}"><strong>${handle}</strong></a></div><a href="/${handle}">@${handle}</a><a href="/${handle}/status/1">1h</a></div><p>Offline fixture.</p></article></div>`).join('');
  }, handles);
}

async function observeSession(page, { authorization = GOOD_AUTH, csrf = GOOD_CSRF, status = 200, operation = 'HomeTimeline' } = {}) {
  return page.evaluate(async input => {
    const response = await fetch(`/i/api/graphql/OBSERVED_TEST/${input.operation}?status=${input.status}`, {
      headers: { authorization: input.authorization, 'x-csrf-token': input.csrf, 'x-twitter-active-user': 'yes', 'x-not-allowlisted': 'MUST_NOT_COPY' }
    });
    await response.text();
    return response.status;
  }, { authorization, csrf, status, operation });
}

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xdeporter-security-'));
  let server;
  let context;
  try {
    const openssl = process.env.OPENSSL_EXECUTABLE || (process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/usr/bin/openssl.exe') ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(temporary, 'key.pem'), '-out', path.join(temporary, 'cert.pem'), '-days', '1', '-subj', '/CN=x.com'], { stdio: 'ignore' });
    const requests = [];
    const destinations = [];
    const locations = new Map([['alice', 'United States'], ['bob', 'India'], ['carol', 'Canada'], ['dave', 'Germany']]);
    const responseModes = new Map();
    server = https.createServer({ key: fs.readFileSync(path.join(temporary, 'key.pem')), cert: fs.readFileSync(path.join(temporary, 'cert.pem')) }, (req, res) => {
      const url = new URL(req.url, `https://${req.headers.host}`);
      destinations.push(url.pathname);
      assert.ok(ALLOWED_HOSTS.includes(url.hostname), 'Unexpected destination reached local test server');
      res.setHeader('Cache-Control', 'no-store');
      if (!url.pathname.startsWith('/i/api/graphql/')) {
        res.setHeader('Set-Cookie', 'auth_token=TEST_ONLY_HTTPONLY; Path=/; Secure; HttpOnly; SameSite=Strict');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(fixture);
      }
      const handle = JSON.parse(url.searchParams.get('variables') || '{}').screenName;
      requests.push({ path: url.pathname, handle, headers: { ...req.headers }, at: Date.now() });
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = Number(url.searchParams.get('status')) || 200;
      if (!url.pathname.endsWith('/AboutAccountQuery') || !handle) return res.end('{}');
      if (!req.headers.cookie?.includes('auth_token=TEST_ONLY_HTTPONLY')) { res.statusCode = 403; return res.end('{}'); }
      const mode = responseModes.get(handle);
      const user = { core: { screen_name: mode === 'wrong-handle' ? 'someone_else' : handle }, about_profile: { account_based_in: locations.get(handle) || 'Canada' } };
      if (mode === 'missing-handle') delete user.core;
      if (mode === 'bidi') user.about_profile.account_based_in = 'United\u202EStates';
      if (mode === 'redirect') {
        res.statusCode = 302;
        res.setHeader('Location', 'https://x.com/redirect-target');
        return res.end();
      }
      const respond = () => res.end(JSON.stringify({ data: { user_result_by_screen_name: { result: user } } }));
      if (mode === 'slow') return setTimeout(respond, 800);
      respond();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const rules = ALLOWED_HOSTS.map(host => `MAP ${host} 127.0.0.1:${server.address().port}`).concat('MAP * ~NOTFOUND').join(',');
    fs.mkdirSync(path.join(temporary, 'profile', 'Default'), { recursive: true });
    // Chromium's CookieControlsMode::kBlockThirdParty is 1. The fixture requires
    // an HttpOnly SameSite=Strict cookie so header-only success is insufficient.
    fs.writeFileSync(path.join(temporary, 'profile', 'Default', 'Preferences'), JSON.stringify({ profile: { cookie_controls_mode: 1, block_third_party_cookies: true } }));
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
      headless: true,
      ignoreHTTPSErrors: true,
      ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : { channel: 'chromium' }),
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--host-resolver-rules=${rules}`, '--no-proxy-server', '--ignore-certificate-errors', '--disable-background-networking']
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const stored = () => worker.evaluate(() => chrome.storage.local.get(null));
    const settings = async patch => {
      await worker.evaluate(async patch => {
        const { settings } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...settings, ...patch } });
      }, patch);
      await delay(75);
    };
    await eventually(async () => (await stored()).cacheVersion === 2, 'extension initialization');
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    assert.ok(manifest.content_scripts.every(script => script.world !== 'MAIN'), 'No MAIN-world code may be injected');
    const page = await context.newPage();
    await page.goto('https://x.com/home');
    assert.equal(await page.evaluate(() => document.cookie.includes('auth_token')), false, 'Fixture auth cookie must be HttpOnly');

    // A page cannot submit country records, provider states, or lookup requests.
    const beforeForgery = await stored();
    const beforeForgeryRequests = requests.length;
    await page.evaluate(async () => {
      await new Promise(resolve => {
        const sentinel = 'security-test-postmessage-drained';
        const listener = event => { if (event.data === sentinel) { window.removeEventListener('message', listener); resolve(); } };
        window.addEventListener('message', listener);
        for (let i = 0; i < 10000; i++) {
          const variant = i % 4;
          window.postMessage(variant === 0 ? { source: 'x-country-lens-page', type: 'RESULT', handle: 'alice', status: 'ok', country: 'Russia' } : variant === 1 ? { source: 'x-country-lens-page', type: 'STATUS', state: 'ready', message: 'forged' } : variant === 2 ? { source: 'x-country-lens-page', type: 'READY' } : { source: 'x-country-lens-content', type: 'LOOKUP', handle: 'alice', requestId: i }, location.origin);
        }
        window.postMessage(sentinel, location.origin);
      });
    });
    await delay(250);
    const afterForgery = await stored();
    assert.deepEqual(afterForgery.countryCache, beforeForgery.countryCache, 'Page messages must not alter cached countries');
    assert.deepEqual(afterForgery.providerStatus, beforeForgery.providerStatus, 'Page messages must not alter provider state');
    assert.equal(requests.length, beforeForgeryRequests, 'Forged lookups must not trigger requests');
    console.log('PASS security: 10,000 forged page messages cannot write cache/status or trigger network requests');

    // The real request-header observer captures only successful scoped requests.
    await observeSession(page);
    await authors(page, ['alice', 'bob']);
    await eventually(async () => (await stored()).countryCache?.bob?.location?.label === 'India', 'real observer and background lookups');
    await page.waitForFunction(() => document.querySelector('#alice .xcl-badge')?.textContent === 'United States');
    await settings({ mode: 'block', countries: ['IN'] });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#bob').parentElement).display === 'none');
    assert.equal(await page.locator('#alice').isVisible(), true);
    const initialLookups = requests.filter(request => request.handle);
    assert.equal(initialLookups.length, 2);
    for (const request of initialLookups) {
      assert.equal(request.path, `/i/api/graphql/${OPERATION}/AboutAccountQuery`);
      assert.equal(request.headers.authorization, GOOD_AUTH);
      assert.equal(request.headers['x-csrf-token'], GOOD_CSRF);
      assert.equal(request.headers['x-not-allowlisted'], undefined);
      assert.match(request.headers.cookie || '', /auth_token=TEST_ONLY_HTTPONLY/);
    }
    console.log('PASS security: real webRequest observation, allowlisted headers, background requests, labels and filtering');

    // Rejected requests cannot replace a working session or operation template.
    await observeSession(page, { authorization: 'Bearer TEST_ONLY_REJECTED', csrf: 'TEST_ONLY_REJECTED', status: 403, operation: 'AboutAccountQuery' });
    await authors(page, ['carol']);
    await eventually(async () => (await stored()).countryCache?.carol?.location?.label === 'Canada', 'working session survives rejected observation');
    const carol = requests.find(request => request.handle === 'carol');
    assert.equal(carol.headers.authorization, GOOD_AUTH);
    assert.equal(carol.headers['x-csrf-token'], GOOD_CSRF);
    assert.equal(carol.path, `/i/api/graphql/${OPERATION}/AboutAccountQuery`);
    console.log('PASS security: failed auth/template observations cannot poison working state');

    // Page realm changes must not affect the isolated script or service worker.
    await page.evaluate(() => {
      window.securityHooks = [];
      const hook = name => { window.securityHooks.push(name); throw new Error(`Page hook ${name} must not be used by the extension`); };
      Reflect.apply = () => hook('Reflect.apply');
      window.URL = class { constructor() { hook('URL'); } };
      window.Headers = class { constructor() { hook('Headers'); } };
      Date.now = () => hook('Date.now');
      window.fetch = () => hook('fetch');
    });
    await authors(page, ['dave']);
    await eventually(async () => (await stored()).countryCache?.dave?.location?.label === 'Germany', 'lookup with hostile page globals');
    assert.deepEqual(await page.evaluate(() => window.securityHooks), []);
    assert.equal(requests.find(request => request.handle === 'dave').headers.authorization, GOOD_AUTH);
    console.log('PASS security: hostile page globals cannot access authentication or redirect extension requests');
    await page.close();

    // Master-off clears the session and ignores fresh headers until re-enabled.
    const cleanPage = await context.newPage();
    await cleanPage.goto('https://x.com/home');
    responseModes.set('cancelpending', 'slow');
    await authors(cleanPage, ['cancelpending']);
    await eventually(() => requests.some(request => request.handle === 'cancelpending'), 'in-flight request before disabling');
    await settings({ enabled: false });
    await delay(850);
    assert.equal((await stored()).countryCache?.cancelpending, undefined, 'Disabling must cancel in-flight requests before cache writes');
    await observeSession(cleanPage, { authorization: 'Bearer TEST_ONLY_DISABLED', csrf: 'TEST_ONLY_DISABLED' });
    const beforeDisabledLookups = requests.filter(request => request.handle).length;
    await authors(cleanPage, ['disableduser']);
    await delay(500);
    assert.equal(requests.filter(request => request.handle).length, beforeDisabledLookups);
    assert.equal(await cleanPage.locator('.xcl-badge').count(), 0);
    await settings({ enabled: true });
    await delay(500);
    assert.equal(requests.filter(request => request.handle).length, beforeDisabledLookups, 'Re-enabling must require a fresh successful session request');
    await observeSession(cleanPage);
    await eventually(async () => (await stored()).countryCache?.disableduser?.location?.label === 'Canada', 'lookup after re-enabled fresh session');
    assert.equal(requests.find(request => request.handle === 'disableduser').headers.authorization, GOOD_AUTH);
    console.log('PASS security: master-off stops capture/lookups, clears credentials, and requires fresh auth on resume');

    // Two active tabs share a single deduplicating, paced queue.
    const second = await context.newPage();
    await second.goto('https://x.com/home');
    responseModes.set('shareduser', 'slow');
    await Promise.all([authors(cleanPage, ['shareduser', 'firstonly']), authors(second, ['shareduser', 'secondonly'])]);
    await eventually(async () => {
      const cache = (await stored()).countryCache || {};
      return cache.shareduser && cache.firstonly && cache.secondonly;
    }, 'shared multi-tab lookup queue', 20000);
    assert.equal(requests.filter(request => request.handle === 'shareduser').length, 1, 'Concurrent tabs must deduplicate the same author');
    const allLookups = requests.filter(request => request.handle);
    for (let i = 1; i < allLookups.length; i++) assert.ok(allLookups[i].at - allLookups[i - 1].at >= 1900, 'All tabs must share the two-second minimum interval');
    await second.close();
    console.log('PASS security: requests are deduplicated and paced globally across tabs');

    // Identity is mandatory, and display controls cannot be smuggled in labels.
    responseModes.set('missingcore', 'missing-handle');
    responseModes.set('mismatch', 'wrong-handle');
    responseModes.set('bidilabel', 'bidi');
    const malformedPages = [cleanPage, await context.newPage(), await context.newPage()];
    await Promise.all(malformedPages.slice(1).map(page => page.goto('https://x.com/home')));
    await Promise.all(malformedPages.map((page, i) => authors(page, [['missingcore'], ['mismatch'], ['bidilabel']][i])));
    await eventually(() => ['missingcore', 'mismatch', 'bidilabel'].every(handle => requests.some(request => request.handle === handle)), 'reject malformed account results', 20000);
    await delay(250);
    const rejectedCache = (await stored()).countryCache || {};
    for (const handle of ['missingcore', 'mismatch', 'bidilabel']) assert.equal(rejectedCache[handle], undefined, `Invalid ${handle} response must never enter cache`);
    const persistent = JSON.stringify(await stored());
    const session = JSON.stringify(await worker.evaluate(() => chrome.storage.session.get(null)));
    for (const secret of [GOOD_AUTH, GOOD_CSRF, 'TEST_ONLY_REJECTED', 'TEST_ONLY_DISABLED']) {
      assert.ok(!persistent.includes(secret), 'No authentication values in local storage');
      assert.ok(!session.includes(secret), 'No authentication values in session storage');
    }
    console.log('PASS security: exact response identity, safe labels, and no credentials in extension storage');
    const redirectPage = await context.newPage();
    await redirectPage.goto('https://x.com/home');
    responseModes.set('redirectuser', 'redirect');
    await authors(redirectPage, ['redirectuser']);
    await eventually(() => requests.some(request => request.handle === 'redirectuser'), 'redirect response');
    await delay(250);
    assert.equal(destinations.includes('/redirect-target'), false, 'Authenticated lookup redirects must never be followed');
    assert.equal((await stored()).countryCache?.redirectuser, undefined);
    console.log('PASS security: disabling aborts in-flight requests and authenticated redirects are rejected');
    await context.close();
    context = null;
    const savedPreferences = JSON.parse(fs.readFileSync(path.join(temporary, 'profile', 'Default', 'Preferences'), 'utf8'));
    assert.equal(savedPreferences.profile.cookie_controls_mode, 1, 'Third-party-cookie blocking must remain enabled during the test');
    console.log(`PASS loaded-extension security suite (${manifest.name} ${manifest.version}); all HTTP traffic used localhost fixtures`);
  } finally {
    if (context) await context.close();
    if (server) await new Promise(resolve => server.close(resolve));
    // Delete only the temporary directory created by this test.
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('xdeporter-security-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

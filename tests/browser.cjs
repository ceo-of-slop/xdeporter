/* Offline browser integration tests: every x.com request is intercepted locally. */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const ext = path.join(root, 'extension');
const artifactDir = process.env.TEST_ARTIFACT_DIR || path.join(root, '../../work/artifacts');
fs.mkdirSync(artifactDir, { recursive: true });
const fixture = `<!doctype html><html><head><style>body{font:15px system-ui;margin:0;background:#fff;color:#111}main{width:600px;margin:0 auto}article{padding:18px;border-bottom:1px solid #eee;min-height:105px}[data-testid=User-Name]{display:flex;gap:5px}a{color:inherit;text-decoration:none}</style></head><body><main><h1>Offline timeline fixture</h1>${['alice','bob','carol'].map(handle => `<div data-testid="cellInnerDiv"><article data-testid="tweet" id="${handle}"><div data-testid="User-Name"><div><a href="/${handle}"><strong>${handle}</strong></a></div><a href="/${handle}">@${handle}</a><a href="/${handle}/status/1">1h</a></div><p>Example post by ${handle}.</p></article></div>`).join('')}</main></body></html>`;

async function mockChrome(page, initial) {
  await page.evaluate(initial => {
    const listeners = [];
    const store = structuredClone({ cacheVersion: 2, ...initial });
    const change = async patch => {
      const changes = {};
      for (const [key, newValue] of Object.entries(patch)) { changes[key] = { oldValue: store[key], newValue }; store[key] = structuredClone(newValue); }
      listeners.forEach(listener => listener(changes, 'local'));
    };
    window.testRequests = [];
    window.testStore = store;
    window.setTestStorage = change;
    window.chrome = {
      storage: {
        local: { get: async () => structuredClone(store), set: change },
        onChanged: { addListener: listener => listeners.push(listener) }
      },
      runtime: { sendMessage: async message => {
        if (message.type === 'CLEAR_CACHE') await change({ countryCache: {} });
        if (message.type === 'LOOKUP') {
          testRequests.push({ ...message, at: Date.now() });
          if (!window.lookupEnabled) return { status: 'waiting', retryAfter: 1000 };
          if (window.failAlice && message.handle === 'alice') {
            await change({ providerStatus: { state: 'unavailable', message: 'Fixture error' } });
            return { status: 'unavailable', retryAfter: 60000 };
          }
          const record = { location: XCountryCore.normalizeLocation('Canada'), checkedAt: Date.now(), source: 'x-about-account' };
          await change({ countryCache: { ...store.countryCache, [message.handle]: record } });
          return { status: 'ok', record };
        }
        return { ok: true };
      } }
    };
  }, initial);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await page.goto('https://x.com/home');
    const C = require('../extension/core.js');
    await mockChrome(page, { settings: C.DEFAULT_SETTINGS, countryCache: {
      alice: { location: C.normalizeLocation('United States'), checkedAt: Date.now() },
      bob: { location: C.normalizeLocation('India'), checkedAt: Date.now() },
      carol: { location: null, checkedAt: Date.now() }
    } });
    await page.addStyleTag({ path: path.join(ext, 'content.css') });
    await page.addScriptTag({ path: path.join(ext, 'core.js') });
    await page.addScriptTag({ path: path.join(ext, 'content.js') });
    await page.waitForFunction(() => document.querySelectorAll('.xcl-badge').length === 3);
    assert.equal(await page.locator('#alice .xcl-badge').textContent(), 'United States');
    assert.equal(await page.locator('#carol .xcl-badge').textContent(), 'Unknown');
    assert.equal(await page.evaluate(() => {
      const name = document.querySelector('#alice strong').getBoundingClientRect();
      const handle = document.querySelector('#alice [data-testid="User-Name"] > a').getBoundingClientRect();
      const badge = document.querySelector('#alice .xcl-badge').getBoundingClientRect();
      return handle.top < name.bottom && badge.top >= name.bottom - 1 && !document.querySelector('#alice .xcl-handle-row');
    }), true, 'Inline timeline name and handle must stay on the same row');
    await page.evaluate(() => setTestStorage({ settings: { ...testStore.settings, mode: 'block', countries: ['IN'] } }));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#bob').parentElement).display === 'none');
    assert.equal(await page.locator('#alice').isVisible(), true);
    assert.equal(await page.locator('#carol').isVisible(), true);
    await page.evaluate(() => setTestStorage({ settings: { ...testStore.settings, mode: 'allow', countries: ['IN'], hideUnknown: true } }));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#alice').parentElement).display === 'none');
    assert.equal(await page.locator('#bob').isVisible(), true);
    assert.equal(await page.locator('#carol').isVisible(), false);
    await page.evaluate(() => setTestStorage({ settings: { ...testStore.settings, enabled: false } }));
    await page.waitForFunction(() => document.querySelectorAll('.xcl-filtered,.xcl-badge').length === 0);
    assert.equal(await page.locator('#carol').isVisible(), true);
    await page.evaluate(() => setTestStorage({ settings: { ...testStore.settings, enabled: true, mode: 'block', countries: ['IN'], hideUnknown: false } }));
    await page.waitForFunction(() => document.querySelectorAll('.xcl-badge').length === 3);
    // X reuses a post element, changing its author's links in place.
    await page.evaluate(() => document.querySelectorAll('#alice a:not(.xcl-badge)').forEach(a => a.href = a.getAttribute('href').replace('alice', 'bob')));
    await page.waitForFunction(() => document.querySelector('#alice .xcl-badge').textContent === 'India');
    assert.equal(await page.locator('#alice').isVisible(), false);
    await page.evaluate(() => setTestStorage({ settings: { ...testStore.settings, mode: 'off' } }));
    await page.waitForFunction(() => document.querySelectorAll('.xcl-filtered').length === 0);
    // Reset fixture author for the development screenshot.
    await page.evaluate(() => document.querySelectorAll('#alice a:not(.xcl-badge)').forEach(a => a.href = a.getAttribute('href').replace('bob', 'alice')));
    await page.waitForFunction(() => document.querySelector('#alice .xcl-badge').textContent === 'United States');
    await page.screenshot({ path: path.join(artifactDir, 'timeline.png') });
    // Pending accounts are hidden before a lookup; confirmed unknown is a separate preference.
    await page.evaluate(() => {
      const countryCache = { ...testStore.countryCache }; delete countryCache.alice;
      setTestStorage({ countryCache, settings: { ...testStore.settings, mode: 'block', countries: ['US'], autoLookup: false, hidePending: true } });
    });
    await page.waitForFunction(() => document.querySelector('#alice .xcl-badge')?.textContent === 'Unknown' && getComputedStyle(document.querySelector('#alice').parentElement).display === 'none');
    assert.equal(await page.locator('#carol').isVisible(), true);
    await page.evaluate(() => setTestStorage({ settings: { ...testStore.settings, mode: 'off', autoLookup: true } }));
    // UI test uses a mocked private runtime; security-browser.cjs loads the real extension.
    await page.evaluate(() => {
      window.testRequests = [];
      window.lookupEnabled = true;
      setTestStorage({ countryCache: {} });
    });
    await page.waitForFunction(() => document.querySelectorAll('.xcl-badge').length === 3 && [...document.querySelectorAll('.xcl-badge')].every(el => el.textContent === 'Canada'), { timeout: 15000 });
    const requests = await page.evaluate(() => testRequests);
    assert.equal(new Set(requests.map(item => item.handle)).size, 3);
    for (let i = 1; i < requests.length; i++) assert.ok(requests[i].at - requests[i - 1].at >= 2000);
    // An offscreen unresolved post must still resolve after hideUnknown removes it.
    await page.evaluate(() => {
      const spacer = document.createElement('div'); spacer.style.height = '4000px'; document.querySelector('main').append(spacer);
      const cell = document.querySelector('#carol').parentElement.cloneNode(true);
      cell.querySelector('article').id = 'dave';
      cell.querySelector('.xcl-badge').remove();
      cell.querySelectorAll('a').forEach(a => a.href = a.getAttribute('href').replace('carol', 'dave'));
      document.querySelector('main').append(cell);
    });
    await page.waitForFunction(() => document.querySelector('#dave .xcl-badge')?.textContent === 'Unknown');
    await page.evaluate(() => setTestStorage({ settings: { ...testStore.settings, mode: 'block', hideUnknown: true } }));
    await page.waitForFunction(() => document.querySelector('#dave .xcl-badge')?.textContent === 'Canada');
    // A failed first author must not starve later authors after the global pause.
    await page.evaluate(() => {
      window.failAlice = true;
      window.testRequests = [];
      const cache = { ...testStore.countryCache }; delete cache.alice; delete cache.bob;
      setTestStorage({ countryCache: cache });
    });
    await page.waitForFunction(() => testRequests.some(r => r.handle === 'alice'));
    await page.waitForFunction(() => testStore.providerStatus.state === 'unavailable');
    await page.evaluate(() => { const originalNow = Date.now; Date.now = () => originalNow() + 61000; });
    await page.waitForFunction(() => document.querySelector('#bob .xcl-badge')?.textContent === 'Canada');
    assert.equal(await page.evaluate(() => testRequests.filter(r => r.handle === 'alice').length), 1);
    assert.deepEqual(errors, []);
    console.log('PASS timeline: badges, block/allow/unknown filters, restore, recycled DOM, lookup spacing');
    await page.close();

    const detail = await browser.newPage({ viewport: { width: 700, height: 500 } });
    detail.on('pageerror', error => errors.push(error.message));
    const detailFixture = '<!doctype html><html><head><style>body{font:15px/20px system-ui;background:#000;color:#e7e9ea;margin:24px}article{max-width:550px;padding:16px;border:1px solid #333}a{color:inherit;text-decoration:none}[data-testid="User-Name"]{display:flex;flex-direction:column;gap:0}.name-row,.handle-row{display:flex}.handle-row{color:#71767b}@media(min-width:900px){[data-testid="User-Name"]{flex-direction:row;gap:8px}}</style></head><body><article data-testid="tweet" id="detail"><div data-testid="User-Name"><div class="name-row"><div><a href="/alice"><strong>Alice</strong></a></div></div><div class="handle-row"><div><a href="/alice">@alice</a></div></div></div><p>A detailed post with the country between the name and handle.</p></article></body></html>';
    await detail.route('**/*', route => route.fulfill({ contentType: 'text/html', body: detailFixture }));
    await detail.goto('https://x.com/alice/status/1');
    await mockChrome(detail, { settings: C.DEFAULT_SETTINGS, countryCache: {
      alice: { location: C.normalizeLocation('United States'), checkedAt: Date.now() },
      bob: { location: C.normalizeLocation('India'), checkedAt: Date.now() }
    } });
    await detail.addStyleTag({ path: path.join(ext, 'content.css') });
    await detail.addScriptTag({ path: path.join(ext, 'core.js') });
    await detail.addScriptTag({ path: path.join(ext, 'content.js') });
    const stackedWithoutOverlap = () => {
      const name = document.querySelector('.name-row a')?.getBoundingClientRect();
      const country = document.querySelector('#detail .xcl-badge')?.getBoundingClientRect();
      const handle = document.querySelector('.handle-row a')?.getBoundingClientRect();
      return name && country && handle && country.top >= name.bottom - 1 && handle.top >= country.bottom && country.height === 12;
    };
    await detail.waitForFunction(stackedWithoutOverlap);
    assert.equal(await detail.locator('.handle-row').evaluate(node => node.classList.contains('xcl-handle-row')), true);
    await detail.locator('#detail').screenshot({ path: path.join(artifactDir, 'tweet-detail-v0.1.5.png') });
    // Header measurement must settle instead of repeatedly toggling spacing.
    await detail.waitForTimeout(200);
    await detail.evaluate(() => {
      window.layoutMutations = 0;
      new MutationObserver(records => { window.layoutMutations += records.length; }).observe(document.querySelector('[data-testid="User-Name"]'), { attributes: true, attributeFilter: ['class'], subtree: true });
    });
    await detail.waitForTimeout(350);
    assert.equal(await detail.evaluate(() => window.layoutMutations), 0, 'Stacked spacing must not create an observer loop');
    await detail.setViewportSize({ width: 1100, height: 500 });
    await detail.waitForFunction(() => {
      const name = document.querySelector('.name-row a').getBoundingClientRect();
      const handle = document.querySelector('.handle-row a').getBoundingClientRect();
      return handle.top < name.bottom && !document.querySelector('.xcl-handle-row,.xcl-header-stacked');
    });
    await detail.setViewportSize({ width: 700, height: 500 });
    await detail.waitForFunction(stackedWithoutOverlap);
    await detail.evaluate(() => setTestStorage({ settings: { ...testStore.settings, enabled: false } }));
    await detail.waitForFunction(() => !document.querySelector('.xcl-badge,.xcl-handle-row,.xcl-header-stacked'));
    await detail.evaluate(() => setTestStorage({ settings: { ...testStore.settings, enabled: true } }));
    await detail.waitForFunction(stackedWithoutOverlap);
    // Recycled header nodes must lose our spacing; the replacement stays inline.
    await detail.evaluate(() => {
      window.recycledHandleRow = document.querySelector('.handle-row');
      const header = document.querySelector('[data-testid="User-Name"]');
      header.style.flexDirection = 'row';
      header.innerHTML = '<div class="name-row"><a href="/bob"><strong>Bob</strong></a></div><a href="/bob">@bob</a>';
    });
    await detail.waitForFunction(() => document.querySelector('#detail .xcl-badge')?.textContent === 'India' && !document.querySelector('.xcl-handle-row,.xcl-header-stacked'));
    assert.equal(await detail.evaluate(() => recycledHandleRow.classList.contains('xcl-handle-row')), false);
    assert.equal(await detail.locator('.xcl-badge').count(), 1);
    assert.deepEqual(errors, []);
    console.log('PASS tweet detail: name/country/handle ordering, no overlap, responsive layout, cleanup and no observer loop');
    await detail.close();

    const popup = await browser.newPage({ viewport: { width: 420, height: 780 } });
    popup.on('pageerror', error => errors.push(error.message));
    // Load packaged HTML/CSS/scripts on a local intercepted test origin.
    await popup.route('**/*', route => {
      const name = new URL(route.request().url()).pathname.replace(/^\/+/, '') || 'popup.html';
      const file = path.join(ext, name);
      if (name === 'empty') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' });
      if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
      const contentType = name.endsWith('.png') ? 'image/png' : name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'application/javascript' : 'text/html';
      return route.fulfill({ contentType: contentType + '; charset=utf-8', body: fs.readFileSync(file) });
    });
    await popup.goto('https://extension.test/empty');
    await mockChrome(popup, { settings: C.DEFAULT_SETTINGS, countryCache: {} });
    // document.write keeps the mocked chrome API while executing the real deferred scripts.
    await popup.evaluate(html => { document.open(); document.write(html); document.close(); }, fs.readFileSync(path.join(ext, 'popup.html'), 'utf8'));
    await popup.waitForFunction(() => !document.querySelector('#controls').disabled);
    await popup.locator('#countrySearch').fill('United States');
    await popup.locator('#countryList input[value="US"]').check();
    await popup.locator('input[name="mode"][value="allow"]').check();
    await popup.waitForFunction(() => testStore.settings.mode === 'allow' && testStore.settings.countries.includes('US'));
    await popup.locator('#hideUnknown').check();
    await popup.waitForFunction(() => testStore.settings.hideUnknown === true);
    await popup.locator('#hidePending').uncheck();
    await popup.waitForFunction(() => testStore.settings.hidePending === false);
    await popup.locator('#countrySearch').fill('');
    assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await popup.locator('body').screenshot({ path: path.join(artifactDir, 'popup.png') });
    await popup.locator('#clearSelection').click();
    await popup.waitForFunction(() => testStore.settings.countries.length === 0);
    assert.match(await popup.locator('#modeDescription').textContent(), /all known locations will be hidden/);
    assert.deepEqual(errors, []);
    console.log('PASS popup: persisted controls, country selection, allow empty state, no horizontal overflow');
    await popup.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

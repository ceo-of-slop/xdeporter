'use strict';
importScripts('core.js', 'provider.js');
const C = XCountryCore;
const P = XCountryProvider;
const CACHE_VERSION = 2;
let serial = Promise.resolve();
let settings = C.normalizeSettings({ enabled: false });
let countryCache = Object.create(null);
let settingsRevision = 0;
let observersAttached = false;
let statusSerial = Promise.resolve();

const provider = P.createProvider({ core: C,
  persistThrottle: value => chrome.storage.session.set({ providerThrottle: value }),
  onStatus(value) {
    statusSerial = statusSerial.catch(() => {}).then(() => chrome.storage.local.set({ providerStatus: value }));
  }
});

const filter = { urls: P.MATCHES, types: ['xmlhttprequest'] };
const observeHeaders = details => provider.beforeRequest(details);
const observeCompleted = details => provider.completed(details);
const observeDiscarded = details => provider.discarded(details);
function attachObservers() {
  if (observersAttached) return;
  // Non-blocking browser events. Cookies and all unlisted headers are ignored.
  chrome.webRequest.onBeforeSendHeaders.addListener(observeHeaders, filter, ['requestHeaders']);
  chrome.webRequest.onCompleted.addListener(observeCompleted, filter);
  chrome.webRequest.onErrorOccurred.addListener(observeDiscarded, filter);
  chrome.webRequest.onBeforeRedirect.addListener(observeDiscarded, filter);
  observersAttached = true;
}
function detachObservers() {
  if (!observersAttached) return;
  chrome.webRequest.onBeforeSendHeaders.removeListener(observeHeaders);
  chrome.webRequest.onCompleted.removeListener(observeCompleted);
  chrome.webRequest.onErrorOccurred.removeListener(observeDiscarded);
  chrome.webRequest.onBeforeRedirect.removeListener(observeDiscarded);
  observersAttached = false;
}
function applySettings(value) {
  settings = C.normalizeSettings(value);
  provider.configure(settings);
  if (provider.isActive()) attachObservers(); else detachObservers();
}

// Register synchronously so Chrome can wake a suspended worker for network events.
// The provider ignores these events until settings have loaded; disabled settings
// remove the listeners and never retain observed authentication state.
attachObservers();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) {
    settingsRevision++;
    applySettings(changes.settings.newValue);
  }
  if (changes.countryCache) countryCache = C.normalizeCache(changes.countryCache.newValue);
});

const ready = (async () => {
  const revision = settingsRevision;
  const [saved, session] = await Promise.all([
    chrome.storage.local.get(['settings', 'countryCache', 'cacheVersion']),
    chrome.storage.session.get('providerThrottle')
  ]);
  provider.restoreThrottle(session.providerThrottle);
  // Older versions accepted page-originated cache writes. Never carry them forward.
  countryCache = saved.cacheVersion === CACHE_VERSION ? C.normalizeCache(saved.countryCache) : Object.create(null);
  await chrome.storage.local.set({ cacheVersion: CACHE_VERSION, countryCache });
  if (revision === settingsRevision) applySettings(saved.settings);
})().catch(() => {
  applySettings({ enabled: false });
  throw new Error('Extension storage is unavailable.');
});
// Avoid an unhandled startup rejection; requests still receive the explicit error.
void ready.catch(() => {});

function fromX(sender) {
  if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || sender.tab.id < 0 ||
      (sender.documentLifecycle && sender.documentLifecycle !== 'active')) return null;
  const origin = P.originOf(sender.url);
  return origin && P.originOf(sender.tab.url) === origin ? origin : null;
}
function fromPopup(sender) {
  return sender?.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html') && !sender.tab;
}
function enqueueWrite(action) {
  serial = serial.catch(() => {}).then(action);
  return serial;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message !== 'object') return;
  const origin = fromX(sender);
  const popup = fromPopup(sender);
  if (message.type === 'CLEAR_CACHE' && popup) {
    void ready.then(() => enqueueWrite(async () => {
      await chrome.storage.local.set({ countryCache: {} });
      countryCache = Object.create(null);
      return { ok: true };
    })).then(respond, () => respond({ ok: false, error: 'Local storage could not be updated.' }));
    return true;
  }
  // No CACHE_RECORD, PROVIDER_STATUS, URLs, headers, or page-provided results.
  if (message.type !== 'LOOKUP' || !origin) return;
  const handle = C.normalizeHandle(message.handle);
  if (!handle) { respond({ status: 'unavailable', message: 'Invalid account handle.' }); return; }
  void ready.then(async () => {
    if (!provider.isActive()) return { status: 'paused', message: 'Account lookups are paused.' };
    const record = C.normalizeRecord(countryCache[handle]);
    if (record) return { status: record.location ? 'ok' : 'unknown', record };
    const revision = settingsRevision;
    const result = await provider.lookup(handle, origin);
    if (!result.record) return result;
    return enqueueWrite(async () => {
      if (!provider.isActive() || revision !== settingsRevision) return { status: 'paused', message: 'Account lookup settings changed.' };
      const verified = C.normalizeRecord(result.record);
      if (!verified) return { status: 'unavailable', message: 'X returned an invalid account record.' };
      const previous = C.normalizeRecord(countryCache[handle]);
      if (previous && previous.checkedAt >= verified.checkedAt) {
        return { status: previous.location ? 'ok' : 'unknown', record: previous };
      }
      const entries = Object.entries(C.normalizeCache(countryCache)).filter(([key]) => key !== handle);
      entries.unshift([handle, verified]);
      entries.sort((a, b) => b[1].checkedAt - a[1].checkedAt);
      const cache = Object.fromEntries(entries.slice(0, 5000));
      await chrome.storage.local.set({ countryCache: cache });
      countryCache = cache;
      return { status: verified.location ? 'ok' : 'unknown', record: verified };
    });
  }).then(respond, () => respond({ status: 'unavailable', message: 'Local storage could not be updated.' }));
  return true;
});

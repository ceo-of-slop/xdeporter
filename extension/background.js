'use strict';
importScripts('core.js');
const C = XCountryCore;
let serial = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  serial = serial.then(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: C.normalizeSettings(settings) });
  }).catch(() => {});
});

function fromX(sender) {
  try { const url = new URL(sender.url); return url.protocol === 'https:' && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname); } catch { return false; }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const fromPopup = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
  if (!message || (!fromX(sender) && !fromPopup)) return;
  if (!['CACHE_RECORD', 'CLEAR_CACHE', 'PROVIDER_STATUS'].includes(message.type)) return;
  if (message.type === 'CLEAR_CACHE' && !fromPopup) return;
  serial = serial.catch(() => {}).then(async () => {
    if (message.type === 'CLEAR_CACHE') {
      await chrome.storage.local.set({ countryCache: {} });
      return { ok: true };
    }
    if (message.type === 'PROVIDER_STATUS') {
      const allowed = ['ready', 'waiting', 'unavailable', 'rate-limited', 'paused'];
      if (!allowed.includes(message.state)) return { ok: false };
      await chrome.storage.local.set({ providerStatus: { state: message.state, message: String(message.message || '').slice(0, 220), updatedAt: Date.now() } });
      return { ok: true };
    }
    const handle = C.normalizeHandle(message.handle);
    if (!handle || !['ok', 'unknown'].includes(message.status)) return { ok: false };
    const location = C.normalizeLocation(message.country);
    if (message.status === 'ok' && !location) return { ok: false };
    const { countryCache = {} } = await chrome.storage.local.get('countryCache');
    const cache = Object.assign(Object.create(null), countryCache);
    cache[handle] = { location, checkedAt: Date.now(), source: 'x-about-account' };
    const entries = Object.entries(cache).filter(([, record]) => C.isFresh(record)).sort((a, b) => b[1].checkedAt - a[1].checkedAt).slice(0, 5000);
    await chrome.storage.local.set({ countryCache: Object.fromEntries(entries) });
    return { ok: true };
  });
  serial.then(respond, () => respond({ ok: false, error: 'Local storage could not be updated.' }));
  return true;
});

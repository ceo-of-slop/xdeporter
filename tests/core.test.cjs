const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../extension/core.js');

test('country aliases normalize to stable country keys', () => {
  for (const name of ['United States', 'United States of America', 'USA', 'us']) assert.equal(C.normalizeLocation(name).key, 'US');
  assert.equal(C.normalizeLocation('UK').key, 'GB');
  assert.equal(C.normalizeLocation(' South Korea ').key, 'KR');
});
test('region labels stay regions, and unknown labels are never mapped by substring', () => {
  assert.equal(C.normalizeLocation('South Asia').kind, 'region');
  assert.equal(C.normalizeLocation('Eastern Europe (Non-EU)').code, null);
  assert.equal(C.normalizeLocation('near India').code, null);
  assert.equal(C.normalizeLocation('Africa').key, 'region:africa');
});
test('invalid and absent country values remain unknown', () => {
  for (const value of [null, undefined, '', 'Unknown', 'N/A', '<script>', 42, {}, 'x'.repeat(101)]) assert.equal(C.normalizeLocation(value), null);
});
test('block, allow, disabled, labels-only and unknown filtering are explicit', () => {
  const us = C.normalizeLocation('United States');
  const gb = C.normalizeLocation('United Kingdom');
  const block = { ...C.DEFAULT_SETTINGS, countries: ['US'] };
  assert.equal(C.shouldHide(us, block), true);
  assert.equal(C.shouldHide(gb, block), false);
  assert.equal(C.shouldHide(null, block), false);
  assert.equal(C.shouldHide(null, { ...block, hideUnknown: true }), true);
  assert.equal(C.shouldHide(us, { ...block, enabled: false }), false);
  assert.equal(C.shouldHide(us, { ...block, mode: 'off' }), false);
  assert.equal(C.shouldHide(us, { ...block, mode: 'allow' }), false);
  assert.equal(C.shouldHide(gb, { ...block, mode: 'allow' }), true);
  assert.equal(C.shouldHide(us, { mode: 'allow', countries: [] }), true);
  assert.equal(C.shouldHide(C.normalizeLocation('South Asia'), { mode: 'block', countries: ['IN'] }), false);
});
test('country caches expire and reject future or invalid timestamps', () => {
  const now = Date.now();
  assert.equal(C.isFresh({ location: C.normalizeLocation('US'), checkedAt: now - C.KNOWN_TTL + 1 }, now), true);
  assert.equal(C.isFresh({ location: C.normalizeLocation('US'), checkedAt: now - C.KNOWN_TTL }, now), false);
  assert.equal(C.isFresh({ location: null, checkedAt: now - C.UNKNOWN_TTL }, now), false);
  assert.equal(C.isFresh({ location: null, checkedAt: now + 1 }, now), false);
});
test('settings and usernames reject malformed input', () => {
  assert.equal(C.normalizeHandle('Some_Name'), 'some_name');
  assert.equal(C.normalizeHandle('../home'), null);
  assert.equal(C.normalizeHandle('a'.repeat(16)), null);
  assert.equal(C.normalizeSettings({ mode: 'oops' }).mode, 'block');
  assert.deepEqual(C.normalizeSettings({ countries: ['US', 'US', null, '<evil>'] }).countries, ['US']);
});

test('pending posts stay hidden until lookup when filtering, separately from confirmed unknowns', () => {
  const block = { ...C.DEFAULT_SETTINGS, countries: ['US'] };
  assert.equal(C.shouldHide(null, block, true), true);
  assert.equal(C.shouldHide(null, block, false), false);
  assert.equal(C.shouldHide(null, { ...block, hidePending: false }, true), false);
  assert.equal(C.shouldHide(null, { ...block, mode: 'off' }, true), false);
  assert.equal(C.shouldHide(null, { ...block, enabled: false }, true), false);
  assert.equal(C.shouldHide(null, C.DEFAULT_SETTINGS, true), false);
  assert.equal(C.shouldHide(null, { mode: 'allow' }, true), true);
});

test('cache normalization rejects malformed records and ignores injected keys and country keys', () => {
  const now = Date.now();
  const cache = C.normalizeCache(JSON.parse(JSON.stringify({
    alice: { location: { label: 'United States', key: 'IN', kind: 'region' }, checkedAt: now },
    bob: { location: { label: 'Canada\u202e' }, checkedAt: now },
    carol: { checkedAt: now },
    dave: { location: null, checkedAt: now + 1000 },
    erin: { location: null, checkedAt: now },
    '../evil': { location: null, checkedAt: now }
  })), now);
  assert.deepEqual(Object.keys(cache), ['alice', 'erin']);
  assert.equal(cache.alice.location.key, 'US');
  assert.equal(Object.getPrototypeOf(cache), null);
  assert.equal(C.normalizeLocation('Canada\u200b'), null);
  assert.equal(C.normalizeSettings({ countries: ['region:Canada\u202e'] }).countries.length, 0);
});

/* Shared, dependency-free country normalization and filtering. */
(function (root) {
  'use strict';
  const DEFAULT_SETTINGS = Object.freeze({ enabled: true, mode: 'block', countries: [], hideUnknown: false, autoLookup: true });
  const COUNTRY_CODES = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' ');
  const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
  const countries = COUNTRY_CODES.map(code => ({ key: code, code, label: displayNames.of(code), kind: 'country' }));
  const regionNames = ['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania', 'Antarctica', 'European Union', 'Eastern Europe (Non-EU)', 'Central Asia', 'East Asia', 'South Asia', 'Southeast Asia', 'Western Asia', 'Middle East', 'Northern Africa', 'Sub-Saharan Africa', 'Central America', 'Caribbean'];
  const folded = value => value.trim().normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
  const regions = regionNames.map(label => ({ key: 'region:' + folded(label), label, code: null, kind: 'region' }));
  const COUNTRY_OPTIONS = [...countries, ...regions].sort((a, b) => a.label.localeCompare(b.label));
  const lookup = new Map();
  for (const item of COUNTRY_OPTIONS) {
    lookup.set(folded(item.label), item);
    if (item.code) lookup.set(item.code.toLowerCase(), item);
  }
  const aliases = { 'united states of america': 'US', 'usa': 'US', 'u.s.': 'US', 'uk': 'GB', 'great britain': 'GB', 'united kingdom': 'GB', 'south korea': 'KR', 'republic of korea': 'KR', 'north korea': 'KP', 'russian federation': 'RU', 'russia': 'RU', 'turkey': 'TR', 'vietnam': 'VN', 'czech republic': 'CZ', 'iran': 'IR', 'syria': 'SY', 'taiwan': 'TW', 'bolivia': 'BO', 'venezuela': 'VE', 'tanzania': 'TZ', 'moldova': 'MD', 'laos': 'LA', 'ivory coast': 'CI', 'palestine': 'PS', 'swaziland': 'SZ', 'cape verde': 'CV', 'brunei': 'BN', 'the netherlands': 'NL', 'hong kong': 'HK', 'macau': 'MO' };
  for (const [alias, code] of Object.entries(aliases)) lookup.set(alias, countries.find(item => item.code === code));
  function normalizeLocation(value) {
    if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f\u007f<>]/.test(value)) return null;
    const label = value.trim().replace(/\s+/g, ' ');
    const key = folded(label);
    if (!key || ['unknown', 'unavailable', 'not available', 'not disclosed', 'n/a', 'none', 'null'].includes(key)) return null;
    if (lookup.has(key)) return { ...lookup.get(key) };
    // Preserve an unfamiliar X label without inferring a country from it.
    return { key: 'region:' + key, label, code: null, kind: 'region' };
  }
  function normalizeHandle(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_]{1,15}$/.test(value) ? value.toLowerCase() : null;
  }
  function normalizeSettings(value) {
    const input = value && typeof value === 'object' ? value : {};
    return {
      enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
      mode: ['off', 'block', 'allow'].includes(input.mode) ? input.mode : 'block',
      countries: [...new Set(Array.isArray(input.countries) ? input.countries.filter(key => typeof key === 'string' && (/^[A-Z]{2}$/.test(key) || /^region:[^<>\u0000-\u001f]{1,100}$/.test(key))) : [])].slice(0, 400),
      hideUnknown: input.hideUnknown === true,
      autoLookup: input.autoLookup !== false
    };
  }
  function shouldHide(location, settings) {
    const config = normalizeSettings(settings);
    if (!config.enabled || config.mode === 'off') return false;
    if (!location) return config.hideUnknown;
    const selected = config.countries.includes(location.key);
    // An empty allow list has no permitted known countries, as the UI explains.
    return config.mode === 'allow' ? !selected : selected;
  }
  const KNOWN_TTL = 24 * 60 * 60 * 1000;
  const UNKNOWN_TTL = 60 * 60 * 1000;
  function isFresh(record, now = Date.now()) {
    return !!record && Number.isFinite(record.checkedAt) && record.checkedAt <= now && now - record.checkedAt < (record.location ? KNOWN_TTL : UNKNOWN_TTL);
  }
  const api = { DEFAULT_SETTINGS, COUNTRY_OPTIONS, normalizeLocation, normalizeHandle, normalizeSettings, shouldHide, isFresh, KNOWN_TTL, UNKNOWN_TTL };
  root.XCountryCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);

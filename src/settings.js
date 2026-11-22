'use strict';

/**
 * Widget settings: defaults and validation. Pure module (no Electron) so it is
 * unit-testable. sanitizeSettings() returns ONLY the valid, changed keys - the
 * caller persists those and ignores everything else.
 */

// Which meters each provider can show. Kept in step with the provider modules (a test checks it).
const PROVIDER_METERS = Object.freeze({
  claude: ['fiveHour', 'weekly'],
  chatgpt: ['fiveHour', 'weekly'],
  muse: ['weekly'],
  gemini: ['fiveHour', 'weekly'],
});
const PROVIDER_IDS = Object.keys(PROVIDER_METERS);

// show = always visible, auto = visible once usage reaches autoShowPercent, hide = never.
const METER_MODES = ['show', 'auto', 'hide'];

function defaultProvider(id) {
  const cfg = { enabled: false, palette: 'default' }; // palette 'default' = the tool's own default colour (DEFAULT_PALETTE)
  for (const meter of PROVIDER_METERS[id]) cfg[meter] = 'show';
  return cfg;
}

function defaultProviders() {
  const out = {};
  for (const id of PROVIDER_IDS) out[id] = defaultProvider(id);
  return out;
}

const DEFAULTS = Object.freeze({
  pollSeconds: 300, // 5 min; 15s-5min selectable in Settings
  warnPercent: 75,
  dangerPercent: 90,
  autoShowPercent: 75, // weekly meters set to "show when high" appear at this level, and a weekly meter takes over the tray number
  theme: 'system',
  timeFormat: '12h',
  alwaysOnTop: false,
  startWithWindows: false,
  compactMode: false,
  trayProvider: 'highest', // 'highest' = highest visible meter of any provider, or a provider id
  providers: defaultProviders(),
  providerOrder: PROVIDER_IDS.slice(), // display order of the AI tools (cards, settings, tray tooltip)
});

// Any stored/proposed order -> a full, duplicate-free list of known ids (unknown dropped, missing appended).
function normalizeOrder(order) {
  const seen = [];
  for (const id of Array.isArray(order) ? order : []) {
    if (PROVIDER_IDS.includes(id) && !seen.includes(id)) seen.push(id);
  }
  for (const id of PROVIDER_IDS) if (!seen.includes(id)) seen.push(id);
  return seen;
}

const POLL_CHOICES_SECONDS = [15, 30, 60, 120, 300];
const THEMES = ['system', 'light', 'dark'];
const PALETTES = ['violet', 'ocean', 'teal', 'forest', 'rose', 'orange', 'graphite'];
const PROVIDER_PALETTES = ['default', ...PALETTES]; // per tool: a colour, or 'default' (shown as "Auto") = the tool's own default
// What "Auto" means for each tool. Each has a light and a dark variant (styles.css).
const DEFAULT_PALETTE = Object.freeze({ claude: 'orange', chatgpt: 'forest', muse: 'ocean', gemini: 'graphite' });
const TIME_FORMATS = ['12h', '24h'];
const BOOLEAN_KEYS = ['alwaysOnTop', 'startWithWindows', 'compactMode'];
const WARN_MIN = 10;
const DANGER_MAX = 99;
const AUTO_SHOW_MIN = 10;
const AUTO_SHOW_MAX = 99;

function toInt(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

// A provider with a single meter (Muse) has nothing to "auto-show": that meter is the card.
const isSingleMeter = (id) => PROVIDER_METERS[id].length === 1;

// Which modes a meter offers. "Hide" is not one of them: untick the tool to hide it.
//   weekly (on tools that also have a 5-hour meter) = Always show | Show when high; everything else = always shown.
function allowedModes(id, meter) {
  return meter === 'weekly' && !isSingleMeter(id) ? ['show', 'auto'] : ['show'];
}

// Any proposed/saved mode -> one the meter allows. A saved "hide" becomes "auto" where that exists (closest intent).
function coerceMode(id, meter, mode) {
  const allowed = allowedModes(id, meter);
  if (allowed.includes(mode)) return mode;
  return mode === 'hide' && allowed.includes('auto') ? 'auto' : 'show';
}

// Merge a partial provider config into the current one; unknown keys and bad values are ignored.
function mergeProvider(id, partial, current) {
  const next = { ...defaultProvider(id), ...(current || {}) };
  if (partial && typeof partial === 'object') {
    if (typeof partial.enabled === 'boolean') next.enabled = partial.enabled;
    if (typeof partial.palette === 'string' && PROVIDER_PALETTES.includes(partial.palette)) next.palette = partial.palette;
    for (const meter of PROVIDER_METERS[id]) {
      if (METER_MODES.includes(partial[meter])) next[meter] = partial[meter];
    }
  }
  if (!PROVIDER_PALETTES.includes(next.palette)) next.palette = 'default'; // repairs saved values
  for (const meter of PROVIDER_METERS[id]) next[meter] = coerceMode(id, meter, next[meter]); // also repairs saved values
  return next;
}

function sameProvider(a, b) {
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
}

function sanitizeSettings(partial, current) {
  const out = {};
  if (!partial || typeof partial !== 'object') return out;

  if ('pollSeconds' in partial) {
    const n = toInt(partial.pollSeconds);
    if (POLL_CHOICES_SECONDS.includes(n) && n !== current.pollSeconds) out.pollSeconds = n;
  }
  if ('theme' in partial && THEMES.includes(partial.theme) && partial.theme !== current.theme) {
    out.theme = partial.theme;
  }
  if ('timeFormat' in partial && TIME_FORMATS.includes(partial.timeFormat) && partial.timeFormat !== current.timeFormat) {
    out.timeFormat = partial.timeFormat;
  }
  for (const key of BOOLEAN_KEYS) {
    if (key in partial && typeof partial[key] === 'boolean' && partial[key] !== current[key]) {
      out[key] = partial[key];
    }
  }
  if ('trayProvider' in partial) {
    const v = partial.trayProvider;
    if ((v === 'highest' || PROVIDER_IDS.includes(v)) && v !== current.trayProvider) out.trayProvider = v;
  }
  if ('providerOrder' in partial && Array.isArray(partial.providerOrder)) {
    const next = normalizeOrder(partial.providerOrder);
    if (next.join() !== normalizeOrder(current.providerOrder).join()) out.providerOrder = next;
  }
  if ('autoShowPercent' in partial) {
    const n = toInt(partial.autoShowPercent);
    if (n !== null && n >= AUTO_SHOW_MIN && n <= AUTO_SHOW_MAX && n !== current.autoShowPercent) out.autoShowPercent = n;
  }

  // Thresholds: whole percents with warn strictly below danger. Both are checked
  // together; if the pair is invalid, neither change is applied.
  if ('warnPercent' in partial || 'dangerPercent' in partial) {
    const warn = 'warnPercent' in partial ? toInt(partial.warnPercent) : current.warnPercent;
    const danger = 'dangerPercent' in partial ? toInt(partial.dangerPercent) : current.dangerPercent;
    if (warn !== null && danger !== null && warn >= WARN_MIN && danger <= DANGER_MAX && warn < danger) {
      if (warn !== current.warnPercent) out.warnPercent = warn;
      if (danger !== current.dangerPercent) out.dangerPercent = danger;
    }
  }

  // Providers: { claude: { enabled, fiveHour, weekly }, ... }. Returns the whole merged object when anything changed.
  if (partial.providers && typeof partial.providers === 'object') {
    const merged = { ...defaultProviders(), ...(current.providers || {}) };
    let changed = false;
    for (const id of PROVIDER_IDS) {
      if (!(id in partial.providers)) continue;
      const next = mergeProvider(id, partial.providers[id], merged[id]);
      if (!sameProvider(next, merged[id])) {
        merged[id] = next;
        changed = true;
      }
    }
    if (changed) out.providers = merged;
  }
  return out;
}

module.exports = {
  DEFAULTS, PROVIDER_METERS, PROVIDER_IDS, METER_MODES, POLL_CHOICES_SECONDS, PALETTES, DEFAULT_PALETTE, sanitizeSettings, normalizeOrder, mergeProvider, isSingleMeter, allowedModes,
};

'use strict';

/**
 * Turns a provider definition + its raw session state + the user's settings into the
 * view the UI and tray render. Pure (no Electron) so it is unit-testable.
 */

const { allowedModes, DEFAULT_PALETTE } = require('./settings');

// show: always. auto: only once usage reaches the threshold. hide: never.
function meterVisible(mode, percent, autoShowPercent) {
  if (mode === 'hide') return false;
  if (mode === 'auto') return typeof percent === 'number' && percent >= autoShowPercent;
  return true;
}

// provider: { id, name, meterDefs: [{ id, label }] }
// raw: { auth, reading: { plan, meters: { [meterId]: { percent, resetsAtMs } } } | null, lastGoodAt, error, stale, busy }
function buildProviderView(provider, raw, providerSettings, autoShowPercent) {
  const meters = provider.meterDefs.map((def) => {
    const m = raw.reading && raw.reading.meters ? raw.reading.meters[def.id] : null;
    const percent = m && typeof m.percent === 'number' ? m.percent : null;
    const mode = (providerSettings && providerSettings[def.id]) || 'show';
    return {
      id: def.id,
      label: def.label,
      percent,
      resetsAtMs: m ? m.resetsAtMs ?? null : null,
      mode,
      modes: allowedModes(provider.id, def.id), // what the settings UI may offer for this meter
      hasData: percent !== null,
      visible: meterVisible(mode, percent, autoShowPercent),
    };
  });
  const chosenPalette = (providerSettings && providerSettings.palette) || 'default';
  return {
    id: provider.id,
    name: provider.name,
    external: Boolean(provider.external),
    enabled: Boolean(providerSettings && providerSettings.enabled),
    palette: chosenPalette, // what the user picked; 'default' = Auto
    effectivePalette: chosenPalette === 'default' ? DEFAULT_PALETTE[provider.id] || 'violet' : chosenPalette, // what the card uses
    auth: raw.auth,
    plan: raw.reading ? raw.reading.plan || null : null,
    hasReading: Boolean(raw.reading),
    lastGoodAt: raw.lastGoodAt || null,
    error: raw.error || null,
    stale: Boolean(raw.stale),
    misses: Number(raw.misses) || 0, // consecutive failed polls
    busy: Boolean(raw.busy),
    meters,
  };
}

module.exports = { meterVisible, buildProviderView };

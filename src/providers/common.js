'use strict';

// Shared helpers for provider parsers. Pure, no Electron.

const MS_THRESHOLD = 1e12; // below this a number is Unix seconds, above it milliseconds

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= MS_THRESHOLD ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function clampPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

// One normalized meter: { percent: 0..100, resetsAtMs: number | null }, or null when there is no usable percent.
function makeMeter(percentRaw, resetsRaw) {
  const percent = clampPercent(percentRaw);
  if (percent === null) return null;
  return { percent, resetsAtMs: toMs(resetsRaw) };
}

module.exports = { toMs, clampPercent, makeMeter };

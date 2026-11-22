'use strict';

const { makeMeter } = require('./common');

/**
 * Gemini: Google blocks sign-in inside embedded browsers, so there is no window here. A small Chrome
 * extension (extensions/gemini) reads gemini.google.com/usage in the user's own Chrome and reports the
 * two meters to the widget's local bridge (src/bridge.js). This module only validates that report.
 */

const KNOWN_PLANS = ['Free']; // paid labels get added once their wording is verified on a paid account

// Pure: a bridge report -> { plan, meters } | { error } | null (unusable).
//   report: { ok: true, usage: { fiveHour: { percent, resetsAtMs }|null, weekly: {...}|null } }
//        or { ok: false, reason: 'signed-out' | 'no-meters-found' }
function readingFromReport(report) {
  if (!report || typeof report !== 'object') return null;
  if (report.ok === false) {
    if (report.reason === 'signed-out') return { error: 'Sign in to Gemini in Chrome' };
    return { error: 'Gemini usage page not recognised' };
  }
  const usage = report.usage;
  if (report.ok !== true || !usage || typeof usage !== 'object') return null;
  const meters = {};
  for (const id of ['fiveHour', 'weekly']) {
    const m = usage[id];
    const meter = m && typeof m === 'object' ? makeMeter(m.percent, m.resetsAtMs) : null;
    if (meter) meters[id] = meter;
  }
  const plan = KNOWN_PLANS.includes(usage.plan) ? usage.plan : null; // only labels we know, never free text
  return Object.keys(meters).length ? { plan, meters } : null;
}

module.exports = {
  id: 'gemini',
  name: 'Gemini',
  external: true, // fed by the Chrome companion; no window, no sign-in flow
  meterDefs: [
    { id: 'fiveHour', label: '5-hour' },
    { id: 'weekly', label: 'Weekly' },
  ],
  readingFromReport,
};

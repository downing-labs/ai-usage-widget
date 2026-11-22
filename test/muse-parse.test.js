'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUsage } = require('../src/providers/muse-parse');

// Shape captured from muse.ai (Settings > General, free plan), 2026-11-19.
const SAMPLE = [
  '0:{"a":"$@1","q":"","i":false}',
  '1:{"success":true,"subscription":{"subscriptionType":"FREE","tier":{"tierId":"hatch_free","name":"Muse Free","tierCode":"HATCH_FREE","isPaid":false,"rank":0},"usage":{"state":"METERED","percentUsed":50,"resetsAt":1795272931,"quotaStatus":"SUFFICIENT"},"statusSubtitle":"Weekly limit resets on Nov 21","usageRowLabel":"Free plan","usageRowValueLabel":"50% used","topupBalance":0}}',
  '',
].join('\n');

test('parses percentUsed and reset time from a flight response', () => {
  const u = parseUsage(SAMPLE);
  assert.equal(u.percentUsed, 50);
  assert.equal(u.resetsAtMs, 1795272931 * 1000);
  assert.equal(u.state, 'METERED');
  assert.equal(u.quotaStatus, 'SUFFICIENT');
  assert.equal(u.tierName, 'Muse Free');
  assert.equal(u.isPaid, false);
  assert.equal(u.statusSubtitle, 'Weekly limit resets on Nov 21');
});

test('tolerates resetsAt already in milliseconds', () => {
  const ms = SAMPLE.replace('1795272931', '1795272931000');
  assert.equal(parseUsage(ms).resetsAtMs, 1795272931000);
});

test('returns null when there is no usage payload', () => {
  assert.equal(parseUsage('0:{"a":"$@1","q":"","i":false}\n'), null);
  assert.equal(parseUsage(''), null);
  assert.equal(parseUsage(null), null);
});

test('returns null for malformed JSON mentioning percentUsed', () => {
  assert.equal(parseUsage('1:{"percentUsed": 50'), null);
});

test('ignores a non-numeric percentUsed', () => {
  const bad = '1:{"subscription":{"usage":{"percentUsed":"50"}}}';
  assert.equal(parseUsage(bad), null);
});

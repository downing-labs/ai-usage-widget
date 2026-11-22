'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseGeminiUsage, parseReset } = require('../extensions/gemini/parse');

const PAGE = `Gemini
Usage limits

Your plan's limits determine how much you can use Gemini over time.

Updated just now

Current usage
info
0% used
Resets at 3:54 PM
Weekly limit
Resets Nov 24 at 8:54 AM
7% used
Get 2x more usage with AI Plus`;

const NOW = new Date(2026, 10, 22, 11, 35); // Nov 22 2026, 11:35 local

test('parseGeminiUsage reads both meters from the real page text', () => {
  const u = parseGeminiUsage(PAGE, NOW);
  assert.strictEqual(u.fiveHour.percent, 0);
  assert.strictEqual(u.weekly.percent, 7);
  assert.strictEqual(u.fiveHour.resetsAtMs, new Date(2026, 10, 22, 15, 54).getTime());
  assert.strictEqual(u.weekly.resetsAtMs, new Date(2026, 10, 24, 8, 54).getTime());
});

test('plan: the AI Plus upsell means Free; no upsell means unknown (not guessed)', () => {
  assert.strictEqual(parseGeminiUsage(PAGE, NOW).plan, 'Free');
  const noBanner = PAGE.replace('Get 2x more usage with AI Plus', '');
  assert.strictEqual(parseGeminiUsage(noBanner, NOW).plan, null);
  assert.strictEqual(parseGeminiUsage(PAGE.replace('AI Plus', 'AI Ultra'), NOW).plan, null);
});

test('parseReset: a clock time already passed today means tomorrow; a past date rolls to next year', () => {
  assert.strictEqual(parseReset('Resets at 9:00 AM', NOW), new Date(2026, 10, 23, 9, 0).getTime());
  assert.strictEqual(parseReset('Resets Jan 3 at 8:00 AM', NOW), new Date(2027, 0, 3, 8, 0).getTime());
  assert.strictEqual(parseReset('nothing here', NOW), null);
});

test('parseGeminiUsage returns null for unrelated or missing text, and handles one meter only', () => {
  assert.strictEqual(parseGeminiUsage('Sign in to continue', NOW), null);
  assert.strictEqual(parseGeminiUsage(null, NOW), null);
  const one = parseGeminiUsage('Usage limits\nCurrent usage\n12% used\nResets at 1:00 PM', NOW);
  assert.strictEqual(one.fiveHour.percent, 12);
  assert.strictEqual(one.weekly, null);
});

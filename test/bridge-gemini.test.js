'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { authorize } = require('../src/bridge');
const gemini = require('../src/providers/gemini');
const { ExternalSession } = require('../src/session-external');

const TOKEN = 'tok-1234567890abcdefgh';
const good = { host: '127.0.0.1:47831', authorization: 'Bearer ' + TOKEN, origin: 'chrome-extension://abcdef' };

test('bridge authorize: accepts the extension with the right token', () => {
  assert.deepStrictEqual(authorize(good, TOKEN), { ok: true });
  assert.deepStrictEqual(authorize({ ...good, origin: undefined }, TOKEN), { ok: true }); // non-browser clients send no Origin
  assert.deepStrictEqual(authorize({ ...good, host: 'localhost:47831' }, TOKEN), { ok: true });
});

test('bridge authorize: rejects web pages, wrong hosts, and missing or wrong tokens', () => {
  assert.strictEqual(authorize({ ...good, origin: 'https://evil.example' }, TOKEN).status, 403);
  assert.strictEqual(authorize({ ...good, host: 'evil.example:47831' }, TOKEN).status, 403);
  assert.strictEqual(authorize({ ...good, authorization: 'Bearer nope' }, TOKEN).status, 401);
  assert.strictEqual(authorize({ ...good, authorization: undefined }, TOKEN).status, 401);
  assert.strictEqual(authorize(good, '').status, 401);
});

test('gemini readingFromReport: valid report, partial report, bad reports, companion errors', () => {
  const ok = gemini.readingFromReport({ ok: true, usage: { fiveHour: { percent: 0, resetsAtMs: 1795388040000 }, weekly: { percent: 7, resetsAtMs: 1795535640000 } } });
  assert.strictEqual(ok.meters.fiveHour.percent, 0);
  assert.strictEqual(ok.meters.weekly.resetsAtMs, 1795535640000);
  assert.deepStrictEqual(Object.keys(gemini.readingFromReport({ ok: true, usage: { fiveHour: null, weekly: { percent: 40 } } }).meters), ['weekly']);
  assert.strictEqual(gemini.readingFromReport({ ok: true, usage: { fiveHour: { percent: 'x' } } }), null);
  assert.strictEqual(gemini.readingFromReport({ ok: true, usage: { plan: 'Free', weekly: { percent: 1 } } }).plan, 'Free');
  assert.strictEqual(gemini.readingFromReport({ ok: true, usage: { plan: '<b>x</b>', weekly: { percent: 1 } } }).plan, null);
  assert.strictEqual(gemini.readingFromReport('junk'), null);
  assert.match(gemini.readingFromReport({ ok: false, reason: 'signed-out' }).error, /Sign in/);
});

test('ExternalSession: waits, accepts a reading, counts silent periods', () => {
  const kv = new Map();
  const store = { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v), delete: (k) => kv.delete(k) };
  const s = new ExternalSession(gemini, { store, onChange() {} });
  s.enable();
  assert.strictEqual(s.raw().auth, 'waiting');
  s.accept({ plan: null, meters: { weekly: { percent: 7, resetsAtMs: null } } });
  assert.strictEqual(s.raw().auth, 'signed-in');
  assert.strictEqual(s.raw().misses, 0);
  s.lastGoodAt = Date.now() - 20 * 60 * 1000; // 20 min of silence = 3 missed 5-min periods after slack
  assert.strictEqual(s.raw().misses, 3);
  s.disable();
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractActionId } = require('../src/providers/muse-discover');

// Snippets in the shape found in muse.ai's client bundles (2026-11-19).
const USAGE_REF =
  'createServerReference)("40e0249eeae158685b6a8d0c3b203f53dd4f2c7d63",t.callServer,void 0,t.findSourceMapURL,"fetchSubscriptionAction");e.s(["f",0,n])';
const OTHER_REF =
  'createServerReference)("40076d65709b71539d10a9f0f52656ee03877e4d17",t.callServer,void 0,t.findSourceMapURL,"updateUserPreferencesAction");e.s(["f",0,n])';

test('finds the action id for a named server action', () => {
  assert.equal(
    extractActionId(USAGE_REF, 'fetchSubscriptionAction'),
    '40e0249eeae158685b6a8d0c3b203f53dd4f2c7d63'
  );
});

test('picks the right id when several actions are present', () => {
  const text = `${OTHER_REF};var x=1;${USAGE_REF}`;
  assert.equal(
    extractActionId(text, 'fetchSubscriptionAction'),
    '40e0249eeae158685b6a8d0c3b203f53dd4f2c7d63'
  );
  assert.equal(
    extractActionId(text, 'updateUserPreferencesAction'),
    '40076d65709b71539d10a9f0f52656ee03877e4d17'
  );
});

test('never borrows the name of a neighbouring reference', () => {
  assert.equal(extractActionId(OTHER_REF, 'fetchSubscriptionAction'), null);
});

test('returns null when absent or input is not text', () => {
  assert.equal(extractActionId('nothing here', 'fetchSubscriptionAction'), null);
  assert.equal(extractActionId(undefined, 'fetchSubscriptionAction'), null);
});

test('tolerates names with regex-special characters', () => {
  assert.equal(extractActionId(USAGE_REF, 'a.b$(c)'), null);
});

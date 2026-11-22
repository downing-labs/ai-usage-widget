'use strict';

// The registry. Adding a provider (e.g. Gemini later) = one new module + one line here + its entry in settings.js.
const ALL = [require('./claude'), require('./chatgpt'), require('./muse'), require('./gemini')];

const byId = (id) => ALL.find((p) => p.id === id) || null;

module.exports = { ALL, byId };

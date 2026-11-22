'use strict';

const { makeMeter } = require('./common');

/**
 * ChatGPT: the same endpoint the Codex tooling reads, called from inside the signed-in
 * chatgpt.com page with the session's own bearer token.
 *   GET /api/auth/session            -> { accessToken }
 *   GET /backend-api/wham/usage      -> { plan_type, rate_limit: { primary_window, secondary_window } }
 */

const FIVE_HOUR_MAX_SECONDS = 6 * 3600; // windows up to 6h count as the "5-hour" meter
const WEEKLY_MIN_SECONDS = 6 * 86400; // windows of 6+ days count as the weekly meter

// Windows are classified by their length, not by primary/secondary, so a plan that only
// has one of them still lands on the right meter.
function classifyWindow(win) {
  const seconds = win && win.limit_window_seconds;
  if (typeof seconds !== 'number') return null;
  if (seconds <= FIVE_HOUR_MAX_SECONDS) return 'fiveHour';
  if (seconds >= WEEKLY_MIN_SECONDS) return 'weekly';
  return null;
}

// Pure: usage JSON -> { plan, meters } or null when the payload is not an object.
// A plan with no windows (e.g. free) is valid: plan is set and meters is empty.
function parseChatGptUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const rl = usage.rate_limit && typeof usage.rate_limit === 'object' ? usage.rate_limit : {};
  const meters = {};
  for (const win of [rl.primary_window, rl.secondary_window]) {
    const id = classifyWindow(win);
    if (!id || meters[id]) continue;
    const meter = makeMeter(win.used_percent, win.reset_at);
    if (meter) meters[id] = meter;
  }
  return { plan: typeof usage.plan_type === 'string' ? usage.plan_type : null, meters };
}

const PROBE = `(async () => {
  const s = await fetch('/api/auth/session', { credentials: 'include' }).then((r) => r.json()).catch(() => null);
  if (!s || !s.accessToken) return { state: 'signed-out' };
  const r = await fetch('/backend-api/wham/usage', {
    credentials: 'include',
    headers: { Authorization: 'Bearer ' + s.accessToken },
  });
  if (r.status === 401) return { state: 'signed-out' };
  if (!r.ok) return { state: 'error', reason: 'usage HTTP ' + r.status };
  return { state: 'ok', usage: await r.json() };
})()`;

async function read(ctx) {
  const res = await ctx.run(PROBE);
  if (res.state !== 'ok') return res;
  const parsed = parseChatGptUsage(res.usage);
  return parsed ? { state: 'ok', ...parsed } : { state: 'error', reason: 'unrecognised usage response' };
}

module.exports = {
  id: 'chatgpt',
  name: 'ChatGPT',
  host: 'chatgpt.com',
  startUrl: 'https://chatgpt.com/',
  signInUrl: 'https://chatgpt.com/auth/login',
  partition: 'persist:aiw-chatgpt',
  signInCookie: 'session-token',
  popupHosts: ['chatgpt.com', 'openai.com', 'apple.com', 'microsoftonline.com', 'live.com'],
  meterDefs: [
    { id: 'fiveHour', label: '5-hour' },
    { id: 'weekly', label: 'Weekly' },
  ],
  read,
  parseChatGptUsage,
  classifyWindow,
};

'use strict';

const { parseUsage } = require('./muse-parse');
const { actionIdPattern } = require('./muse-discover');

/**
 * Muse: usage comes from a Next.js server action (POST /, text/x-component). The action id is
 * found by scanning the page's JS bundles, replayed from inside the signed-in page, and the
 * working request is remembered for next time.
 */

const START_URL = 'https://muse.ai/';
const USAGE_ACTION_NAME = 'fetchSubscriptionAction';
const DEFAULT_USAGE_BODY = '[{"includeAgreement":true}]';
const DISCOVERY_CONCURRENCY = 6;
const DISCOVERY_MIN_INTERVAL_MS = 5 * 60 * 1000;

// Pure: Muse's normalized usage -> { plan, meters }.
function toReading(usage) {
  return {
    plan: usage.tierName || null,
    meters: { weekly: { percent: Math.max(0, Math.min(100, usage.percentUsed)), resetsAtMs: usage.resetsAtMs } },
  };
}

async function replay(ctx, action) {
  const script = `(async () => {
    const r = await fetch(${JSON.stringify(action.url)}, {
      method: 'POST',
      headers: ${JSON.stringify(action.headers)},
      body: ${JSON.stringify(action.body)},
      credentials: 'same-origin',
    });
    return { status: r.status, text: await r.text() };
  })()`;
  ctx.cache.replayInFlight = true; // our own replayed call must not be re-captured as a "learned" request
  try {
    const res = await ctx.run(script);
    const usage = res.status === 200 ? parseUsage(res.text) : null;
    return { usage, reason: usage ? 'ok' : `replay HTTP ${res.status}, no usage payload` };
  } catch (err) {
    return { usage: null, reason: `replay error: ${err.message}` };
  } finally {
    ctx.cache.replayInFlight = false;
  }
}

async function discoverActionId(ctx) {
  const script = `(async () => {
    const re = new RegExp(${JSON.stringify(actionIdPattern(USAGE_ACTION_NAME).source)});
    const queue = [...document.querySelectorAll('script[src]')].map((s) => s.src);
    let found = null;
    const worker = async () => {
      while (!found && queue.length) {
        try {
          const m = re.exec(await (await fetch(queue.shift())).text());
          if (m) found = m[1];
        } catch (e) { /* skip unreadable chunk */ }
      }
    };
    await Promise.all(Array.from({ length: ${DISCOVERY_CONCURRENCY} }, worker));
    return found;
  })()`;
  try {
    return await ctx.run(script);
  } catch (err) {
    ctx.log(`discovery failed: ${err.message}`);
    return null;
  }
}

function minimalAction(id, body) {
  return {
    url: START_URL,
    headers: { 'next-action': id, 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component' },
    body,
  };
}

// 1) the stored request; 2) the action id found in the bundles (scanned at most every few minutes).
async function replayUsageRequest(ctx) {
  const stored = ctx.store.get('action');
  let last = { usage: null, reason: 'no-learned-request' };
  if (stored) {
    last = await replay(ctx, stored);
    if (last.usage) return last;
  }
  let id = ctx.cache.actionId;
  if (!id && Date.now() - (ctx.cache.lastDiscoveryAt || 0) >= DISCOVERY_MIN_INTERVAL_MS) {
    ctx.cache.lastDiscoveryAt = Date.now();
    id = await discoverActionId(ctx);
    if (id) ctx.cache.actionId = id;
    else ctx.log('bundle scan: usage action not found in page JS');
  }
  if (!id) return last;
  const candidate = minimalAction(id, (stored && stored.body) || DEFAULT_USAGE_BODY);
  const result = await replay(ctx, candidate);
  ctx.log(`bundle scan: action=${id.slice(0, 8)}... replay=${result.usage ? 'ok' : result.reason}`);
  if (result.usage) ctx.store.set('action', { ...candidate, learnedAt: Date.now(), learnedVia: 'bundle-scan' });
  return result;
}

// Heuristic: the signed-out Muse home page shows the sign-in prompt.
async function pageShowsSignIn(ctx) {
  try {
    return await ctx.run("/log in or create an account/i.test((document.body && document.body.innerText) || '')");
  } catch {
    return false;
  }
}

async function read(ctx) {
  // The page makes its own usage call a few seconds after hydrating. With nothing learned yet,
  // give the capture (attach) a chance before giving up on this attempt.
  for (let i = 0; i < 15 && !ctx.store.get('action'); i++) await ctx.sleep(1000);
  const result = await replayUsageRequest(ctx);
  if (result.usage) return { state: 'ok', ...toReading(result.usage) };
  if (await pageShowsSignIn(ctx)) return { state: 'signed-out' };
  ctx.cache.actionId = null; // signed in but failing: allow a fresh bundle scan next time
  return { state: 'error', reason: result.reason };
}

// ---- learning from the page's own traffic -------------------------------------------------------
// Muse's chat page calls the usage action itself right after sign-in. Watching that traffic (CDP)
// gives an instant first reading, and the request that produced it is remembered for replaying.
// This is what closes the sign-in window by itself, without waiting for a scan.
const REPLAY_HEADERS = ['next-action', 'next-router-state-tree', 'x-deployment-id', 'content-type', 'accept'];

function stripQuery(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return '(bad url)';
  }
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k.toLowerCase()] = v;
  return out;
}

function attach(ctx, win, deliver) {
  const dbg = win.webContents.debugger;
  try {
    dbg.attach('1.3');
  } catch (err) {
    ctx.log(`debugger attach failed: ${err.message}`);
    return;
  }
  dbg.sendCommand('Network.enable').catch((e) => ctx.log(`Network.enable failed: ${e.message}`));
  const tracked = new Map(); // requestId -> url, x-component responses only
  const actionRequests = new Map(); // requestId -> candidate server-action request

  dbg.on('message', async (_event, method, params) => {
    if (method === 'Network.requestWillBeSent') {
      const h = lowerKeys(params.request.headers);
      if (params.request.method !== 'POST' || !h['next-action']) return;
      const headers = {};
      for (const key of REPLAY_HEADERS) if (h[key]) headers[key] = h[key];
      if (actionRequests.size > 100) actionRequests.clear();
      actionRequests.set(params.requestId, { url: params.request.url, headers, body: params.request.postData ?? '' });
    } else if (method === 'Network.responseReceived') {
      if (!ctx.cache.replayInFlight && (params.response.mimeType || '').includes('x-component')) {
        ctx.debugLog(`x-component ${params.response.status} ${stripQuery(params.response.url)}`);
        tracked.set(params.requestId, stripQuery(params.response.url));
      }
    } else if (method === 'Network.loadingFinished') {
      const { requestId } = params;
      const url = tracked.get(requestId);
      tracked.delete(requestId);
      if (!url) {
        actionRequests.delete(requestId);
        return;
      }
      try {
        const { body, base64Encoded } = await dbg.sendCommand('Network.getResponseBody', { requestId });
        const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
        const usage = parseUsage(text);
        if (!usage) ctx.debugLog(`no usage payload in ${url} (${text.length} chars): ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
        if (usage) {
          const a = actionRequests.get(requestId);
          if (a) {
            ctx.store.set('action', { ...a, learnedAt: Date.now() });
            ctx.log(`learned usage request: action=${a.headers['next-action'].slice(0, 8)}... bodyLen=${a.body.length}`);
          }
          deliver({ state: 'ok', ...toReading(usage) });
        }
      } catch (err) {
        ctx.debugLog(`getResponseBody failed for ${url}: ${err.message}`);
      } finally {
        actionRequests.delete(requestId);
      }
    }
  });
  dbg.on('detach', (_e, reason) => ctx.log(`debugger detached: ${reason}`));
}

module.exports = {
  id: 'muse',
  name: 'Muse',
  host: 'muse.ai',
  startUrl: START_URL,
  signInUrl: START_URL,
  partition: 'persist:aiw-muse',
  signInCookie: 'hatch_',
  popupHosts: ['muse.ai', 'meta.ai', 'meta.com', 'facebook.com'],
  meterDefs: [{ id: 'weekly', label: 'Weekly' }],
  read,
  attach,
  toReading,
};

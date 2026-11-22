'use strict';

/**
 * Parse Muse usage out of a Next.js server-action response
 * (content-type text/x-component, React "flight" line format):
 *
 *   0:{"a":"$@1","q":"","i":false}
 *   1:{"success":true,"subscription":{"usage":{"percentUsed":50,"resetsAt":1795272931,...},...}}
 *
 * Returns a normalized object, or null if the text has no usage payload.
 * Pure function - no Electron dependency, so it is unit-testable with plain node.
 */

// resetsAt is Unix seconds in the observed payload; tolerate milliseconds too.
const MS_THRESHOLD = 1e12;

function normalize(subscription) {
  const usage = subscription.usage;
  let resetsAtMs = null;
  if (typeof usage.resetsAt === 'number') {
    resetsAtMs = usage.resetsAt >= MS_THRESHOLD ? usage.resetsAt : usage.resetsAt * 1000;
  }
  return {
    percentUsed: usage.percentUsed,
    resetsAtMs,
    state: usage.state ?? null,
    quotaStatus: usage.quotaStatus ?? null,
    tierName: subscription.tier?.name ?? null,
    isPaid: subscription.tier?.isPaid ?? null,
    statusSubtitle: subscription.statusSubtitle ?? null,
  };
}

function parseUsage(text) {
  if (typeof text !== 'string' || !text.includes('percentUsed')) return null;
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    const payload = line.slice(idx + 1).trim();
    if (!payload.startsWith('{')) continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    const usage = obj?.subscription?.usage;
    if (usage && typeof usage.percentUsed === 'number') {
      return normalize(obj.subscription);
    }
  }
  return null;
}

module.exports = { parseUsage };

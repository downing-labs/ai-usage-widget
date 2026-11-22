'use strict';

const { makeMeter } = require('./common');

/**
 * Claude: the session's own API, called from inside the signed-in claude.ai page.
 *   GET /api/organizations                 -> pick the org with the "chat" capability
 *   GET /api/organizations/{uuid}/usage    -> five_hour / seven_day (+ a limits[] copy)
 */

// Pure: organization JSON -> "Max 5x" / "Max" / "Pro" / "Team" / "Enterprise" / null (unknown).
function claudePlanLabel(org) {
  if (!org || typeof org !== 'object') return null;
  const caps = (Array.isArray(org.capabilities) ? org.capabilities : []).map(String);
  const tier = String(org.rate_limit_tier || '').toLowerCase();
  const max = tier.match(/max[_-]?(\d+)x/);
  if (max) return `Max ${max[1]}x`;
  if (caps.includes('claude_max') || tier.includes('max')) return 'Max';
  if (caps.includes('raven') || tier.includes('team')) return 'Team';
  if (tier.includes('enterprise') || String(org.billing_type || '').toLowerCase().includes('enterprise')) return 'Enterprise';
  if (caps.includes('claude_pro') || tier.includes('pro')) return 'Pro';
  return null;
}

// Pure: usage JSON -> { plan, meters } or null when neither window is recognisable.
function parseClaudeUsage(usage, org) {
  if (!usage || typeof usage !== 'object') return null;
  const limits = Array.isArray(usage.limits) ? usage.limits : [];
  const byKind = (kind) => limits.find((l) => l && l.kind === kind) || null;
  const session = byKind('session');
  const weeklyAll = byKind('weekly_all');

  const five = makeMeter(
    usage.five_hour?.utilization ?? session?.percent,
    usage.five_hour?.resets_at ?? session?.resets_at
  );
  const weekly = makeMeter(
    usage.seven_day?.utilization ?? weeklyAll?.percent,
    usage.seven_day?.resets_at ?? weeklyAll?.resets_at
  );
  if (!five && !weekly) return null;
  const meters = {};
  if (five) meters.fiveHour = five;
  if (weekly) meters.weekly = weekly;
  return { plan: claudePlanLabel(org), meters };
}

const PROBE = `(async () => {
  const o = await fetch('/api/organizations', { credentials: 'include' });
  if (o.status === 401 || o.status === 403) return { state: 'signed-out' };
  if (!o.ok) return { state: 'error', reason: 'organizations HTTP ' + o.status };
  const orgs = await o.json();
  if (!Array.isArray(orgs) || !orgs.length) return { state: 'signed-out' };
  const org = orgs.find((x) => (x.capabilities || []).includes('chat')) || orgs[0];
  const r = await fetch('/api/organizations/' + encodeURIComponent(org.uuid) + '/usage', { credentials: 'include' });
  if (!r.ok) return { state: 'error', reason: 'usage HTTP ' + r.status };
  const orgInfo = { capabilities: org.capabilities || [], rate_limit_tier: org.rate_limit_tier || null, billing_type: org.billing_type || null };
  return { state: 'ok', usage: await r.json(), org: orgInfo };
})()`;

async function read(ctx) {
  const res = await ctx.run(PROBE);
  if (res.state !== 'ok') return res;
  const parsed = parseClaudeUsage(res.usage, res.org);
  // Capabilities/tier are account-type labels, not secrets; logged so the plan mapping can be verified.
  if (parsed && !parsed.plan) ctx.debugLog(`plan not recognised: ${JSON.stringify(res.org)}`);
  return parsed ? { state: 'ok', ...parsed } : { state: 'error', reason: 'unrecognised usage response' };
}

module.exports = {
  id: 'claude',
  name: 'Claude',
  host: 'claude.ai',
  startUrl: 'https://claude.ai/',
  signInUrl: 'https://claude.ai/login',
  partition: 'persist:aiw-claude',
  signInCookie: 'sessionKey',
  popupHosts: ['claude.ai', 'anthropic.com'],
  meterDefs: [
    { id: 'fiveHour', label: '5-hour' },
    { id: 'weekly', label: 'Weekly' },
  ],
  read,
  parseClaudeUsage,
  claudePlanLabel,
};

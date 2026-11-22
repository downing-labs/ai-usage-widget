'use strict';

/**
 * What the tray shows: the number for the icon, the hover tooltip and the macOS menu-bar text.
 * Pure functions over the provider views from visibility.buildProviderView().
 */

const TOOLTIP_MAX = 127; // Windows truncates tray tooltips here

function readable(view) {
  return view.enabled && view.auth !== 'signed-out' && view.hasReading;
}

const LIMIT_PERCENT = 99; // at or above this a meter counts as used up (the icon draws a cross from here)
const DEFAULT_WEEKLY_AT = 75; // the "weekly meters auto-appear at" setting
const DEFAULT_DANGER = 90;

// A provider's visible meters that have data, as { percent, providerId, meterId }.
function readableMeters(view) {
  if (!readable(view)) return [];
  return view.meters
    .filter((m) => m.visible && m.hasData)
    .map((m) => ({ percent: m.percent, providerId: view.id, meterId: m.id }));
}

const highestOf = (list) => list.reduce((best, m) => (!best || m.percent > best.percent ? m : best), null);

const atLimit = (view) => view.meters.some((m) => m.visible && m.hasData && m.percent >= LIMIT_PERCENT);

// What the tray icon shows: { percent, providerId, meterId, alert }. percent is null when there is nothing to show.
// The number follows the short meters (5-hour). A weekly meter only takes over once it reaches the "weekly meters
// auto-appear at" level (the same number the weekly cards use), because weekly numbers move too slowly to watch;
// below that it is only the fallback when nothing else is available (e.g. a tool that only has a weekly meter).
//  - 'highest': the highest watched meter that is not used up yet, so one maxed-out tool cannot hold the icon until
//    it resets. alert = some meter is at its limit while the icon shows something else. If every meter is used up
//    the icon shows that limit itself, with no dot.
//  - a tool id: always that tool, never overridden (the same short-meter rule applies within the tool).
//    alert = another tool has any meter at the danger level. A pinned tool that is switched off falls back to 'highest'.
// thresholds: { weekly, danger } percents.
function pickTrayState(views, trayProvider, thresholds = {}) {
  const weeklyAt = thresholds.weekly ?? DEFAULT_WEEKLY_AT;
  const danger = thresholds.danger ?? DEFAULT_DANGER;
  const watched = (m) => m.meterId !== 'weekly' || m.percent >= weeklyAt;
  const all = views.flatMap(readableMeters);
  const pinned = trayProvider !== 'highest' && views.some((v) => v.id === trayProvider && v.enabled);
  let best;
  let alert;
  if (pinned) {
    const mine = all.filter((m) => m.providerId === trayProvider);
    best = highestOf(mine.filter(watched)) || highestOf(mine);
    alert = all.some((m) => m.providerId !== trayProvider && m.percent >= danger);
  } else {
    const open = all.filter((m) => m.percent < LIMIT_PERCENT);
    best = highestOf(open.filter(watched)) || highestOf(open) || highestOf(all);
    alert = open.length > 0 && open.length < all.length;
  }
  return best ? { ...best, alert } : { percent: null, providerId: null, meterId: null, alert };
}

function meterText(view) {
  const shown = view.meters.filter((m) => m.visible && m.hasData);
  const list = shown.length ? shown : view.meters.filter((m) => m.hasData);
  if (!list.length) return '--';
  return list.map((m) => `${Math.round(m.percent)}%`).join(' / ');
}

// One line per enabled provider, e.g. "Claude 19% / 43%". Cut to the Windows limit.
function trayTooltip(views) {
  const lines = [];
  for (const view of views) {
    if (!view.enabled) continue;
    if (view.auth === 'signed-out') lines.push(`${view.name}: sign in`);
    else if (view.auth === 'signing-in') lines.push(`${view.name}: signing in...`);
    else if (!view.hasReading) lines.push(`${view.name}: ${view.error ? 'cannot read' : 'connecting...'}`);
    else lines.push(`${view.name} ${meterText(view)}${atLimit(view) ? ' - at limit' : ''}${view.stale ? ' (stale)' : ''}`);
  }
  if (!lines.length) return 'AI Usage Widget: no AI tools selected';
  const text = lines.join('\n');
  return text.length <= TOOLTIP_MAX ? text : `${text.slice(0, TOOLTIP_MAX - 1)}…`;
}

function macTrayTitle(percent, dangerPercent) {
  if (percent === null || percent === undefined) return 'AI --';
  const n = Math.round(percent);
  if (n >= 99) return `✕ ${n}%`;
  if (n >= dangerPercent) return `⚠ ${n}%`;
  return `${n}%`;
}

module.exports = { TOOLTIP_MAX, LIMIT_PERCENT, pickTrayState, trayTooltip, macTrayTitle };

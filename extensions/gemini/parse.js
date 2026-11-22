'use strict';

/**
 * Pure parser for the text of https://gemini.google.com/usage (no DOM, no browser APIs), so the
 * extension and the widget's tests can share it. Page text looks like:
 *
 *   Current usage / info / 0% used / Resets at 3:54 PM
 *   Weekly limit / Resets Nov 24 at 8:54 AM / 7% used
 *
 * Returns { fiveHour, weekly } where each is { percent, resetsAtMs } or null when not found.
 * Reset times are in the browser's local time zone, which is the same machine as the widget.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "3:54 PM" -> { h, m } in 24h, or null.
function parseClock(text) {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

// "Resets at 3:54 PM" (next occurrence) or "Resets Nov 24 at 8:54 AM" (next such date) -> epoch ms or null.
function parseReset(text, now = new Date()) {
  const line = /Resets\s+([^\n]+)/i.exec(text);
  if (!line) return null;
  const body = line[1];
  const clock = parseClock(body);
  if (!clock) return null;
  const date = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})/.exec(body);
  if (date) {
    const month = MONTHS.indexOf(date[1].toLowerCase());
    if (month < 0) return null;
    let d = new Date(now.getFullYear(), month, Number(date[2]), clock.h, clock.m, 0, 0);
    if (d.getTime() < now.getTime() - 24 * 3600 * 1000) d = new Date(now.getFullYear() + 1, month, Number(date[2]), clock.h, clock.m, 0, 0);
    return d.getTime();
  }
  let d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), clock.h, clock.m, 0, 0);
  if (d.getTime() <= now.getTime()) d = new Date(d.getTime() + 24 * 3600 * 1000);
  return d.getTime();
}

function parseSegment(segment, now) {
  const pct = /(\d+(?:\.\d+)?)\s*%\s*used/i.exec(segment);
  if (!pct) return null;
  const percent = Math.max(0, Math.min(100, Number(pct[1])));
  return { percent, resetsAtMs: parseReset(segment, now) };
}

function parseGeminiUsage(text, now = new Date()) {
  if (typeof text !== 'string') return null;
  const start = text.search(/Usage limits/i);
  const body = start >= 0 ? text.slice(start) : text;
  const weeklyAt = body.search(/Weekly limit/i);
  const currentAt = body.search(/Current usage/i);
  if (weeklyAt < 0 && currentAt < 0) return null;
  const currentSeg = currentAt >= 0 ? body.slice(currentAt, weeklyAt > currentAt ? weeklyAt : undefined) : '';
  const weeklySeg = weeklyAt >= 0 ? body.slice(weeklyAt, currentAt > weeklyAt ? currentAt : undefined) : '';
  const fiveHour = currentSeg ? parseSegment(currentSeg, now) : null;
  const weekly = weeklySeg ? parseSegment(weeklySeg, now) : null;
  if (!fiveHour && !weekly) return null;
  return { fiveHour, weekly, plan: parseGeminiPlan(body) };
}

// The page never names the plan. The only reliable signal is the upsell: "Get 2x more usage with AI Plus"
// is shown to accounts on the free tier (Plus is the lowest paid tier, so only free accounts are offered it).
// Paid plans are left unlabelled (null) until their wording can be checked on a paid account.
function parseGeminiPlan(text) {
  return /more usage with AI Plus/i.test(String(text)) ? 'Free' : null;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { parseGeminiUsage, parseGeminiPlan, parseReset };

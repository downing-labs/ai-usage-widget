'use strict';
// Every few minutes: if the widget on this computer says Gemini is switched on, open the Gemini usage
// page in a background tab, let content.js read it, hand the result to the widget (127.0.0.1 only,
// with the shared token), and close the tab again. No token, or no widget answering = do nothing.
// The token lives in chrome.storage.local, which Chrome does not sync to other computers.

const WIDGET = 'http://127.0.0.1:47831';
const USAGE_URL = 'https://gemini.google.com/usage';
const ALARM = 'aiw-gemini-poll';
const PERIOD_MINUTES = 5;
const TAB_TIMEOUT_MS = 30000;

const ownTabs = new Set(); // tabs this extension opened (and will close)

async function getToken() {
  const { token } = await chrome.storage.local.get('token');
  return typeof token === 'string' && token ? token : null;
}

async function widgetFetch(path, options = {}) {
  const token = await getToken();
  if (!token) return null;
  try {
    return await fetch(WIDGET + path, {
      ...options,
      headers: { ...(options.headers || {}), authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
  } catch {
    return null; // widget not running (or Gemini switched off there)
  }
}

async function poll() {
  const status = await widgetFetch('/status');
  if (!status || !status.ok) return; // nothing is asking for Gemini: stay idle, open nothing
  const existing = await chrome.tabs.query({ url: USAGE_URL + '*' });
  if (existing.length) {
    chrome.tabs.reload(existing[0].id); // already open: refresh it, its content script reports back
    return;
  }
  const tab = await chrome.tabs.create({ url: USAGE_URL, active: false });
  ownTabs.add(tab.id);
  setTimeout(() => closeOwn(tab.id), TAB_TIMEOUT_MS);
}

function closeOwn(tabId) {
  if (!ownTabs.delete(tabId)) return;
  chrome.tabs.remove(tabId).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'gemini-usage') return;
  const { ok, usage, reason, at } = msg;
  widgetFetch('/report', { method: 'POST', body: JSON.stringify({ ok, usage, reason, at }) });
  if (sender.tab) closeOwn(sender.tab.id);
});

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create(ALARM, { delayInMinutes: 0.2, periodInMinutes: PERIOD_MINUTES });
  if (!(await getToken())) chrome.runtime.openOptionsPage(); // first run: ask for the token
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage()); // toolbar button = token settings
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) poll(); });
// A new token was just saved: try right away instead of waiting for the next alarm.
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.token) poll(); });

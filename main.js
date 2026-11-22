'use strict';

const path = require('path');
const { app, BrowserWindow, Tray, Menu, shell, ipcMain, nativeImage, nativeTheme, screen, clipboard } = require('electron');
const Store = require('electron-store');
const logger = require('./src/logger');
const { DEFAULTS, PROVIDER_IDS, sanitizeSettings, normalizeOrder, mergeProvider } = require('./src/settings');
const { buildProviderView } = require('./src/visibility');
const { pickTrayState, trayTooltip, macTrayTitle } = require('./src/tray-text');
const { buildIcon } = require('./src/tray-icon');
const providers = require('./src/providers');
const { ProviderSession } = require('./src/session');
const { ExternalSession } = require('./src/session-external');
const { createBridge, newToken } = require('./src/bridge');
const updater = require('./src/update-check');

const EXTERNAL_LINKS = {
  kofi: 'https://ko-fi.com/hackpig1974',
  github: 'https://github.com/downing-labs/ai-usage-widget',
};
const UPDATE_FIRST_CHECK_MS = 8000;
const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;
const UPDATE_URL_PREFIX = 'https://github.com/downing-labs/ai-usage-widget/';

const WIDGET_WIDTH = 380;
const COMPACT_WIDTH = 250;
const WIDGET_MIN_HEIGHT = 90;
const WIDGET_MAX_HEIGHT = 780;
const WIDGET_START_HEIGHT = 220;
const WIDGET_MARGIN = 16;
const POLL_STAGGER_MS = 2500; // providers start polling one after another, not all at once
const DEBUG = process.argv.includes('--aiw-debug') || process.env.AIW_DEBUG === '1';

const IS_MAC = process.platform === 'darwin';
const IS_PORTABLE = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
const STARTUP_SUPPORTED = app.isPackaged && !IS_PORTABLE;

const store = new Store({ defaults: JSON.parse(JSON.stringify(DEFAULTS)) });

// ---- state ----------------------------------------------------------------------
let tray = null;
let widgetWin = null;
let quitting = false;
let moveTimer = null;
let refreshTimer = null;
let updateInfo = null;
let updateState = 'unknown'; // unknown | current | newer | error
let updateDismissed = false;
let updateTimer = null;
const signInQueue = []; // provider ids to prompt for sign-in, one window at a time
const sessions = new Map(); // provider id -> ProviderSession

// ---- settings ---------------------------------------------------------------------
function getSettings() {
  const s = {};
  for (const key of Object.keys(DEFAULTS)) if (key !== 'providers') s[key] = store.get(key);
  const stored = store.get('providers') || {};
  s.providers = {};
  for (const id of PROVIDER_IDS) s.providers[id] = mergeProvider(id, null, stored[id]);
  s.providerOrder = normalizeOrder(store.get('providerOrder'));
  return s;
}

function providerViews(settings = getSettings()) {
  const views = settings.providerOrder.map((id) => providers.byId(id)).filter(Boolean).map((p) =>
    buildProviderView(p, sessions.get(p.id).raw(), settings.providers[p.id], settings.autoShowPercent)
  );
  if (DEBUG && debugMaxed.size) applyDebugMaxed(views);
  return views;
}

// DEBUG-ONLY (needs --aiw-debug; remove once tray testing is done): the tray menu can pretend a tool is used up,
// so the tray's "limit" and alert-dot states can be seen without really hitting a limit. Cards show it too.
const debugMaxed = new Set();
function applyDebugMaxed(views) {
  for (const v of views) {
    if (!debugMaxed.has(v.id) || !v.hasReading) continue;
    v.meters = v.meters.map((m) => ({ ...m, percent: 100, hasData: true, visible: true }));
  }
}

// Tallest the widget may be: the work area of the display it is on, minus a margin.
function maxWidgetHeight() {
  try {
    const wa = (widgetWin && !widgetWin.isDestroyed()
      ? screen.getDisplayMatching(widgetWin.getBounds())
      : screen.getPrimaryDisplay()).workArea;
    return Math.max(WIDGET_MIN_HEIGHT, wa.height - 2 * WIDGET_MARGIN);
  } catch {
    return WIDGET_MAX_HEIGHT;
  }
}

function snapshot() {
  const settings = getSettings();
  return {
    providers: providerViews(settings),
    settings,
    version: app.getVersion(),
    startupSupported: STARTUP_SUPPORTED,
    maxHeight: maxWidgetHeight(),
    platform: process.platform,
    debug: DEBUG,
    update: updateInfo,
    updateState,
    updateDismissed,
  };
}

// ---- update check (same behaviour as the Muse widget) -----------------------------------
async function runUpdateCheck() {
  try {
    const found = await updater.checkForUpdate(app.getVersion());
    updateInfo = found;
    updateState = found ? 'newer' : 'current';
    logger.log(found ? `update available: v${found.version}` : 'update check: up to date');
  } catch (err) {
    updateState = updateInfo ? 'newer' : 'error';
    logger.log(`update check failed: ${err.message}`);
  }
  refreshAll();
}

function scheduleUpdateChecks(delayMs = UPDATE_FIRST_CHECK_MS) {
  clearTimeout(updateTimer);
  if (quitting || updateDismissed) return;
  updateTimer = setTimeout(async () => {
    await runUpdateCheck();
    scheduleUpdateChecks(UPDATE_INTERVAL_MS);
  }, delayMs);
}

function dismissUpdate() {
  updateDismissed = true;
  clearTimeout(updateTimer);
  logger.log('update banner dismissed; update checks stopped until restart');
  refreshAll();
}

// ---- state -> UI (widget window + tray) --------------------------------------------------
function broadcast() {
  if (widgetWin && !widgetWin.isDestroyed() && !widgetWin.webContents.isDestroyed()) {
    widgetWin.webContents.send('state', snapshot());
  }
}

async function updateTrayIcon(views, settings) {
  if (!tray || tray.isDestroyed()) return;
  const { percent, alert } = pickTrayState(views, settings.trayProvider, { weekly: settings.autoShowPercent, danger: settings.dangerPercent });
  if (IS_MAC) {
    tray.setTitle(macTrayTitle(percent, settings.dangerPercent) + (alert ? ' ●' : ''));
    return;
  }
  try {
    const dataUrl = await widgetWin.webContents.executeJavaScript(
      `window.__drawTrayIcon(${JSON.stringify({ percent, alert, warn: settings.warnPercent, danger: settings.dangerPercent })})`
    );
    if (tray && !tray.isDestroyed()) tray.setImage(nativeImage.createFromDataURL(dataUrl));
  } catch {
    if (tray && !tray.isDestroyed()) tray.setImage(buildIcon(percent));
  }
}

function refreshAll() {
  const settings = getSettings();
  const views = providerViews(settings);
  updateTrayIcon(views, settings);
  if (tray && !tray.isDestroyed()) {
    tray.setToolTip(trayTooltip(views));
    tray.setContextMenu(buildTrayMenu(views));
  }
  broadcast();
  drainSignInQueue();
}

// Many small changes arrive close together (a poll starts, a reading lands...): coalesce them.
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refreshAll(); }, 30);
}

// ---- providers --------------------------------------------------------------------------
// The Gemini companion's shared secret: made on first use, kept in the app's own config, never sent to the UI.
function ensureGeminiToken() {
  let token = store.get('geminiToken');
  if (typeof token !== 'string' || token.length < 16) {
    token = newToken();
    store.set('geminiToken', token);
  }
  return token;
}

// The bridge only listens while an externally-fed provider (Gemini) is switched on.
const bridge = createBridge({
  getToken: () => store.get('geminiToken'),
  onReport: (report) => {
    const p = providers.byId('gemini');
    sessions.get('gemini').accept(p.readingFromReport(report));
  },
  onError: (message) => sessions.get('gemini').setError(message),
  log: (m) => logger.log(m),
});

function syncBridge() {
  if (getSettings().providers.gemini.enabled) {
    ensureGeminiToken();
    bridge.start();
  } else {
    bridge.stop();
  }
}

function createSessions() {
  for (const p of providers.ALL) {
    const Session = p.external ? ExternalSession : ProviderSession;
    sessions.set(p.id, new Session(p, {
      store,
      isMac: IS_MAC,
      getPollSeconds: () => getSettings().pollSeconds,
      isQuitting: () => quitting,
      onChange: scheduleRefresh,
      onSignedIn: () => showWidget(),
    }));
  }
}

function applyEnabledProviders(previous) {
  const s = getSettings();
  let index = 0;
  for (const p of providers.ALL) {
    const session = sessions.get(p.id);
    const on = s.providers[p.id].enabled;
    if (on) {
      if (!session.enabled) {
        session.enable(index * POLL_STAGGER_MS);
        index += 1;
        if (!p.external && previous && !previous[p.id].enabled && !signInQueue.includes(p.id)) signInQueue.push(p.id);
      }
    } else if (session.enabled) {
      session.disable();
    }
  }
  syncBridge();
}

// After a provider is switched on, prompt for its sign-in (if it needs one), one window at a time.
function drainSignInQueue() {
  if (!signInQueue.length) return;
  if ([...sessions.values()].some((s) => s.auth === 'signing-in')) return;
  for (let i = 0; i < signInQueue.length; i++) {
    const session = sessions.get(signInQueue[i]);
    if (!session || !session.enabled || session.auth === 'signed-in') {
      signInQueue.splice(i--, 1);
    } else if (session.auth === 'signed-out') {
      signInQueue.splice(i, 1);
      session.startSignIn();
      return;
    }
  }
}

function refreshNow() {
  for (const s of sessions.values()) if (s.enabled) { clearTimeout(s.pollTimer); s.poll({ force: true }); }
}

// ---- widget window ---------------------------------------------------------------------
function initialWidgetPosition(width, height) {
  const saved = store.get('widgetPosition');
  if (saved && screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return saved.x >= a.x - 50 && saved.x < a.x + a.width - 50 && saved.y >= a.y && saved.y < a.y + a.height - 50;
  })) {
    return saved;
  }
  // Never positioned (first run, or a saved spot that is now off-screen): centre it on the primary display.
  // resizeWidget keeps it centred as the window grows to fit its content, until the user drags it.
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    centered: true,
  };
}

let centerOnResize = false;

function createWidgetWindow() {
  const s = getSettings();
  const width = s.compactMode ? COMPACT_WIDTH : WIDGET_WIDTH;
  const pos = initialWidgetPosition(width, WIDGET_START_HEIGHT);
  centerOnResize = pos.centered === true;
  widgetWin = new BrowserWindow({
    width, height: WIDGET_START_HEIGHT, x: pos.x, y: pos.y,
    frame: false, resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: s.alwaysOnTop,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0b' : '#ffffff',
    title: 'AI Usage',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  widgetWin.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  widgetWin.once('ready-to-show', () => widgetWin.show());
  widgetWin.webContents.on('did-finish-load', () => {
    refreshAll(); // the tray icon is drawn by the renderer
    setAppIcons();
  });
  widgetWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    widgetWin.hide();
  });
  widgetWin.on('moved', () => {
    centerOnResize = false; // the user placed it; stop re-centring
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (widgetWin && !widgetWin.isDestroyed()) {
        const [x, y] = widgetWin.getPosition();
        store.set('widgetPosition', { x, y });
      }
    }, 300);
  });
}

async function setAppIcons() {
  if (IS_MAC) return;
  try {
    const dataUrl = await widgetWin.webContents.executeJavaScript('window.__drawAppIcon(256)');
    const icon = nativeImage.createFromDataURL(dataUrl);
    widgetWin.setIcon(icon);
    for (const s of sessions.values()) if (s.hasWindow()) s.win.setIcon(icon);
  } catch (err) {
    logger.debugLog(`app icon failed: ${err.message}`);
  }
}

function showWidget() {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  if (widgetWin.isMinimized()) widgetWin.restore();
  widgetWin.show();
  widgetWin.focus();
}

function toggleWidget() {
  if (widgetWin.isVisible() && !widgetWin.isMinimized()) widgetWin.hide();
  else showWidget();
}

// `compact` is true only while the cards view is showing in compact mode; the renderer decides (Settings is never compact).
function resizeWidget(height, compact = false) {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  const width = compact ? COMPACT_WIDTH : WIDGET_WIDTH;
  const h = Math.max(WIDGET_MIN_HEIGHT, Math.min(maxWidgetHeight(), Math.ceil(Number(height) || WIDGET_START_HEIGHT)));
  widgetWin.setContentSize(width, h);
  // A frameless window can come out a few px shorter than asked (DPI rounding / frame metrics), which eats the
  // bottom padding. Check what we actually got and ask for the difference.
  const got = widgetWin.getContentSize()[1];
  if (got !== h && Math.abs(h - got) <= 16) {
    logger.debugLog(`widget height: asked ${h}, got ${got}; correcting`);
    widgetWin.setContentSize(width, h + (h - got));
  }
  let b = widgetWin.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  if (centerOnResize) {
    widgetWin.setPosition(Math.round(wa.x + (wa.width - b.width) / 2), Math.round(wa.y + (wa.height - b.height) / 2));
    b = widgetWin.getBounds();
  }
  if (b.y + b.height > wa.y + wa.height) {
    widgetWin.setPosition(b.x, Math.max(wa.y, wa.y + wa.height - b.height - WIDGET_MARGIN));
  }
}

function applySettingsChange(partial) {
  const before = getSettings();
  const changes = sanitizeSettings(partial, before);
  for (const [key, value] of Object.entries(changes)) store.set(key, value);
  const s = getSettings();
  if ('theme' in changes) nativeTheme.themeSource = s.theme;
  if ('alwaysOnTop' in changes) widgetWin.setAlwaysOnTop(s.alwaysOnTop);
  if ('startWithWindows' in changes && STARTUP_SUPPORTED) app.setLoginItemSettings({ openAtLogin: s.startWithWindows });
  if ('providers' in changes) applyEnabledProviders(before.providers);
  if ('pollSeconds' in changes) for (const session of sessions.values()) session.schedule();
  logger.log(`settings changed: ${Object.keys(changes).join(', ') || '(nothing valid)'}`);
  refreshAll();
  return s;
}

// ---- tray ----------------------------------------------------------------------------------
function buildTrayMenu(views) {
  const items = [
    { label: 'Show widget', click: showWidget },
    { label: 'Refresh now', click: refreshNow },
  ];
  const signedOut = views.filter((v) => v.enabled && v.auth === 'signed-out');
  if (signedOut.length) items.push({ type: 'separator' });
  for (const v of signedOut) {
    items.push({ label: `Sign in to ${v.name}...`, click: () => sessions.get(v.id).startSignIn() });
  }
  if (DEBUG) {
    items.push(
      { type: 'separator' },
      { label: 'Debug: open logs folder', click: () => shell.openPath(logger.getLogsDir()) },
      ...views.filter((v) => v.enabled && (v.hasReading || debugMaxed.has(v.id))).map((v) => ({
        label: `Debug: pretend ${v.name} is maxed out`,
        type: 'checkbox',
        checked: debugMaxed.has(v.id),
        click: () => {
          if (debugMaxed.has(v.id)) debugMaxed.delete(v.id); else debugMaxed.add(v.id);
          logger.log(`debug: ${v.name} maxed-out simulation ${debugMaxed.has(v.id) ? 'on' : 'off'}`);
          refreshAll();
        },
      })),
      {
        label: 'Debug: simulate update available',
        click: () => {
          updateInfo = { version: '9.9.9', url: updater.RELEASES_PAGE };
          updateState = 'newer';
          updateDismissed = false;
          logger.log('debug: simulated update v9.9.9');
          refreshAll();
        },
      }
    );
  }
  items.push({ type: 'separator' }, { label: 'Quit', click: () => { quitting = true; app.quit(); } });
  return Menu.buildFromTemplate(items);
}

// ---- IPC (widget window only) ---------------------------------------------------------------
function fromWidget(event) {
  return widgetWin && !widgetWin.isDestroyed() && event.sender === widgetWin.webContents;
}
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromWidget(event)) throw new Error(`blocked IPC: ${channel}`);
    return fn(...args);
  });
}
function listen(channel, fn) {
  ipcMain.on(channel, (event, ...args) => { if (fromWidget(event)) fn(...args); });
}
const sessionFor = (id) => (typeof id === 'string' ? sessions.get(id) : undefined);

function registerIpc() {
  handle('get-state', () => snapshot());
  handle('refresh', () => refreshNow());
  handle('sign-in', (id) => { const s = sessionFor(id); if (s) s.startSignIn(); });
  handle('cancel-sign-in', (id) => { const s = sessionFor(id); if (s) s.cancelSignIn(); });
  handle('sign-out', (id) => { const s = sessionFor(id); if (s) return s.signOut(); });
  handle('save-settings', (partial) => applySettingsChange(partial));
  handle('copy-gemini-token', () => { clipboard.writeText(ensureGeminiToken()); });
  handle('new-gemini-token', () => { store.set('geminiToken', newToken()); logger.log('gemini: companion token regenerated'); });
  handle('open-logs', () => shell.openPath(logger.getLogsDir()));
  // The UI sends a key, never a URL, so only these fixed links can ever be opened.
  handle('open-external', (key) => {
    const url = EXTERNAL_LINKS[key];
    if (url) shell.openExternal(url);
  });
  handle('dismiss-update', () => dismissUpdate());
  handle('open-update', () => {
    const url = updateInfo ? updateInfo.url : updater.RELEASES_PAGE;
    if (url.startsWith(UPDATE_URL_PREFIX)) shell.openExternal(url);
  });
  listen('win-minimize', () => widgetWin.minimize());
  listen('win-hide', () => widgetWin.hide());
  listen('win-resize', (height, compact) => resizeWidget(height, compact === true));
}

// ---- start ----------------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.downinglabs.aiusagewidget');
  app.on('second-instance', () => showWidget());
  app.whenReady().then(() => {
    if (IS_MAC) {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
      app.dock.hide();
    } else {
      Menu.setApplicationMenu(null);
    }
    logger.init(app.getPath('userData'), { debug: DEBUG });
    nativeTheme.themeSource = getSettings().theme;
    const enabled = providers.ALL.filter((p) => getSettings().providers[p.id].enabled).map((p) => p.id);
    logger.log(`start: electron ${process.versions.electron}, enabled=[${enabled.join(',')}], debug=${DEBUG}`);

    registerIpc();
    createSessions();
    createWidgetWindow();
    tray = new Tray(IS_MAC ? nativeImage.createEmpty() : buildIcon(null));
    if (IS_MAC) tray.setTitle(macTrayTitle(null, getSettings().dangerPercent));
    tray.setToolTip('AI Usage Widget');
    tray.on('click', toggleWidget);
    applyEnabledProviders(null);
    refreshAll();
    scheduleUpdateChecks();
  });
  app.on('window-all-closed', () => { /* tray app: keep running */ });
  app.on('before-quit', () => { quitting = true; bridge.stop(); });
}

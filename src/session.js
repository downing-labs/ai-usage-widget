'use strict';

const { BrowserWindow } = require('electron');
const logger = require('./logger');

/**
 * One ProviderSession per AI tool. It owns that provider's persistent web session (its own
 * cookie partition) in a hidden window, polls provider.read(ctx), and runs the sign-in flow.
 * auth: idle (disabled) | starting | signed-in | signed-out | signing-in
 */

const LOAD_TIMEOUT_MS = 20000;
const SIGNIN_SIZE = { width: 500, height: 760 };
const SIGNIN_CHECK_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hostMatches(url, host) {
  try {
    const h = new URL(url).hostname;
    return h === host || h.endsWith('.' + host);
  } catch {
    return false;
  }
}

class ProviderSession {
  // hooks: { store, isMac, getPollSeconds(), isQuitting(), onChange(), onSignedIn(session) }
  constructor(provider, hooks) {
    this.provider = provider;
    this.hooks = hooks;
    this.win = null;
    this.enabled = false;
    this.auth = 'idle';
    this.reading = null; // { plan, meters }
    this.lastGoodAt = null;
    this.error = null;
    this.stale = false;
    this.busy = false;
    this.missCount = 0;
    this.pollTimer = null;
    this.signInTimer = null;
    this.pollInFlight = false;
    this.confirming = false;
    this.cache = {}; // in-memory scratch for the provider module (e.g. discovered ids)
    this.ctx = this.makeContext();
  }

  makeContext() {
    const id = this.provider.id;
    const store = this.hooks.store;
    return {
      run: (script) => this.win.webContents.executeJavaScript(script),
      store: {
        get: (key) => store.get(`p.${id}.${key}`),
        set: (key, value) => store.set(`p.${id}.${key}`, value),
        delete: (key) => store.delete(`p.${id}.${key}`),
      },
      cache: this.cache,
      log: (m) => logger.log(`[${id}] ${m}`),
      debugLog: (m) => logger.debugLog(`[${id}] ${m}`),
      sleep,
    };
  }

  log(message) {
    logger.log(`[${this.provider.id}] ${message}`);
  }

  emit() {
    this.hooks.onChange();
  }

  // The raw state buildProviderView() turns into what the UI shows.
  raw() {
    return {
      auth: this.auth,
      reading: this.reading,
      lastGoodAt: this.lastGoodAt,
      error: this.error,
      stale: this.stale,
      misses: this.missCount,
      busy: this.busy,
    };
  }

  // ---- lifecycle -------------------------------------------------------------
  enable(firstPollDelayMs = 0) {
    if (this.enabled) return;
    this.enabled = true;
    const last = this.ctx.store.get('last');
    if (last && last.reading) {
      this.reading = last.reading;
      this.lastGoodAt = last.at;
    }
    this.auth = 'starting';
    this.createWindow();
    this.pollTimer = setTimeout(() => this.poll(), firstPollDelayMs);
    this.emit();
  }

  // Turning a provider off keeps its cookies, so turning it back on is still signed in.
  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.stopSignInWatch();
    clearTimeout(this.pollTimer);
    this.destroyWindow();
    this.auth = 'idle';
    this.reading = null;
    this.lastGoodAt = null;
    this.error = null;
    this.stale = false;
    this.busy = false;
    this.emit();
  }

  destroyWindow() {
    this.destroying = true;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.destroying = false;
  }

  hasWindow() {
    return Boolean(this.win && !this.win.isDestroyed());
  }

  onHost() {
    return this.hasWindow() && hostMatches(this.win.webContents.getURL(), this.provider.host);
  }

  createWindow() {
    const p = this.provider;
    this.win = new BrowserWindow({
      width: SIGNIN_SIZE.width,
      height: SIGNIN_SIZE.height,
      show: false,
      autoHideMenuBar: true,
      title: `Sign in to ${p.name}`,
      webPreferences: {
        partition: p.partition,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    // Plain Chrome UA: Electron's default UA advertises "Electron/".
    const platform = this.hooks.isMac ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64';
    this.win.webContents.setUserAgent(
      `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
    );
    // Sign-in may use a popup; allow this provider's own hosts only.
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      if (p.popupHosts.some((h) => hostMatches(url, h))) return { action: 'allow' };
      this.log('blocked popup');
      return { action: 'deny' };
    });
    // Closing the sign-in window abandons the sign-in; the app keeps running.
    this.win.on('close', (e) => {
      if (this.destroying || this.hooks.isQuitting()) return;
      e.preventDefault();
      if (this.auth === 'signing-in') {
        this.stopSignInWatch();
        this.auth = 'signed-out';
        this.emit();
      }
      this.win.hide();
    });
    // A new session cookie while signing in = probably just logged in; check right away.
    if (p.signInCookie) {
      this.win.webContents.session.cookies.on('changed', (_e, cookie, _cause, removed) => {
        if (this.auth === 'signing-in' && !removed && cookie.name.includes(p.signInCookie)) this.confirm();
      });
    }
    // Optional: a provider can watch its page's own traffic and hand us readings as they happen.
    if (p.attach) {
      p.attach(this.ctx, this.win, (res) => {
        if (res.state === 'ok' && this.enabled) this.applyOk(res);
      });
    }
  }

  // ---- reading ---------------------------------------------------------------
  async load(url = this.provider.startUrl) {
    if (!this.hasWindow()) return false;
    let timer;
    try {
      await Promise.race([
        this.win.loadURL(url),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('load timeout')), LOAD_TIMEOUT_MS); }),
      ]);
      return true;
    } catch (err) {
      this.log(`page load problem: ${err.code || err.message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async safeRead() {
    try {
      return await this.provider.read(this.ctx);
    } catch (err) {
      return { state: 'error', reason: `read failed: ${err.message}` };
    }
  }

  applyOk(res) {
    const was = this.auth;
    this.missCount = 0;
    this.stale = false;
    this.error = null;
    this.reading = { plan: res.plan || null, meters: res.meters || {} };
    this.lastGoodAt = Date.now();
    this.ctx.store.set('last', { reading: this.reading, at: this.lastGoodAt });
    this.auth = 'signed-in';
    const summary = Object.entries(this.reading.meters)
      .map(([k, m]) => `${k}=${Math.round(m.percent)}%`)
      .join(' ');
    this.log(`usage: ${summary || '(no meters)'} plan=${this.reading.plan}`);
    // A good reading proves we're signed in: dismiss the sign-in window straight away.
    this.stopSignInWatch();
    if (this.hasWindow() && this.win.isVisible()) this.win.hide();
    if (was === 'signing-in') {
      this.log('sign-in complete');
      this.hooks.onSignedIn(this);
      this.schedule();
    }
    this.emit();
  }

  markSignedOut() {
    this.log('session is signed out');
    this.auth = 'signed-out';
    this.error = null;
    this.stale = false;
    this.reading = null;
    this.lastGoodAt = null;
    this.ctx.store.delete('last');
    this.emit();
  }

  handleMiss(reason) {
    this.missCount += 1;
    this.stale = true;
    this.error = reason;
    this.log(`poll: no reading (${reason}) miss #${this.missCount}`);
    this.emit();
  }

  async poll({ force = false } = {}) {
    if (this.pollInFlight || !this.enabled || !this.hasWindow()) return;
    if (!force && (this.auth === 'signed-out' || this.auth === 'signing-in')) return;
    if (this.auth === 'signing-in') return; // never navigate the window the user is typing in
    this.pollInFlight = true;
    this.busy = true;
    this.emit();
    try {
      let res = this.onHost() ? await this.safeRead() : { state: 'error', reason: 'page not loaded' };
      if (res.state !== 'ok') {
        // One reload-and-retry before believing a failure or a signed-out answer.
        await this.load();
        if (this.onHost()) res = await this.safeRead();
      }
      if (res.state !== 'ok' && res.state !== 'signed-out') await this.logPageState();
      if (res.state === 'ok') this.applyOk(res);
      else if (res.state === 'signed-out') this.markSignedOut();
      else this.handleMiss(res.reason || 'unknown error');
    } finally {
      this.pollInFlight = false;
      this.busy = false;
      this.emit();
      this.schedule();
    }
  }

  // Debug aid: where the hidden page is and what it says (no cookies, only the first words).
  async logPageState() {
    if (!this.hasWindow()) return;
    try {
      const text = await this.win.webContents.executeJavaScript(
        "((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').slice(0, 160)"
      );
      logger.debugLog(`[${this.provider.id}] miss: url=${this.win.webContents.getURL().split('?')[0]} text="${text}"`);
    } catch (err) {
      logger.debugLog(`[${this.provider.id}] miss: page state unavailable (${err.message})`);
    }
  }

  schedule() {
    clearTimeout(this.pollTimer);
    if (!this.enabled || this.hooks.isQuitting()) return;
    if (this.auth === 'signed-out' || this.auth === 'signing-in') return;
    this.pollTimer = setTimeout(() => this.poll(), this.hooks.getPollSeconds() * 1000);
  }

  // ---- sign-in ---------------------------------------------------------------
  startSignIn() {
    if (!this.enabled || !this.hasWindow()) return;
    if (this.auth === 'signing-in') {
      this.showWindow();
      return;
    }
    this.log('sign-in: opening window');
    clearTimeout(this.pollTimer);
    this.auth = 'signing-in';
    this.error = null;
    this.win.setSize(SIGNIN_SIZE.width, SIGNIN_SIZE.height);
    this.win.center();
    this.load(this.provider.signInUrl || this.provider.startUrl);
    this.showWindow();
    this.stopSignInWatch();
    this.signInTimer = setInterval(() => this.confirm(), SIGNIN_CHECK_MS);
    this.emit();
  }

  async confirm() {
    if (this.confirming || this.auth !== 'signing-in' || !this.onHost()) return;
    this.confirming = true;
    try {
      const res = await this.safeRead();
      if (res.state === 'ok' && this.auth === 'signing-in') this.applyOk(res);
    } finally {
      this.confirming = false;
    }
  }

  cancelSignIn() {
    if (this.auth !== 'signing-in') return;
    this.log('sign-in: cancelled');
    this.stopSignInWatch();
    if (this.hasWindow()) this.win.hide();
    this.auth = 'signed-out';
    this.emit();
  }

  stopSignInWatch() {
    clearInterval(this.signInTimer);
    this.signInTimer = null;
  }

  showWindow() {
    if (!this.hasWindow()) return;
    this.win.show();
    this.win.focus();
  }

  async signOut() {
    if (!this.hasWindow()) return;
    this.log('sign-out: clearing local session');
    this.stopSignInWatch();
    clearTimeout(this.pollTimer);
    this.win.hide();
    try {
      await this.win.webContents.session.clearStorageData();
      await this.win.webContents.session.clearCache();
    } catch (err) {
      this.log(`sign-out: clearing session data failed: ${err.message}`);
    }
    await this.win.loadURL('about:blank').catch(() => {});
    this.cache.actionId = null;
    this.markSignedOut();
  }
}

module.exports = { ProviderSession, hostMatches };

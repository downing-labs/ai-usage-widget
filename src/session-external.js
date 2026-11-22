'use strict';

const logger = require('./logger');

/**
 * A provider that is fed from outside (the Gemini Chrome companion, via the bridge) instead of by
 * its own hidden window. Same surface main.js uses on ProviderSession, so it slots into the same
 * map. States: 'waiting' (nothing received yet) -> 'signed-in' (has a reading).
 */

const EXPECTED_PERIOD_MS = 5 * 60 * 1000; // the companion reports about every 5 minutes
const TICK_MS = 60 * 1000;

class ExternalSession {
  constructor(provider, hooks) {
    this.provider = provider;
    this.hooks = hooks;
    this.enabled = false;
    this.auth = 'idle';
    this.reading = null;
    this.lastGoodAt = null;
    this.error = null;
    this.busy = false;
    this.pollTimer = null;
    this.ticker = null;
  }

  log(message) {
    logger.log(`[${this.provider.id}] ${message}`);
  }

  hasWindow() { return false; }
  schedule() {}
  poll() {}
  startSignIn() {}
  cancelSignIn() {}

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    const last = this.hooks.store.get(`p.${this.provider.id}.last`);
    if (last && last.reading) {
      this.reading = last.reading;
      this.lastGoodAt = last.at;
    }
    this.auth = this.reading ? 'signed-in' : 'waiting';
    // "Unable to poll" counts silent periods, so re-evaluate once a minute.
    this.ticker = setInterval(() => this.hooks.onChange(), TICK_MS);
    this.hooks.onChange();
  }

  disable() {
    this.enabled = false;
    this.auth = 'idle';
    clearInterval(this.ticker);
    this.ticker = null;
    this.hooks.onChange();
  }

  async signOut() {
    this.reading = null;
    this.lastGoodAt = null;
    this.error = null;
    this.hooks.store.delete(`p.${this.provider.id}.last`);
    if (this.enabled) this.auth = 'waiting';
    this.hooks.onChange();
  }

  // From the bridge. `reading` is what provider.readingFromReport() returned.
  accept(result) {
    if (!this.enabled || !result) return;
    if (result.error) {
      this.error = result.error;
      this.log(`companion reported: ${result.error}`);
    } else {
      this.reading = { plan: result.plan || null, meters: result.meters };
      this.lastGoodAt = Date.now();
      this.error = null;
      this.auth = 'signed-in';
      this.hooks.store.set(`p.${this.provider.id}.last`, { reading: this.reading, at: this.lastGoodAt });
      const m = result.meters;
      this.log(`usage: fiveHour=${m.fiveHour ? Math.round(m.fiveHour.percent) + '%' : '-'} weekly=${m.weekly ? Math.round(m.weekly.percent) + '%' : '-'}`);
    }
    this.hooks.onChange();
  }

  setError(message) {
    this.error = message;
    this.hooks.onChange();
  }

  raw() {
    // Periods missed since the last good report (the first missed period is normal timing slack).
    const missed = this.lastGoodAt ? Math.max(0, Math.floor((Date.now() - this.lastGoodAt) / EXPECTED_PERIOD_MS) - 1) : 0;
    return {
      auth: this.auth,
      reading: this.reading,
      lastGoodAt: this.lastGoodAt,
      error: this.error,
      stale: missed > 0,
      misses: missed,
      busy: false,
    };
  }
}

module.exports = { ExternalSession };

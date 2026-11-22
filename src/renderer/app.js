(() => {
  'use strict';

  const api = window.aiwAPI;
  const $ = (id) => document.getElementById(id);
  const COUNTDOWN_REFRESH_MS = 30000;
  const DAY_MS = 24 * 3600 * 1000;
  const MODE_LABELS = { show: 'Always show', auto: 'Show when high' };
  const POLL_WARN_MISSES = 3; // consecutive failed polls before the card says so

  let state = null;
  let settingsOpen = false;
  let resizeQueued = false;
  let providerSettingsSig = '';
  const setupPick = new Set();

  // ---- helpers ------------------------------------------------------------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const levelFor = (pct, s) => (pct >= s.dangerPercent ? 'danger' : pct >= s.warnPercent ? 'warn' : 'ok');
  const hour12 = (fmt) => fmt !== '24h';

  function fmtTime(ms, fmt) {
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: hour12(fmt) });
  }

  // Within a day: just the clock time. Further out: weekday + time.
  function fmtReset(ms, fmt) {
    if (ms - Date.now() < DAY_MS) return fmtTime(ms, fmt);
    const day = new Date(ms).toLocaleDateString('en-US', { weekday: 'short' });
    return `${day} ${fmtTime(ms, fmt)}`;
  }

  function fmtCountdown(ms) {
    const mins = Math.floor((ms - Date.now()) / 60000);
    if (mins < 0) return 'resetting…';
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // "Resets: 1:16 PM (1h 3m)" within a day, "Resets: Thu 5:00 PM (4d 4h)" further out.
  const resetLine = (ms, fmt) => {
    if (!ms) return 'Resets: unknown';
    const left = fmtCountdown(ms);
    return left === 'resetting…' ? `Resets: ${fmtReset(ms, fmt)} (resetting…)` : `Resets: ${fmtReset(ms, fmt)} (${left})`;
  };

  // ---- colour swatches ------------------------------------------------------
  const PALETTES = [['violet', 'Violet'], ['ocean', 'Ocean'], ['teal', 'Teal'], ['forest', 'Forest'], ['rose', 'Rose'], ['orange', 'Orange'], ['graphite', 'Graphite']];

  // One dot per palette (plus "Auto" = this tool's default colour).
  function buildSwatches(container, current, onPick, withAuto) {
    container.replaceChildren();
    const options = withAuto ? [['default', 'Auto'], ...PALETTES] : PALETTES;
    for (const [id, name] of options) {
      const b = el('button', id === 'default' ? 'swatch auto' : 'swatch', id === 'default' ? 'Auto' : '');
      b.type = 'button';
      b.dataset.p = id;
      b.title = id === 'default' ? 'Auto: this tool\'s default colour' : name;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', id === 'default' ? 'Auto (default colour)' : name);
      b.setAttribute('aria-checked', String(id === current));
      b.addEventListener('click', () => onPick(id));
      container.append(b);
    }
  }

  // ---- cards --------------------------------------------------------------
  function meterRow(card, m, s) {
    const row = el('div', 'meter');
    row.append(el('span', 'mlabel', m.label));
    const bar = el('div', 'bar');
    const fill = el('div', 'bar-fill');
    bar.append(fill);
    row.append(bar);
    if (m.hasData) {
      row.dataset.level = levelFor(m.percent, s.settings);
      fill.style.width = `${Math.max(0, Math.min(100, m.percent))}%`;
      row.append(el('span', 'mpct', `${Math.round(m.percent)}%`));
      const reset = el('span', 'mreset', resetLine(m.resetsAtMs, s.settings.timeFormat));
      if (m.resetsAtMs) { reset.dataset.resetMs = String(m.resetsAtMs); }
      row.append(reset);
    } else {
      row.append(el('span', 'mpct none', '—'));
      row.append(el('span', 'mreset', 'No active window'));
    }
    card.append(row);
  }

  function messageRow(card, text, buttonLabel, onClick, primary) {
    const row = el('div', 'card-msg');
    row.append(el('span', '', text));
    if (buttonLabel) {
      const btn = el('button', primary ? 'btn small primary' : 'btn small', buttonLabel);
      btn.addEventListener('click', onClick);
      row.append(btn);
    }
    card.append(row);
  }

  function buildCard(view, s) {
    const card = el('div', 'card');
    card.dataset.provider = view.id;
    card.dataset.palette = view.effectivePalette; // the user's pick, or this tool's default (Auto)
    card.draggable = true;
    card.title = 'Drag to reorder';
    const head = el('div', 'card-head');
    head.append(el('span', 'pname', view.name));
    if (view.hasReading && view.plan) head.append(el('span', 'plan', view.plan));
    // Blank unless polling keeps failing: then say how many attempts in a row have failed.
    if (view.misses >= POLL_WARN_MISSES) head.append(el('span', 'pstatus warn', `Unable to poll: ${view.misses} attempts`));
    card.append(head);

    if (view.auth === 'waiting') { // fed by a Chrome companion (Gemini): nothing received yet
      messageRow(card, view.error || 'Waiting for the Chrome companion…', 'Copy token', () => api.copyGeminiToken());
    } else if (view.auth === 'signed-out') {
      messageRow(card, 'Not signed in', 'Sign in', () => api.signIn(view.id), true);
    } else if (view.auth === 'signing-in') {
      messageRow(card, 'Finish signing in in the window…', 'Cancel', () => api.cancelSignIn(view.id));
    } else if (!view.hasReading && view.error) {
      messageRow(card, `Can't read usage: ${view.error}`, 'Retry', () => api.refresh());
    } else if (!view.hasReading) {
      card.append(el('div', 'card-note keep', 'Connecting…'));
    } else {
      const withData = view.meters.filter((m) => m.hasData);
      const shown = view.meters.filter((m) => m.visible);
      if (!withData.length) {
        card.append(el('div', 'card-note', 'No usage meters reported for this plan.'));
      } else if (!shown.length) {
        card.append(el('div', 'card-note', 'Meters hidden until they reach the auto-show level.'));
      } else {
        for (const m of shown) meterRow(card, m, s);
      }
    }
    return card;
  }

  // Click-hold a card and drag it up or down to reorder; the order is saved when you let go.
  let dragging = null;
  function enableDragReorder(cards) {
    cards.addEventListener('dragstart', (e) => {
      const card = e.target.closest && e.target.closest('.card');
      if (!card) return;
      dragging = card;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.provider);
    });
    cards.addEventListener('dragover', (e) => {
      if (!dragging) return;
      e.preventDefault();
      const others = [...cards.querySelectorAll('.card:not(.dragging)')];
      const after = others.find((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
      if (after) cards.insertBefore(dragging, after); else cards.append(dragging);
    });
    cards.addEventListener('drop', (e) => e.preventDefault());
    cards.addEventListener('dragend', () => {
      if (!dragging) return;
      dragging.classList.remove('dragging');
      dragging = null;
      moveEnabledOrder([...cards.querySelectorAll('.card')].map((c) => c.dataset.provider));
    });
  }

  // Put the given (enabled) ids in order, keeping disabled tools where they were.
  function moveEnabledOrder(enabledIds) {
    if (!state) return;
    const queue = enabledIds.slice();
    const enabled = new Set(enabledIds);
    const next = state.settings.providerOrder.map((id) => (enabled.has(id) ? queue.shift() : id));
    if (next.join() !== state.settings.providerOrder.join()) save({ providerOrder: next });
  }

  function renderCards(s) {
    if (dragging) return; // don't rebuild the list under a drag in progress
    const cards = $('cards');
    cards.replaceChildren(...s.providers.filter((v) => v.enabled).map((v) => buildCard(v, s)));
  }

  function updateCountdowns() {
    if (!state) return;
    for (const node of document.querySelectorAll('.mreset[data-reset-ms]')) {
      const ms = Number(node.dataset.resetMs);
      node.textContent = resetLine(ms, state.settings.timeFormat);
    }
  }

  // ---- first-run picker -----------------------------------------------------
  function renderSetup(s) {
    const list = $('setupList');
    if (list.childElementCount) return; // build once; keep the user's ticks
    for (const v of s.providers) {
      const label = el('label', 'setup-item');
      const box = el('input');
      box.type = 'checkbox';
      box.addEventListener('change', () => {
        if (box.checked) setupPick.add(v.id); else setupPick.delete(v.id);
        $('btnSetupContinue').disabled = setupPick.size === 0;
      });
      label.append(box, el('span', '', v.name), el('small', '', v.meters.map((m) => m.label).join(' + ')));
      list.append(label);
    }
  }

  // ---- settings -------------------------------------------------------------
  function providerSettingsSignature(s) {
    return JSON.stringify(s.providers.map((v) => [v.id, v.enabled, v.auth, v.palette, v.meters.map((m) => m.mode)]));
  }

  function buildProviderSettings(s) {
    const box = $('providerSettings');
    box.replaceChildren();
    for (const v of s.providers) {
      const block = el('div', 'pset');
      const head = el('div', 'pset-head');
      const check = el('label', 'check');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = v.enabled;
      input.addEventListener('change', () => api.saveSettings({ providers: { [v.id]: { enabled: input.checked } } }));
      check.append(input, el('span', '', v.name));
      head.append(check);
      if (v.enabled && v.external) {
        const copy = el('button', 'btn small', 'Copy token');
        copy.title = 'Paste this into the Chrome companion\'s options page';
        copy.addEventListener('click', () => api.copyGeminiToken());
        const fresh = el('button', 'btn small', 'New token');
        fresh.title = 'Replace the token (the companion must be given the new one)';
        fresh.addEventListener('click', () => api.newGeminiToken());
        head.append(copy, fresh);
      } else if (v.enabled) {
        if (v.auth === 'signed-in') {
          const out = el('button', 'btn small', 'Sign out');
          out.addEventListener('click', () => { settingsOpen = false; applyPanels(); api.signOut(v.id); });
          head.append(out);
        } else if (v.auth === 'signing-in') {
          const cancel = el('button', 'btn small', 'Cancel');
          cancel.addEventListener('click', () => api.cancelSignIn(v.id));
          head.append(cancel);
        } else if (v.auth === 'signed-out') {
          const inBtn = el('button', 'btn small primary', 'Sign in');
          inBtn.addEventListener('click', () => api.signIn(v.id));
          head.append(inBtn);
        }
      }
      const idx = s.providers.indexOf(v);
      const order = el('span', 'order');
      for (const [dir, glyph, label] of [[-1, '▲', 'Move up'], [1, '▼', 'Move down']]) {
        const b = el('button', 'btn icon small', glyph);
        b.title = label;
        b.disabled = idx + dir < 0 || idx + dir >= s.providers.length;
        b.addEventListener('click', () => {
          const ids = s.providers.map((p) => p.id);
          [ids[idx], ids[idx + dir]] = [ids[idx + dir], ids[idx]];
          save({ providerOrder: ids });
        });
        order.append(b);
      }
      head.append(order);
      block.append(head);
      if (v.enabled) { // this tool's colour: one of the six, or Auto = the app-wide colour
        const colorRow = el('div', 'row');
        colorRow.append(el('span', 'muted', 'Color'));
        const sw = el('span', 'swatches');
        sw.setAttribute('role', 'radiogroup');
        buildSwatches(sw, v.palette, (p) => api.saveSettings({ providers: { [v.id]: { palette: p } } }), true);
        colorRow.append(sw);
        block.append(colorRow);
      }
      // Only meters with a real choice get a row (today: the Weekly meter of tools that also have a 5-hour one).
      const choosable = v.enabled ? v.meters.filter((m) => m.modes.length > 1) : [];
      if (choosable.length) {
        const meters = el('div', 'pset-meters');
        for (const m of choosable) {
          const row = el('div', 'row');
          row.append(el('span', 'muted', m.label));
          const select = el('select');
          for (const value of m.modes) {
            const opt = el('option', '', MODE_LABELS[value]);
            opt.value = value;
            select.append(opt);
          }
          select.value = m.mode;
          select.addEventListener('change', () => api.saveSettings({ providers: { [v.id]: { [m.id]: select.value } } }));
          row.append(select);
          meters.append(row);
        }
        block.append(meters);
      }
      box.append(block);
    }
  }

  function renderSettings(s) {
    const set = s.settings;
    const sig = providerSettingsSignature(s);
    if (sig !== providerSettingsSig) {
      providerSettingsSig = sig;
      buildProviderSettings(s);
    }
    const fields = [
      ['setAutoShow', 'value', String(set.autoShowPercent)],
      ['setPoll', 'value', String(set.pollSeconds)],
      ['setWarn', 'value', String(set.warnPercent)],
      ['setDanger', 'value', String(set.dangerPercent)],
      ['setTheme', 'value', set.theme],
      ['setTime', 'value', set.timeFormat],
      ['setTop', 'checked', set.alwaysOnTop],
      ['setCompact', 'checked', set.compactMode],
      ['setStartup', 'checked', s.startupSupported && set.startWithWindows],
    ];
    for (const [id, prop, value] of fields) {
      const node = $(id);
      if (document.activeElement !== node) node[prop] = value; // don't clobber what's being typed
    }
    // Tray icon: the highest meter, or one tool (only tools that are switched on). A pick that is off shows as Highest.
    const trayChoices = [['highest', 'Highest meter'], ...s.providers.filter((v) => v.enabled).map((v) => [v.id, v.name])];
    const traySel = $('setTray');
    const traySig = trayChoices.map((c) => c.join(':')).join();
    if (traySel.dataset.sig !== traySig) {
      traySel.replaceChildren(...trayChoices.map(([value, label]) => Object.assign(el('option', '', label), { value })));
      traySel.dataset.sig = traySig;
    }
    if (document.activeElement !== traySel) traySel.value = trayChoices.some((c) => c[0] === set.trayProvider) ? set.trayProvider : 'highest';
    $('startupLabel').textContent = s.platform === 'darwin' ? 'Start at login' : 'Start with Windows';
    $('setStartup').disabled = !s.startupSupported;
    $('startupNote').textContent = s.startupSupported ? '' : '(Needs the installed version)';
    $('version').textContent = `v${s.version}`;
    $('updateBanner').hidden = !s.update || s.updateDismissed;
    if (s.update) $('updateLink').textContent = `Update available: v${s.update.version} - click to download`;
    const status = $('updateStatus');
    status.classList.toggle('available', !!s.update);
    status.disabled = !s.update;
    status.textContent = s.update ? 'Update available' : s.updateState === 'current' ? 'Up to date' : '';
    $('btnLogs').hidden = !s.debug;
    document.querySelector('.settings-foot').hidden = !s.debug;
  }

  // Compact only applies to the cards view. Settings always uses the full layout and width.
  const isCompact = () => !!(state && state.settings.compactMode) && !settingsOpen;

  function applyPanels() {
    $('main').hidden = settingsOpen;
    $('settings').hidden = !settingsOpen;
    document.body.classList.toggle('compact', isCompact());
  }

  function scheduleResize() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      api.resize(Math.ceil($('app').getBoundingClientRect().height), isCompact());
    });
  }

  function render(s) {
    state = s;
    // The settings panel grows with its content, up to the screen's work area (then it scrolls).
    if (s.maxHeight) $('settings').style.maxHeight = `${Math.max(200, s.maxHeight - 40)}px`;
    $('btnRefresh').classList.toggle('spinning', s.providers.some((v) => v.busy));
    const anyEnabled = s.providers.some((v) => v.enabled);
    $('viewSetup').hidden = anyEnabled;
    $('viewCards').hidden = !anyEnabled;
    if (anyEnabled) renderCards(s); else renderSetup(s);
    renderSettings(s);
    applyPanels();
    scheduleResize();
  }

  // ---- settings + buttons ---------------------------------------------------
  const save = (partial) => api.saveSettings(partial);
  $('setAutoShow').addEventListener('change', (e) => save({ autoShowPercent: Number(e.target.value) }).then(() => state && render(state)));
  $('setPoll').addEventListener('change', (e) => save({ pollSeconds: Number(e.target.value) }));
  $('setWarn').addEventListener('change', (e) => save({ warnPercent: Number(e.target.value) }).then(() => state && render(state)));
  $('setDanger').addEventListener('change', (e) => save({ dangerPercent: Number(e.target.value) }).then(() => state && render(state)));
  $('setTheme').addEventListener('change', (e) => save({ theme: e.target.value }));
  $('setTray').addEventListener('change', (e) => save({ trayProvider: e.target.value }));
  $('setTime').addEventListener('change', (e) => save({ timeFormat: e.target.value }));
  $('setTop').addEventListener('change', (e) => save({ alwaysOnTop: e.target.checked }));
  $('setCompact').addEventListener('change', (e) => save({ compactMode: e.target.checked }));
  $('setStartup').addEventListener('change', (e) => save({ startWithWindows: e.target.checked }));

  $('btnSetupContinue').addEventListener('click', () => {
    const providers = {};
    for (const id of setupPick) providers[id] = { enabled: true };
    setupPick.clear();
    save({ providers });
  });
  $('btnRefresh').addEventListener('click', () => api.refresh());
  $('btnSettings').addEventListener('click', () => { settingsOpen = !settingsOpen; applyPanels(); scheduleResize(); });
  $('btnBack').addEventListener('click', () => { settingsOpen = false; applyPanels(); scheduleResize(); });
  $('btnMin').addEventListener('click', () => api.minimize());
  $('btnClose').addEventListener('click', () => api.hide());
  $('btnLogs').addEventListener('click', () => api.openLogs());
  $('updateLink').addEventListener('click', () => api.openUpdate());
  $('updateStatus').addEventListener('click', () => api.openUpdate());
  $('updateDismiss').addEventListener('click', () => api.dismissUpdate());
  $('btnKofi').addEventListener('click', () => api.openExternal('kofi'));
  $('btnGithub').addEventListener('click', () => api.openExternal('github'));

  // ---- tray icon (drawn here so the number is real, anti-aliased text) -------
  // Called from the main process via executeJavaScript; returns a PNG data URL.
  // alert = a red dot in the corner: some other tool needs attention (see pickTrayState in src/tray-text.js).
  window.__drawTrayIcon = ({ percent, warn, danger, alert }) => {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    const none = percent === null || percent === undefined;
    let bg = '#5B4BDB';
    let fg = '#FFFFFF';
    if (none) bg = '#8F8CA8';
    else if (percent >= danger) bg = '#E5484D';
    else if (percent >= warn) { bg = '#F5A623'; fg = '#1B1B1B'; }

    g.fillStyle = bg;
    g.beginPath();
    g.roundRect(0, 0, size, size, 7);
    g.fill();

    g.fillStyle = fg;
    g.strokeStyle = fg;
    if (!none && percent >= 99) {
      g.lineWidth = 5;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(9, 9); g.lineTo(23, 23);
      g.moveTo(23, 9); g.lineTo(9, 23);
      g.stroke();
    } else {
      const label = none ? '–' : String(Math.round(percent));
      g.font = `700 ${label.length >= 3 ? 16 : 23}px "Segoe UI", sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, size / 2, size / 2 + 1);
    }
    if (alert) {
      g.beginPath();
      g.arc(25, 7, 6.5, 0, Math.PI * 2);
      g.fillStyle = '#E5484D';
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = '#FFFFFF';
      g.stroke();
    }
    return canvas.toDataURL('image/png');
  };

  // App icon (taskbar / window), same artwork as the title-bar logo. Returns a PNG data URL.
  window.__drawAppIcon = (size = 256) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    g.scale(size / 32, size / 32);
    const grad = g.createLinearGradient(0, 0, 32, 32);
    grad.addColorStop(0, '#7C6CFF');
    grad.addColorStop(1, '#3B2DB8');
    g.fillStyle = grad;
    g.beginPath();
    g.roundRect(0, 0, 32, 32, 8);
    g.fill();
    g.strokeStyle = '#FFFFFF';
    g.lineWidth = 3.2;
    g.lineCap = 'round';
    g.stroke(new Path2D('M8 10h16M8 16h11M8 22h14'));
    return canvas.toDataURL('image/png');
  };

  // ---- go --------------------------------------------------------------------
  enableDragReorder($('cards'));
  // Any change in content height (late readings, panel switches, compact mode) resizes the window.
  new ResizeObserver(() => scheduleResize()).observe($('app'));
  api.onState(render);
  api.getState().then(render);
  setInterval(updateCountdowns, COUNTDOWN_REFRESH_MS);
})();

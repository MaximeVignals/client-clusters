// Phone app: state, navigation, edit actions and start-up. Screens are in views.js, storage in store.js, sync in sync.js,
// size classes in size.js, the map in map.js.
'use strict';

const App = (() => {
  const emptyProj = () => ({ clients: {}, groups: {}, prospects: {}, settings: {} });
  const normalize = p => Object.assign(emptyProj(), p || {});

  const app = {
    proj: emptyProj(), pairing: null, tab: 'today',
    // Per-screen UI state lives here (not only in the DOM) so it survives re-renders, resizes and fold/unfold:
    //  sel     = { kind: 'client' | 'prospect', id }: the one source of truth for the open item
    //            (full screen when compact, the detail pane on wider windows)
    //  sheet   = null | { kind: 'log', id } | { kind: 'picker', q } | { kind: 'call', coll, id }
    //  drafts  = unsaved text, keyed 'notes:client:<id>' | 'notes:prospect:<id>' | 'log:<id>:<field>' | 'search:prospects'
  //            (notes drafts are { base, text, conflict? }: base = the stored note when editing began, see saveNotes)
    //  scroll  = scrollTop per region + destination + selection;  mapView = { lat, lng, zoom } (written by map.js)
    ui: { sel: null, sheet: null, drafts: {}, scroll: {}, mapView: null, size: Layout.size(), pfilter: 'all', mapFilters: null, mapSheet: 'peek', hoursOpen: false, pairOpen: false, notesSaved: null },
    appearance: 'system', fatal: null, booted: false,
  };
  let toastTimer = null, toastLeft = 0, toastStart = 0, modalResolve = null, modalOpener = null, sheetKey = '', sheetOpener = null, liveState = null, mapSelKey = '';
  const INERT_ALL = ['#top', '#tabs', '#view', '#fab', '#detail', '#mapview', '#actions', '#sheet'];
  const REGIONS = { list: '#view', detail: '#detail', actions: '#actions', fab: '#fab' };
  const SCROLLERS = { list: '#view', detail: '#detail' };
  const last = {};               // region -> html last written to the DOM
  const pending = new Set();     // regions whose redraw waits because a text field inside has focus
  const keys = {};               // scroll key in effect per scrolling region

  // Unsaved text. A draft is dropped only after its normal save path succeeded.
  const drafts = app.ui.drafts;
  app.draftOr = (key, stored) => (Object.prototype.hasOwnProperty.call(drafts, key) ? drafts[key] : stored);
  const noteKey = (kind, id) => `notes:${kind}:${id}`;
  const NOTE_COLL = { client: 'clients', prospect: 'prospects' };
  // What the notes field shows: the unsaved text if the user changed something, else the stored note.
  app.noteView = (kind, id, stored) => {
    const d = drafts[noteKey(kind, id)];
    if (!d || typeof d !== 'object' || (d.text === d.base && !d.conflict)) return { text: stored, conflict: false };
    return { text: d.text, conflict: !!d.conflict };
  };
  const clearDrafts = prefix => { for (const k of Object.keys(drafts)) if (k.startsWith(prefix)) delete drafts[k]; };

  // ---------- chrome ----------
  function applyAppearance() {
    const v = app.appearance;
    if (v === 'light' || v === 'dark') document.documentElement.dataset.theme = v;
    else delete document.documentElement.dataset.theme;
  }

  // Snackbar: above the dock (compact) or the detail actions. With an action ("Annuler") it stays 10 s instead of 4 s,
  // and the timer pauses while the snackbar has hover or focus. A new message replaces the old one.
  function armToast(ms) {
    clearTimeout(toastTimer);
    toastLeft = ms; toastStart = Date.now();
    toastTimer = setTimeout(hideToast, ms);
  }
  function hideToast() { clearTimeout(toastTimer); toastTimer = null; $('#toast').hidden = true; }
  function pauseToast() {
    if (!toastTimer) return;
    clearTimeout(toastTimer); toastTimer = null;
    toastLeft = Math.max(2000, toastLeft - (Date.now() - toastStart));
  }
  function resumeToast() { if (!$('#toast').hidden && !toastTimer) armToast(toastLeft); }
  function toast(msg, actionLabel, fn) {
    const el = $('#toast');
    el.innerHTML = `<span class="msg">${U.esc(msg)}</span>${actionLabel ? '<button type="button" data-act="toast-action">' + U.esc(actionLabel) + '</button>' : ''}`;
    el.hidden = false;
    app.toastAction = fn || null;
    armToast(actionLabel ? 10000 : 4000);
  }

  // Background is inert while a sheet or dialog is open.
  function refreshInert() {
    const modal = !$('#modal').hidden, sheet = !$('#sheet').hidden;
    for (const sel of INERT_ALL) { const el = $(sel); if (el) el.inert = modal || (sheet && sel !== '#sheet' ? true : false); }
    const sb = $('#snackbar'); if (sb) sb.inert = modal || sheet;   // nothing behind a dialog or sheet can be reached, the snackbar included
  }

  const visibleMain = () => (!$('#detail').hidden && app.ui.sel ? '#detail' : '#view');

  // Only for irreversible actions (disconnect, replace pairing, remove an unplanned visit): there is no undo path for these.
  function confirmBox(message, okLabel = 'OK') {
    return new Promise(resolve => {
      modalResolve = resolve;
      modalOpener = { el: document.activeElement, key: focusKey(document.activeElement) };
      const m = $('#modal');
      m.innerHTML = `<div class="box" role="dialog" aria-modal="true" aria-label="Confirmation" aria-describedby="modal-msg"><p class="box-msg" id="modal-msg">${U.esc(message)}</p>
        <div class="btns"><button type="button" class="btn danger" data-act="modal-ok">${U.esc(okLabel)}</button><button type="button" class="btn sec" data-act="modal-cancel">Annuler</button></div></div>`;
      m.hidden = false;
      refreshInert();
      const cancel = m.querySelector('[data-act=modal-cancel]'); if (cancel) cancel.focus({ preventScroll: true });
    });
  }
  function closeModal(result) {
    $('#modal').hidden = true;
    refreshInert();
    // Focus goes back to whatever opened the dialog (it may have been redrawn meanwhile: find it again by its key).
    const o = modalOpener; modalOpener = null;
    if (o) {
      let t = o.el && o.el.isConnected ? o.el : (o.key ? document.querySelector(o.key) : null);
      if (!t) t = document.querySelector(visibleMain());
      if (t && t.focus) t.focus({ preventScroll: true });
    }
    if (modalResolve) { const r = modalResolve; modalResolve = null; r(result); }
  }

  // ---------- focus and scroll across redraws ----------
  // A selector that finds the same control again after its region was redrawn.
  function focusKey(el) {
    if (!el || el === document.body || !el.dataset) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.dataset.key) return `[data-key="${CSS.escape(el.dataset.key)}"]`;
    if (el.dataset.act == null) {
      // A control inside a [data-act] row (e.g. the row's main button): the row's key plus the control's kind.
      const host = el.closest('[data-act]');
      const hk = host && host !== el ? focusKey(host) : null;
      return hk ? hk + ' ' + (el.classList.contains('row-main') ? '.row-main' : el.tagName.toLowerCase()) : null;
    }
    return ['act', 'id', 'vid', 'v', 'status', 'tab', 'url', 'coll'].filter(k => el.dataset[k] != null).map(k => `[data-${k}="${CSS.escape(el.dataset[k])}"]`).join('');
  }
  function saveFocus(root) {
    const a = document.activeElement;
    if (!a || !root.contains(a)) return null;
    const key = focusKey(a);
    if (!key) return null;
    const rec = { key, st: a.scrollTop };
    try { rec.s = a.selectionStart; rec.e = a.selectionEnd; } catch (e) { /* not a text control */ }
    return rec;
  }
  function restoreFocus(rec, root) {
    if (!rec) return;
    const n = root.querySelector(rec.key);
    if (!n) return;
    n.focus({ preventScroll: true });
    try { if (rec.s != null) n.setSelectionRange(rec.s, rec.e); } catch (e) { /* not a text control */ }
    if (rec.st) n.scrollTop = rec.st;
  }
  // Scroll position is kept per region + destination (+ selection for the detail), not per DOM node.
  function scrollKey(region, c) {
    if (region === 'list') return `list|${app.tab}|${c.m}`;
    return `detail|${c.sel ? c.sel.kind + ':' + c.sel.id : '-'}`;
  }
  // After a size-class change the browser clamps/resets scroll positions on its own; those scroll events must not overwrite
  // the saved values. Ignore scrolling for 2 animation frames, then put the saved positions back.
  let scrollQuiet = 0, quietGen = 0;
  function quietScroll() {
    const gen = ++quietGen; scrollQuiet = 2;
    const tick = () => {
      if (gen !== quietGen) return;
      if (--scrollQuiet > 0) requestAnimationFrame(tick); else restoreScroll(compute());
    };
    requestAnimationFrame(tick);
  }
  function saveScroll() {
    for (const r of Object.keys(SCROLLERS)) { const el = $(SCROLLERS[r]); if (keys[r] && el && el.clientHeight > 0) app.ui.scroll[keys[r]] = el.scrollTop; }
  }
  function restoreScroll(c) {
    for (const r of Object.keys(SCROLLERS)) {
      const el = $(SCROLLERS[r]); keys[r] = scrollKey(r, c);
      if (!el || el.clientHeight <= 0) continue;
      const t = app.ui.scroll[keys[r]] || 0;
      if (Math.abs(el.scrollTop - t) > 1) el.scrollTop = t;
    }
  }
  let scrollRaf = 0;
  document.addEventListener('scroll', ev => {
    if (scrollQuiet || (ev.target !== $('#view') && ev.target !== $('#detail'))) return;
    if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; if (!scrollQuiet) saveScroll(); });
  }, { capture: true, passive: true });

  // ---------- bottom sheets (log a visit, client picker, phone choice) ----------
  function renderSheet() {
    const host = $('#sheet'), s = app.ui.sheet;
    let html = s ? Views.sheet(app.ui) : '';
    if (s && !html) { app.ui.sheet = null; }   // the client or prospect no longer exists
    const key = app.ui.sheet ? `${s.kind}:${s.id || ''}:${s.coll || ''}` : '';
    if (key === sheetKey) return;              // already showing: keep focus, typed text and scroll (also across resizes)
    sheetKey = key;
    if (!key) {
      host.hidden = true; host.innerHTML = '';
      PhoneMap.clearPick();
      refreshInert();
      const o = sheetOpener; sheetOpener = null;
      if (o && o.isConnected) o.focus({ preventScroll: true }); else { const t = $(visibleMain()); if (t && !t.hidden) t.focus({ preventScroll: true }); }
      return;
    }
    if (!sheetOpener) sheetOpener = document.activeElement;
    host.innerHTML = html; host.hidden = false;
    refreshInert();
    const f = host.querySelector('[data-autofocus]') || host.querySelector('input, select, textarea, button');
    if (f) f.focus({ preventScroll: true });
  }
  function closeSheet() { app.ui.sheet = null; renderSheet(); }
  // Explicit dismissal (Annuler, scrim, Escape, back) throws away the log-visit draft; a re-render or resize never does.
  function dropLogDraft() { const s = app.ui.sheet; if (s && s.kind === 'log') clearDrafts('log:' + s.id + ':'); }
  function dismissSheet() { dropLogDraft(); closeSheet(); }
  function openSheet(sheet) { app.ui.sheet = sheet; renderSheet(); }
  function openLog(id) { openSheet({ kind: 'log', id }); }

  function mode() {
    if (!app.pairing) return 'welcome';
    if (Sync.status().state === 'disconnected') return 'disconnected';
    return 'app';
  }

  // Sync pill: French text and icon chosen from the state code, never sync.js's English text. Tap = sync now (read-only
  // text when disconnected). Screen readers hear about it only when sync goes offline or fails, not on every busy/ok flip.
  function updateChip() {
    const chip = $('#chip'), st = Sync.status();
    if (mode() !== 'app' || !T.sync[st.state] || st.state === 'off') { chip.hidden = true; return; }
    chip.hidden = false;
    if (st.state !== liveState) {
      liveState = st.state;
      $('#sync-live').textContent = st.state === 'offline' || st.state === 'error' ? T.sync[st.state] : '';
    }
    if (chip.dataset.state === st.state) return;
    chip.dataset.state = st.state;
    chip.className = 'pill ' + st.state;
    chip.innerHTML = Views.syncPill(st.state);
    const readOnly = st.state === 'disconnected';
    chip.disabled = readOnly;
    chip.title = T.sync[st.state];
    chip.setAttribute('aria-label', readOnly ? T.sync[st.state] : `${T.sync[st.state]}. Toucher pour synchroniser.`);
  }

  // ---------- render ----------
  // Everything the screen shows, computed from state alone. The panes that exist depend on the size class (see phone.css):
  //  single = one pane (welcome, settings, errors) | stack = compact, one pane at a time | list = medium list | detail
  //  map = medium map (+ docked detail) | x = expanded (list | map over detail); also used with a hinge or tabletop fold
  function compute() {
    const m = mode(), size = Layout.size(), seg = Layout.segments(), compact = size === 'compact';
    let lay;
    if (m !== 'app' || app.fatal || app.tab === 'settings') lay = 'single';
    else if (compact) lay = 'stack';
    else if (size === 'expanded' || seg.h || seg.v) lay = 'x';
    else lay = app.tab === 'map' ? 'map' : 'list';
    const sel = lay !== 'single' ? app.ui.sel : null;
    let vList = false, vDetail = false, vMap = false;
    if (lay === 'single') vList = true;
    else if (lay === 'stack') { vDetail = !!sel; vMap = !sel && app.tab === 'map'; vList = !sel && app.tab !== 'map'; }
    else if (lay === 'x') { vList = vMap = true; vDetail = !!sel || app.tab !== 'map'; }   // Carte with nothing open: the map takes the whole right pane
    else if (lay === 'list') vList = vDetail = true;
    else { vMap = true; vDetail = !!sel; }

    let title = T.appName, list = '', detail = '';
    if (app.fatal) list = Views.fatal(app.fatal);
    else if (m === 'welcome') list = Views.welcome();
    else if (m === 'disconnected') { list = Views.disconnected(); title = 'Déconnecté'; }
    else {
      title = T.tabs[app.tab];
      list = app.tab === 'today' ? Views.today() : app.tab === 'prospects' ? Views.prospects() : app.tab === 'settings' ? Views.settings() : Views.mapList();
      if (sel) {
        const e = (sel.kind === 'client' ? app.proj.clients : app.proj.prospects)[sel.id];
        if (compact) title = e ? e.name : (sel.kind === 'client' ? 'Client' : 'Prospect');   // wider windows keep the destination title
        detail = sel.kind === 'client' ? Views.client(sel.id) : Views.prospect(sel.id);
      } else if (vDetail) detail = Views.detailEmpty();
    }
    if (!sel && vDetail && Views.isEmptyProject()) vDetail = false;   // nothing to choose from: no placeholder
    const actions = app.fatal ? '' : Views.bar({ mode: m, sel });
    const fab = m === 'app' && !app.fatal && app.tab === 'today' && Views.hasClients() ? Views.fab() : '';
    return { m, size, compact, lay, sel, vList, vDetail, vMap, title, html: { list, detail, actions, fab } };
  }

  // Redraw one region only if its HTML changed. While a text field inside it has focus the redraw waits (typed text and
  // caret stay put); it is applied when the field loses focus. Focus and caret are restored after a redraw.
  function patch(name, html) {
    const el = $(REGIONS[name]);
    if (last[name] === html) { pending.delete(name); return; }
    const a = document.activeElement;
    if (a && el.contains(a) && /^(TEXTAREA|INPUT|SELECT)$/.test(a.tagName)) { pending.add(name); return; }
    pending.delete(name);
    const f = saveFocus(el);
    last[name] = html;
    el.innerHTML = html;
    restoreFocus(f, el);
  }

  function render(opts) {
    const c = compute(), top = c.sel, body = document.body;
    if (!(opts && opts.keepScroll)) saveScroll();   // after a size-class change the positions are already disturbed
    body.dataset.mode = c.m;
    body.dataset.screen = c.m === 'app' ? (c.compact && top ? 'detail' : app.tab) : c.m;
    body.dataset.lay = c.lay;
    body.dataset.sel = top ? '1' : '0';
    body.dataset.empty = !top && Views.isEmptyProject() ? '1' : '0';
    body.dataset.fab = c.html.fab ? '1' : '0';
    app.ui.size = c.size;
    $('#view').removeAttribute('aria-busy');   // the start-up skeleton (index.html) is replaced by the first render
    $('#view').hidden = !c.vList; $('#detail').hidden = !c.vDetail; $('#mapview').hidden = !c.vMap;
    const docked = c.size === 'medium' && Layout.narrow() && (c.lay === 'list' || c.lay === 'map');   // detail docked over the list/map
    $('#back').hidden = !(top && (c.compact || docked));
    document.querySelectorAll('#tabs button').forEach(b => {
      const on = b.dataset.tab === app.tab && !(c.compact && top);
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $('#title').textContent = c.title;
    for (const r of Object.keys(REGIONS)) patch(r, c.html[r]);
    $('#actions').hidden = !c.html.actions; $('#fab').hidden = !c.html.fab;
    if (c.vMap) PhoneMap.show();
    const mk = top ? top.kind + ':' + top.id : '';
    if (mk !== mapSelKey) { mapSelKey = mk; PhoneMap.select(top && top.kind, top && top.id); }
    PhoneMap.afterRender();
    updateChip();
    renderSheet();
    syncDockHeight();
    restoreScroll(c);
  }

  // Compact: content and the snackbar clear the dock (action bar + navigation), whatever its height (font scale, wrapped buttons).
  // Wider windows have no dock; only the detail action bar matters (for the snackbar).
  function syncDockHeight() {
    const st = document.documentElement.style, act = $('#actions'), fab = $('#fab'), compact = Layout.size() === 'compact';
    const h = el => (el && !el.hidden ? el.offsetHeight : 0);
    const tabsH = compact ? h($('#tabs')) : 0;
    st.setProperty('--tabs-h', tabsH + 'px');
    st.setProperty('--dock-h', (tabsH + (compact ? Math.max(h(fab), h(act)) : 0)) + 'px');   // the two bars never show together in compact
    st.setProperty('--actions-h', h(act) + 'px');
    const fb = fab && fab.querySelector('.btn');
    st.setProperty('--fab-h', (fb && !fab.hidden ? fb.offsetHeight : 0) + 'px');
  }
  // Tab order = visual order: the navigation comes right after the app bar (it is the rail on wider windows) and moves to the
  // end of the body in compact, where it is the bottom bar.
  function placeTabs() {
    const tabs = $('#tabs'), before = Layout.size() === 'compact' ? $('#actions') : $('#top');
    if (before.nextElementSibling === tabs) return;
    const had = tabs.contains(document.activeElement) ? document.activeElement : null;
    before.after(tabs);
    if (had) had.focus({ preventScroll: true });
  }

  // ---------- navigation ----------
  // Compact shows the open item full screen, so focus follows it (and returns to the list on back). Wider windows keep focus where it is.
  const focusPane = () => { if (Layout.size() === 'compact') { const t = $(visibleMain()); if (t) t.focus({ preventScroll: true }); } };
  // A notes field being edited is saved before the screen changes: blur() runs the focusout handler synchronously, so the save
  // starts with the id of the item still open (and the later removal of the field cannot save a second time).
  function flushNotes() {
    const a = document.activeElement;
    if (a && (a.id === 'notes' || a.id === 'pnotes') && typeof a.blur === 'function') a.blur();
  }
  function go(tab) {
    flushNotes();
    if (tab === app.tab && !app.ui.sel) app.ui.scroll[`list|${tab}|app`] = 0;   // tapping the current destination scrolls it to the top
    dropLogDraft();
    app.tab = tab; app.ui.sel = null; app.ui.sheet = null; render();
  }
  function select(sel, opts) {
    flushNotes();
    dropLogDraft();
    app.ui.sel = sel;
    app.ui.sheet = null; app.ui.notesSaved = null;
    if (opts && opts.log) app.ui.sheet = { kind: 'log', id: sel.id };
    if (!(opts && opts.fromMap) && PhoneMap.ready) PhoneMap.wantReveal(sel, opts && opts.zoom ? 'zoom' : 'pan');   // a list tap brings the marker into view; only the map lists zoom
    render();
    if (Layout.size() === 'compact') focusPane();
    else if (!(opts && opts.log)) { const h = $('#detail-title'); if (h) h.focus({ preventScroll: true }); }   // user-initiated only (never on resize or sync)
  }
  const openClient = (id, opts) => select({ kind: 'client', id }, opts);
  const openProspect = (id, opts) => select({ kind: 'prospect', id }, opts);
  // Android back, in order: confirmation, sheet, open item (compact: pops the detail; wider: clears the selection).
  function back() {
    flushNotes();
    if (!$('#modal').hidden) { closeModal(false); return true; }
    if (app.ui.sheet) { dismissSheet(); return true; }
    if (app.ui.sel) { app.ui.sel = null; app.ui.notesSaved = null; render(); focusPane(); return true; }
    return false;
  }

  // ---------- data ----------
  const handlers = {
    getProj: () => app.proj,
    async applyWin(ops) { SyncOps.applyToProj(app.proj, ops); await Store.saveData(app.proj); render(); if (PhoneMap.ready) PhoneMap.refresh(); },
    async applySnapshot(p) { app.proj = normalize(p); await Store.saveData(app.proj); render(); if (PhoneMap.ready) PhoneMap.refresh(); },
  };

  // Save, record the change for sync, redraw, and schedule a sync.
  async function commit(rerender = true) {
    await Store.saveData(app.proj);
    try { await Sync.capture(() => app.proj); } catch (e) { console.error('capture', e); }
    Sync.schedule(handlers, 3000);
    if (rerender) render();
    if (PhoneMap.ready) PhoneMap.refresh();
  }

  // The shared visit rules work on an array of visits; the projection keeps visits keyed by id.
  function withVisits(c, fn) {
    const tmp = { visits: Object.values(c.visits || {}) };
    const r = fn(tmp);
    const next = {};
    for (const v of tmp.visits) next[v.id] = v;
    c.visits = next;
    return r;
  }

  const visitOf = el => { const c = app.proj.clients[el.dataset.id]; return c ? [c, (c.visits || {})[el.dataset.vid]] : []; };

  async function markDone(c, v) {
    const t = U.todayISO();
    if ((v.type || 'visit') === 'visit') withVisits(c, tmp => Visits.recordVisit(tmp, { date: v.date, note: v.note || '', type: 'visit', outcome: v.outcome || '', status: 'done' }, t, U.uid));
    else Object.assign(v, { status: 'done', confirmedFrom: 'planned' });
    await commit();
    toast('Visite marquée faite', 'Annuler', async () => { withVisits(c, tmp => Visits.undoDone(tmp, v)); await commit(); });
  }

  async function pair(code) {
    let p;
    try { p = SyncCrypto.decodePairing(code); } catch (e) { toast('Ce n’est pas un code d’appairage Client Clusters.'); return; }
    if (!p.deviceId || !p.pcDeviceId) { toast('Ce code ne contient pas les informations de l’appareil. Mettez à jour l’application Windows, puis créez un nouveau code.'); return; }
    if (app.pairing && app.pairing.pcDeviceId === p.pcDeviceId) {
      // Same PC (for example after it removed this phone): keep the data and any unsent changes, send them after pairing.
      await Store.write('pairing.json', p);
      app.pairing = p;
      Sync.init(p);
      render();
      toast('Appairé à nouveau avec ' + (p.name || 'votre PC'));
      await Sync.run(handlers);
      render();
      return;
    }
    if (app.pairing && !(await confirmBox('Ce code vient d’un autre PC. Remplacer l’appairage actuel ? Les données stockées sur ce téléphone, y compris les changements non envoyés, seront d’abord supprimées.', 'Remplacer'))) return;
    if (app.pairing) await wipe();
    await Store.write('pairing.json', p);
    app.pairing = p; app.proj = emptyProj(); app.ui.sel = null; app.tab = 'today';
    await Store.saveData(app.proj);
    Sync.init(p);
    render();
    toast('Appairé avec ' + (p.name || 'votre PC'));
    await Sync.run(handlers);
    render();
  }

  async function wipe() {
    Sync.reset();
    await Promise.all(['data.json', 'engine.json', 'pairing.json'].map(f => Store.remove(f)));
    app.pairing = null; app.proj = emptyProj(); app.ui.sel = null; app.ui.sheet = null; app.tab = 'today';
    for (const k of Object.keys(drafts)) delete drafts[k];   // unsaved text belonged to the deleted data
  }

  async function scan() {
    const P = window.Capacitor.Plugins, S = P.CapacitorBarcodeScanner || P.BarcodeScanner;
    if (!S) { toast('Le scanner n’est pas disponible. Collez le code à la place.'); return; }
    try {
      const r = await S.scanBarcode({ hint: 0 }); // 0 = QR code
      const text = r && (r.ScanResult || r.scanResult);
      if (text) await pair(text);
    } catch (e) { toast('Scan annulé ou caméra non autorisée. Vous pouvez coller le code à la place.'); }
  }

  async function openExternal(url) {
    const L = window.Capacitor.Plugins.AppLauncher;
    try { if (!L) throw new Error('no launcher'); await L.openUrl({ url }); }
    catch (e) { toast(url.startsWith('tel:') ? 'Impossible d’ouvrir l’application Téléphone.' : 'Impossible d’ouvrir l’application de cartes.'); }
  }

  // ---------- events ----------
  const actions = {
    back, 'tab': el => go(el.dataset.tab),
    'open-client': el => openClient(el.dataset.id),
    'open-prospect': el => openProspect(el.dataset.id),
    // map: "Sur la carte" rows, filter chips, bottom sheet, overlap pick-list
    'os-open': el => (el.dataset.kind === 'client' ? openClient(el.dataset.id, { zoom: true }) : openProspect(el.dataset.id, { zoom: true })),
    // "Voir sur la carte" in the detail header: compact goes to the Carte tab (the item is no longer open there)
    'show-on-map': el => {
      const kind = el.dataset.kind, id = el.dataset.id;
      flushNotes();
      if (Layout.size() === 'compact') { dropLogDraft(); app.tab = 'map'; app.ui.sel = null; app.ui.sheet = null; render(); }
      else if (document.body.dataset.lay === 'list') { app.tab = 'map'; render(); }
      PhoneMap.focus(kind, id);
    },
    'map-filter': el => PhoneMap.toggle(el.dataset.f),
    'map-reset': () => PhoneMap.reset(),
    'os-toggle': () => PhoneMap.toggleSheet(),
    'pick-spiderfy': () => { PhoneMap.spiderfyPicked(); closeSheet(); },
    'sync-now': async () => {
      if (!Sync.active) { toast('Ce téléphone n’est pas encore appairé. Appairez-le dans Réglages.'); return; }
      if (navigator.onLine === false) { toast('Pas de connexion. Les changements sont conservés et seront envoyés plus tard.'); }
      await Sync.run(handlers);
    },
    'toast-action': async () => { const f = app.toastAction; hideToast(); if (f) await f(); },
    'modal-ok': () => closeModal(true), 'modal-cancel': () => closeModal(false),
    'sheet-close': dismissSheet,
    'notes-keep': async el => {   // keep my text: saved through the normal path, as if the PC had not changed the note
      const d = drafts[noteKey(el.dataset.kind, el.dataset.id)];
      if (d) await writeNotes(el.dataset.kind, el.dataset.id, d.text, true);
    },
    'notes-discard': el => { delete drafts[noteKey(el.dataset.kind, el.dataset.id)]; app.ui.notesSaved = null; render(); focusNotesHeading(); },
    'picker-open': () => openSheet({ kind: 'picker', q: '' }),
    'pick-client': el => { app.ui.sheet = null; openClient(el.dataset.id, { log: true }); },
    'call-choose': el => openSheet({ kind: 'call', coll: el.dataset.coll, id: el.dataset.id }),
    'log-open': el => { const id = el.dataset.id || (app.ui.sel && app.ui.sel.id); if (id) openLog(id); },
    'log-save': async el => {
      const c = app.proj.clients[el.dataset.id]; if (!c) return;
      const date = $('#lv-date').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Indiquez la date de la visite.'); return; }
      const opts = { date, type: $('#lv-type').value, outcome: $('#lv-outcome').value, note: $('#lv-note').value.trim() };
      withVisits(c, tmp => Visits.recordVisit(tmp, opts, U.todayISO(), U.uid));
      closeSheet();
      await commit();
      clearDrafts('log:' + c.id + ':');   // only once the visit is saved
      toast(date > U.todayISO() ? 'Visite prévue enregistrée' : 'Visite enregistrée');
    },
    'visit-done': async el => { const inH = !!el.closest('#history'), [c, v] = visitOf(el); if (v) await markDone(c, v); keepHistoryFocus(inH); },
    'visit-cancel': async el => {
      const inH = !!el.closest('#history'), [c, v] = visitOf(el); if (!v) return;
      v.status = 'cancelled'; await commit(); keepHistoryFocus(inH);
      toast('Visite marquée ' + T.q('pas eu lieu'), 'Annuler', async () => { v.status = 'planned'; await commit(); });
    },
    'visit-replan': async el => { const inH = !!el.closest('#history'), [c, v] = visitOf(el); if (v) { v.status = 'planned'; await commit(); keepHistoryFocus(inH); } },
    'visit-undo': async el => {
      const inH = !!el.closest('#history'), [c, v] = visitOf(el); if (!v) return;
      // No undo path for removing a directly logged visit, so this one keeps its confirmation.
      if (v.confirmedFrom !== 'planned' && !(await confirmBox('Retirer cette visite de l’historique ?', 'Retirer la visite'))) return;
      withVisits(c, tmp => Visits.undoDone(tmp, v)); await commit(); keepHistoryFocus(inH);
    },
    'pstatus': async el => {
      const p = app.proj.prospects[el.dataset.id];
      if (!p || p.status === el.dataset.status) return;
      // The raw previous status may be undefined (never set). Undo puts back 'todo' in that case: the sync rules accept
      // only the four known statuses, so "no status" cannot be written back without a store/sync change.
      const id = p.id, prev = p.status || 'todo', next = el.dataset.status;
      p.status = next; await commit();
      const meta = Views.PROSPECT_STATUS[next];
      toast('Statut' + T.NB + ': ' + (meta ? meta.label : next), 'Annuler', async () => {
        const q = app.proj.prospects[id];
        if (q) { q.status = prev; await commit(); }
      });
    },
    'pfilter': el => { app.ui.pfilter = el.dataset.v; refreshProspectList(); },
    'clear-search': () => { delete drafts['search:prospects']; const i = $('#psearch'); if (i) { i.value = ''; i.focus({ preventScroll: true }); } refreshProspectList(); },
    'navigate': el => openExternal(el.dataset.url),
    'call': el => { closeSheet(); return openExternal(el.dataset.url); },
    'scan': scan,
    'paste-pair': () => pair($('#paste').value),
    'appearance': el => { app.appearance = el.dataset.v; try { localStorage.setItem('appearance', app.appearance); } catch (e) { /* ignore */ } applyAppearance(); render(); },
    'disconnect': async () => {
      if (!(await confirmBox('Déconnecter ce téléphone ? Toutes les données clients stockées sur ce téléphone seront supprimées. Les changements pas encore envoyés au PC seront aussi supprimés. Les données de votre PC ne sont pas touchées.', 'Supprimer et déconnecter'))) return;
      await wipe(); app.fatal = null; render(); toast('Téléphone déconnecté');   // also the way out of the "data unreadable" screen
    },
  };

  // A history button (Fait, Annuler, Replanifier) is replaced by a different one once used: if focus fell to the page,
  // move it to the "Historique" heading so keyboard and screen-reader users stay in place.
  function keepHistoryFocus(wasInHistory) {
    if (!wasInHistory) return;
    const a = document.activeElement, h = $('#h-history');
    if (h && (!a || a === document.body || !a.isConnected)) h.focus({ preventScroll: true });
  }
  function focusNotesHeading() { const h = $('#h-notes'); if (h) h.focus({ preventScroll: true }); }

  // Prospect list: chips and rows are redrawn in place (the search field keeps focus and its text).
  function refreshProspectList() {
    const chips = $('#pchips'), list = $('#plist');
    if (!chips || !list) return;
    const focused = document.activeElement && chips.contains(document.activeElement) ? document.activeElement.dataset.v : null;
    chips.innerHTML = Views.prospectChips();
    list.innerHTML = Views.prospectRows(app.draftOr('search:prospects', ''));
    if (focused) { const b = chips.querySelector(`[data-v="${focused}"]`); if (b) b.focus({ preventScroll: true }); }
    last.list = Views.prospects();   // the region now matches what render() would write
  }

  document.addEventListener('click', ev => {
    const el = ev.target.closest('[data-act]');
    if (!el || !actions[el.dataset.act]) return;
    if (el.dataset.act === 'notes-keep' && ev.detail > 0) return;   // already handled on pointerdown (keyboard clicks have detail 0)
    Promise.resolve(actions[el.dataset.act](el, ev)).catch(e => { console.error(e); app.lastActionError = String((e && e.message) || e || ''); toast('L’action n’a pas abouti. Réessayez.'); });
  });

  // « Garder mon texte »: the textarea's blur redraws the notice and would replace the button before a click lands, so a pointer press
  // acts at once and keeps the focus where it is.
  let keepBusy = false;
  function onKeepPress(ev) {
    const el = ev.target.closest && ev.target.closest('[data-act=notes-keep]');
    if (!el) return;
    ev.preventDefault();
    if (ev.type === 'mousedown' || keepBusy) return;   // pointerdown already acted (mousedown only prevents the focus change)
    keepBusy = true;
    Promise.resolve(actions['notes-keep'](el)).catch(notesFailed).finally(() => { keepBusy = false; });
  }
  document.addEventListener('pointerdown', onKeepPress);
  document.addEventListener('mousedown', onKeepPress);

  // Notes: saved when the field loses focus, with a quiet "Enregistré" confirmation. The draft goes once the save worked.
  // A notes draft remembers the stored note it started from (base). If a sync changed the stored note meanwhile, the user's
  // text is NOT written over it: the draft is kept, a notice offers "Garder mon texte" / "Reprendre celle du PC".
  function notesFailed(err) {
    console.error(err);
    app.lastActionError = String((err && err.message) || err || '');
    toast('La note n’a pas été enregistrée. Elle sera réessayée.');
  }
  async function writeNotes(kind, id, text, full) {
    const coll = NOTE_COLL[kind], key = noteKey(kind, id), e = app.proj[coll][id];
    if (!e) return;
    const had = 'notes' in e, remote = e.notes || '';
    e.notes = text;
    try { await commit(false); }
    catch (err) {
      // Not saved: undo the in-memory change, keep the text, and use the note we just saw as the base for the next try.
      const cur = app.proj[coll][id];
      if (cur) { if (had) cur.notes = remote; else delete cur.notes; }
      drafts[key] = { base: remote, text };
      throw err;
    }
    delete drafts[key];
    // The save took a moment: only touch the screen if the same item is still the one open.
    const sel = app.ui.sel, still = !!sel && sel.kind === kind && sel.id === id;
    if (!still) return;
    app.ui.notesSaved = id;
    if (full) { render(); focusNotesHeading(); return; }
    const ta = $(kind === 'client' ? '#notes' : '#pnotes'), s = $('#notes-status');
    if (ta && ta.dataset.id === id && s) {
      s.innerHTML = Icon.svg('i-check') + 'Enregistré';
      if (!pending.has('detail')) last.detail = compute().html.detail;   // the field already shows the saved text
    }
  }
  async function saveNotes(el, kind) {
    const id = el.dataset.id, key = noteKey(kind, id), e = app.proj[NOTE_COLL[kind]][id];
    if (!e) return;
    const stored = e.notes || '', text = el.value, d = drafts[key];
    if (text === stored) { delete drafts[key]; return; }
    if (d && typeof d === 'object') {
      if (text === d.base) { delete drafts[key]; render(); return; }                           // not edited: show the newer note
      if (d.base !== stored) { d.text = text; d.conflict = true; render(); return; }          // changed on the PC meanwhile
    }
    await writeNotes(kind, id, text, false);
  }
  // Editing starts: remember which stored note the text comes from.
  document.addEventListener('focusin', ev => {
    const t = ev.target;
    if (t.id !== 'notes' && t.id !== 'pnotes') return;
    const kind = t.id === 'notes' ? 'client' : 'prospect', key = noteKey(kind, t.dataset.id), e = app.proj[NOTE_COLL[kind]][t.dataset.id];
    if (!drafts[key] && e) drafts[key] = { base: e.notes || '', text: t.value };
  });
  document.addEventListener('focusout', ev => {
    const t = ev.target;
    if (t.id === 'notes') saveNotes(t, 'client').catch(notesFailed);
    else if (t.id === 'pnotes') saveNotes(t, 'prospect').catch(notesFailed);
    if (pending.size) setTimeout(() => { if (pending.size) render(); }, 300);
  });
  // Every text field is mirrored into app.ui.drafts as it is typed.
  const LOG_FIELDS = { 'lv-date': 'date', 'lv-type': 'type', 'lv-outcome': 'outcome', 'lv-note': 'note' };
  function onField(ev) {
    const t = ev.target;
    if (t.id === 'psearch') { drafts['search:prospects'] = t.value; refreshProspectList(); }
    else if (t.id === 'cpick-q') { if (app.ui.sheet) app.ui.sheet.q = t.value; $('#cpick-list').innerHTML = Views.pickerRows(t.value); }
    else if (LOG_FIELDS[t.id] && app.ui.sheet && app.ui.sheet.kind === 'log') drafts[`log:${app.ui.sheet.id}:${LOG_FIELDS[t.id]}`] = t.value;
    else if (t.id === 'notes' || t.id === 'pnotes') {
      const kind = t.id === 'notes' ? 'client' : 'prospect', key = noteKey(kind, t.dataset.id), d = drafts[key], e = app.proj[NOTE_COLL[kind]][t.dataset.id];
      if (d) d.text = t.value; else drafts[key] = { base: e ? e.notes || '' : '', text: t.value };
      app.ui.notesSaved = null; const s = $('#notes-status'); if (s) s.textContent = '';
    }
  }
  document.addEventListener('input', onField);
  document.addEventListener('change', onField);
  // <details> state (opening hours, pairing) is kept in app.ui so it survives a redraw.
  document.addEventListener('toggle', ev => {
    if (ev.target.id === 'hours-d') app.ui.hoursOpen = ev.target.open;
    else if (ev.target.id === 'pair-d') app.ui.pairOpen = ev.target.open;
  }, true);
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    if (!$('#modal').hidden) closeModal(false); else if (app.ui.sheet) dismissSheet();
  });
  const toastEl = $('#toast');
  toastEl.addEventListener('mouseenter', pauseToast); toastEl.addEventListener('focusin', pauseToast);
  toastEl.addEventListener('mouseleave', resumeToast); toastEl.addEventListener('focusout', resumeToast);
  if (window.ResizeObserver) { const ro = new ResizeObserver(syncDockHeight); ['#tabs', '#fab', '#actions'].forEach(s => ro.observe($(s))); }
  // Folding, unfolding or rotating only changes the size class: redraw from state (regions whose HTML is unchanged are untouched).
  placeTabs();
  Layout.onChange(() => { placeTabs(); if (app.booted) { quietScroll(); render({ keepScroll: true }); } });

  // Pull to refresh.
  let pullY = null;
  const view = $('#view');
  view.addEventListener('touchstart', e => { pullY = view.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null; }, { passive: true });
  view.addEventListener('touchend', e => {
    if (pullY !== null && e.changedTouches[0].clientY - pullY > 90 && view.scrollTop <= 0) actions['sync-now']();
    pullY = null;
  }, { passive: true });

  // ---------- start ----------
  async function boot() {
    try { app.appearance = localStorage.getItem('appearance') || 'system'; } catch (e) { /* ignore */ }
    applyAppearance();
    Sync.onChange(() => { render(); });
    try {
      app.pairing = await Store.read('pairing.json');
      if (app.pairing) {
        app.proj = normalize(await Store.read('data.json'));
        Sync.init(app.pairing);
        await Sync.capture(() => app.proj).catch(e => console.error('capture', e));
      }
    } catch (e) { app.fatal = (e && e.message) || String(e); }
    app.booted = true;
    render();
    const A = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (A) {
      A.addListener('resume', () => { if (Sync.active) Sync.run(handlers); });
      // Close a dialog, sheet or open item first and never leave the app in the same press; leave only from Aujourd’hui with nothing open.
      A.addListener('backButton', () => {
        if (back()) return;
        if (app.tab !== 'today') { go('today'); return; }
        A.exitApp();
      });
    }
    if (Sync.active) Sync.run(handlers);
    app.ready = true;
  }

  Object.assign(app, { render, go, openClient, openProspect, toast, boot, handlers,
    openPick: items => openSheet({ kind: 'pick', id: items.map(i => i.kind[0] + i.id).join(','), items }) });

  // Demo mode only (dev/demo.js sets __DEMO__): a state snapshot to compare before and after a fold, and whether the
  // WebView supports the Viewport Segments API (hinge/tabletop layouts).
  if (window.__DEMO__) {
    window.__state = () => JSON.parse(JSON.stringify({
      size: Layout.size(), tab: app.tab, lay: document.body.dataset.lay, sel: app.ui.sel, drafts: app.ui.drafts,
      scroll: app.ui.scroll, mapView: app.ui.mapView, sheet: app.ui.sheet, segments: Layout.segments(),
    }));
    console.info('[demo] viewport segments API: ' + (Layout.supported ? 'supported' : 'NOT supported') + ', segments now ' + JSON.stringify(Layout.segments()) + ', size ' + Layout.size());
  }
  return app;
})();

App.boot();

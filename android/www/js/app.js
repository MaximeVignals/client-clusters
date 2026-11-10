// Phone app: state, navigation, edit actions and start-up. Screens are in views.js, storage in store.js, sync in sync.js.
'use strict';

const App = (() => {
  const emptyProj = () => ({ clients: {}, groups: {}, prospects: {}, settings: {} });
  const normalize = p => Object.assign(emptyProj(), p || {});
  const TITLES = { today: 'Today', map: 'Map', prospects: 'Prospects', settings: 'Settings' };

  const app = {
    proj: emptyProj(), pairing: null, tab: 'today', stack: [], ui: { logOpen: false, pq: '' },
    appearance: 'system', fatal: null, dirty: false,
  };
  let toastTimer = null, modalResolve = null;

  // ---------- chrome ----------
  function applyAppearance() {
    const v = app.appearance;
    if (v === 'light' || v === 'dark') document.documentElement.dataset.theme = v;
    else delete document.documentElement.dataset.theme;
  }

  function toast(msg, actionLabel, fn) {
    const el = $('#toast');
    el.innerHTML = `<span>${U.esc(msg)}</span>${actionLabel ? '<button data-act="toast-action">' + U.esc(actionLabel) + '</button>' : ''}`;
    el.hidden = false;
    app.toastAction = fn || null;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, actionLabel ? 8000 : 4000);
  }

  function confirmBox(message, okLabel = 'OK') {
    return new Promise(resolve => {
      modalResolve = resolve;
      const m = $('#modal');
      m.innerHTML = `<div class="box" role="dialog" aria-modal="true"><p style="margin-top:0">${U.esc(message)}</p>
        <div class="btns"><button class="btn danger" data-act="modal-ok">${U.esc(okLabel)}</button><button class="btn sec" data-act="modal-cancel">Cancel</button></div></div>`;
      m.hidden = false;
    });
  }
  function closeModal(result) {
    $('#modal').hidden = true;
    if (modalResolve) { const r = modalResolve; modalResolve = null; r(result); }
  }

  function mode() {
    if (!app.pairing) return 'welcome';
    if (Sync.status().state === 'disconnected') return 'disconnected';
    return 'app';
  }

  function updateChip() {
    const chip = $('#chip'), st = Sync.status();
    if (mode() !== 'app') { chip.hidden = true; return; }
    chip.hidden = false;
    chip.className = 'chip ' + ({ ok: 'ok', busy: 'busy', offline: 'offline', error: 'error' }[st.state] || '');
    chip.textContent = st.text;
    chip.title = st.text;
  }

  // ---------- render ----------
  function render() {
    const ae = document.activeElement;
    if (ae && $('#view').contains(ae) && /^(TEXTAREA|INPUT|SELECT)$/.test(ae.tagName) && ae.id !== 'psearch') { app.dirty = true; updateChip(); return; }
    app.dirty = false;
    const m = mode(), top = app.stack[app.stack.length - 1];
    document.body.dataset.mode = m;
    const view = $('#view'), mapview = $('#mapview');
    const showMap = m === 'app' && app.tab === 'map' && !top;
    view.hidden = showMap; mapview.hidden = !showMap;
    $('#back').hidden = !(m === 'app' && top);
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === app.tab));
    let title = 'Client Clusters', html = '';
    if (app.fatal) html = `<div class="card"><strong>Could not read the saved data.</strong><p class="muted">${U.esc(app.fatal)}</p></div>`;
    else if (m === 'welcome') html = Views.welcome();
    else if (m === 'disconnected') { html = Views.disconnected(); title = 'Disconnected'; }
    else if (top && top.name === 'client') { const c = app.proj.clients[top.id]; title = c ? c.name : 'Client'; html = Views.client(top.id); }
    else if (top && top.name === 'prospect') { const p = app.proj.prospects[top.id]; title = p ? p.name : 'Prospect'; html = Views.prospect(top.id); }
    else {
      title = TITLES[app.tab];
      if (app.tab === 'today') html = Views.today();
      else if (app.tab === 'prospects') html = Views.prospects();
      else if (app.tab === 'settings') html = Views.settings();
    }
    $('#title').textContent = title;
    if (!showMap || !view.innerHTML) view.innerHTML = html;
    if (showMap) PhoneMap.show();
    updateChip();
  }

  // ---------- navigation ----------
  function go(tab) { app.tab = tab; app.stack = []; app.ui.logOpen = false; render(); $('#view').scrollTop = 0; }
  function openClient(id) { app.stack.push({ name: 'client', id }); app.ui.logOpen = false; render(); $('#view').scrollTop = 0; }
  function openProspect(id) { app.stack.push({ name: 'prospect', id }); render(); $('#view').scrollTop = 0; }
  function back() { if (app.stack.length) { app.stack.pop(); app.ui.logOpen = false; render(); return true; } return false; }

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
    toast('Marked done', 'Undo', async () => { withVisits(c, tmp => Visits.undoDone(tmp, v)); await commit(); });
  }

  async function pair(code) {
    let p;
    try { p = SyncCrypto.decodePairing(code); } catch (e) { toast(e.message || 'Not a Client Clusters pairing code'); return; }
    if (!p.deviceId || !p.pcDeviceId) { toast('This code is missing device information. Update the Windows app, then create a new code.'); return; }
    if (app.pairing && app.pairing.pcDeviceId === p.pcDeviceId) {
      // Same PC (for example after it removed this phone): keep the data and any unsent changes, send them after pairing.
      await Store.write('pairing.json', p);
      app.pairing = p;
      Sync.init(p);
      render();
      toast('Paired again with ' + (p.name || 'your PC'));
      await Sync.run(handlers);
      render();
      return;
    }
    if (app.pairing && !(await confirmBox('This code is from a different PC. Replace the current pairing? Data stored on this phone, including changes not yet sent, will be deleted first.', 'Replace'))) return;
    if (app.pairing) await wipe();
    await Store.write('pairing.json', p);
    app.pairing = p; app.proj = emptyProj(); app.stack = []; app.tab = 'today';
    await Store.saveData(app.proj);
    Sync.init(p);
    render();
    toast('Paired with ' + (p.name || 'your PC'));
    await Sync.run(handlers);
    render();
  }

  async function wipe() {
    Sync.reset();
    await Promise.all(['data.json', 'engine.json', 'pairing.json'].map(f => Store.remove(f)));
    app.pairing = null; app.proj = emptyProj(); app.stack = []; app.tab = 'today';
  }

  async function scan() {
    const P = window.Capacitor.Plugins, S = P.CapacitorBarcodeScanner || P.BarcodeScanner;
    if (!S) { toast('The camera scanner is not available. Paste the code instead.'); return; }
    try {
      const r = await S.scanBarcode({ hint: 0 }); // 0 = QR code
      const text = r && (r.ScanResult || r.scanResult);
      if (text) await pair(text);
    } catch (e) { toast('Scan cancelled or camera not allowed. You can paste the code instead.'); }
  }

  async function openExternal(url) {
    const L = window.Capacitor.Plugins.AppLauncher;
    try { if (!L) throw new Error('no launcher'); await L.openUrl({ url }); }
    catch (e) { toast('Could not open ' + (url.startsWith('tel:') ? 'the phone app.' : 'the maps app.')); }
  }

  // ---------- events ----------
  const actions = {
    back, 'tab': el => go(el.dataset.tab),
    'open-client': el => openClient(el.dataset.id),
    'open-prospect': el => openProspect(el.dataset.id),
    'sync-now': async () => {
      if (!Sync.active) { toast('Not paired yet.'); return; }
      if (navigator.onLine === false) { toast('No connection. Changes are kept and sent later.'); }
      await Sync.run(handlers);
    },
    'toast-action': async () => { const f = app.toastAction; $('#toast').hidden = true; if (f) await f(); },
    'modal-ok': () => closeModal(true), 'modal-cancel': () => closeModal(false),
    'log-open': () => { app.ui.logOpen = true; render(); },
    'log-cancel': () => { app.ui.logOpen = false; render(); },
    'log-save': async el => {
      const c = app.proj.clients[el.dataset.id]; if (!c) return;
      const date = $('#lv-date').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Pick a date.'); return; }
      const opts = { date, type: $('#lv-type').value, outcome: $('#lv-outcome').value, note: $('#lv-note').value.trim() };
      withVisits(c, tmp => Visits.recordVisit(tmp, opts, U.todayISO(), U.uid));
      app.ui.logOpen = false;
      await commit();
      toast(date > U.todayISO() ? 'Planned visit saved' : 'Visit logged');
    },
    'visit-done': async el => { const [c, v] = visitOf(el); if (v) await markDone(c, v); },
    'visit-cancel': async el => {
      const [c, v] = visitOf(el); if (!v) return;
      v.status = 'cancelled'; await commit();
      toast("Marked as didn't happen", 'Undo', async () => { v.status = 'planned'; await commit(); });
    },
    'visit-replan': async el => { const [c, v] = visitOf(el); if (v) { v.status = 'planned'; await commit(); } },
    'visit-undo': async el => {
      const [c, v] = visitOf(el); if (!v) return;
      if (v.confirmedFrom !== 'planned' && !(await confirmBox('Remove this visit from the history?', 'Remove'))) return;
      withVisits(c, tmp => Visits.undoDone(tmp, v)); await commit();
    },
    'pstatus': async el => { const p = app.proj.prospects[el.dataset.id]; if (p && p.status !== el.dataset.status) { p.status = el.dataset.status; await commit(); } },
    'navigate': el => openExternal(el.dataset.url),
    'call': el => openExternal(el.dataset.url),
    'scan': scan,
    'paste-pair': () => pair($('#paste').value),
    'appearance': el => { app.appearance = el.dataset.v; try { localStorage.setItem('appearance', app.appearance); } catch (e) { /* ignore */ } applyAppearance(); render(); },
    'disconnect': async () => {
      if (!(await confirmBox('Disconnect this phone? All client data stored on this phone will be deleted. Your PC data is not affected.', 'Delete and disconnect'))) return;
      await wipe(); render(); toast('Phone disconnected');
    },
  };

  document.addEventListener('click', ev => {
    const el = ev.target.closest('[data-act]');
    if (!el || !actions[el.dataset.act]) return;
    Promise.resolve(actions[el.dataset.act](el, ev)).catch(e => { console.error(e); toast('Something went wrong: ' + (e && e.message)); });
  });

  // Notes: saved when the field loses focus.
  async function saveNotes(el, coll) {
    const e = app.proj[coll][el.dataset.id];
    if (!e || (e.notes || '') === el.value) return;
    e.notes = el.value;
    await commit(false);
  }
  document.addEventListener('focusout', ev => {
    const t = ev.target;
    if (t.id === 'notes') saveNotes(t, 'clients').catch(console.error);
    else if (t.id === 'pnotes') saveNotes(t, 'prospects').catch(console.error);
    if (app.dirty) setTimeout(() => { if (app.dirty) render(); }, 300);
  });
  document.addEventListener('input', ev => {
    if (ev.target.id === 'psearch') { app.ui.pq = ev.target.value; $('#plist').innerHTML = Views.prospectRows(app.ui.pq); }
  });

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
    render();
    const A = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (A) {
      A.addListener('resume', () => { if (Sync.active) Sync.run(handlers); });
      A.addListener('backButton', () => { if (!back() && app.tab !== 'today') go('today'); else if (!app.stack.length && app.tab === 'today') A.exitApp(); });
    }
    if (Sync.active) Sync.run(handlers);
    app.ready = true;
  }

  Object.assign(app, { render, go, openClient, openProspect, toast, boot, handlers });
  return app;
})();

App.boot();

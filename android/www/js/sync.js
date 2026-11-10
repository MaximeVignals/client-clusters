// Thin adapter between the phone UI and SyncEngine. If the engine signature changes, only this file changes.
'use strict';

const Sync = (() => {
  let engine = null, pairing = null, timer = null, running = false, rerun = false, disconnected = false, pendingCapture = null;
  const listeners = [];
  const ERRORS = {
    'key-mismatch': 'Sync key mismatch. Pair again with a new code from the PC',
    'relay-reset': 'The sync server was reset. Your unsent changes are kept. Pair again, or remove the data from this phone',
    'relay-rollback': 'The sync server went back to an older state. Sync is paused. Check the server, then pair again',
    'bad-response': 'The sync server sent an unexpected answer. Your changes are kept and will be sent later',
    'relay-full': 'The relay storage is full',
    'too-large': 'A change is too large for the relay',
    'no-snapshot': 'Open the Windows app once so it can share your data',
  };
  const emit = () => listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } });

  async function transport(action, body) {
    const http = window.Capacitor.Plugins.CapacitorHttp;
    let res;
    try {
      res = await http.request({
        url: pairing.url, method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pairing.token, 'X-CC-Token': pairing.token },
        data: Object.assign({ action }, body || {}),
        connectTimeout: 15000, readTimeout: 30000,
      });
    } catch (e) {
      const err = new Error((e && e.message) || 'Network error'); err.network = true; throw err;
    }
    let data = res.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = null; } }
    if (res.status === 401) disconnected = true;
    if (res.status >= 400) {
      const err = new Error((data && typeof data === 'object' && data.error) || ('HTTP ' + res.status)); err.status = res.status; throw err;
    }
    // Only a 2xx answer with a JSON body that says ok:true counts as success (a proxy or captive portal can answer 200 with HTML).
    if (!(res.status >= 200 && res.status < 300) || !data || typeof data !== 'object' || data.ok !== true) {
      const err = new Error('bad-response'); err.code = 'bad-response'; err.status = res.status; throw err;
    }
    return data;
  }

  function init(p) {
    clearTimeout(timer); pairing = p; disconnected = false; pendingCapture = null;
    engine = SyncEngine.create({
      role: 'phone',
      config: { url: p.url, token: p.token, key: p.key, deviceId: p.deviceId, pcDeviceId: p.pcDeviceId },
      transport,
      store: { load: () => Store.read('engine.json'), save: s => Store.saveEngine(s) },
    });
    engine.onStatus(emit);
    emit();
  }

  function reset() {
    clearTimeout(timer); engine = null; pairing = null; disconnected = false; pendingCapture = null; emit();
  }

  const errText = () => {
    const e = engine && engine.lastError;
    return String((e && e.message) || e || '');
  };

  // { state: 'off'|'ok'|'busy'|'offline'|'error'|'disconnected', text }
  function status() {
    if (!engine) return { state: 'off', text: '' };
    const msg = errText();
    if (disconnected || /disconnected/i.test(msg)) return { state: 'disconnected', text: 'Disconnected' };
    switch (engine.status) {
      case 'syncing': return { state: 'busy', text: 'Syncing…' };
      case 'offline': return { state: 'offline', text: 'Offline' };
      case 'error': return { state: 'error', text: ERRORS[msg] || msg || 'Error' };
      default: return { state: 'ok', text: 'Synced' };
    }
  }

  const lastSyncAt = () => (engine && engine.lastSyncAt) || 0;
  // `getProj` is a function: the data is read when the capture actually runs, never an object held across a sync
  // (applySnapshot replaces App.proj). During a sync the capture is postponed until it has finished.
  const capture = getProj => {
    if (!engine) return Promise.resolve(0);
    if (running) { pendingCapture = getProj; return Promise.resolve(0); }
    return engine.capture(getProj());
  };

  async function run(h) {
    if (!engine || disconnected) return;
    if (running) { rerun = true; return; }
    running = true;
    try {
      await engine.sync({
        getProj: () => h.getProj(),
        applyWin: ops => h.applyWin(ops),
        applySnapshot: snap => h.applySnapshot(snap && snap.proj ? snap.proj : snap),
      });
    } catch (e) {
      if (e && e.status === 401) disconnected = true;
      console.error('sync', e);
    } finally {
      let again = rerun;
      while (pendingCapture) {
        const g = pendingCapture; pendingCapture = null;
        try { if (engine && (await engine.capture(g())) > 0) again = true; } catch (e) { console.error('capture', e); }
      }
      running = false; emit();
      rerun = false;
      if (again) schedule(h, 500);
    }
  }

  function schedule(h, ms = 3000) {
    if (!engine) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (navigator.onLine !== false) run(h); }, ms);
  }

  return { init, reset, status, lastSyncAt, capture, run, schedule, onChange: f => listeners.push(f), get active() { return !!engine; } };
})();

// DEV ONLY demo mode: runs the phone UI in a desktop browser with invented data, in-memory storage and a fake sync.
// Active only when ALL hold: URL has demo=1, not a native Capacitor app, no androidBridge, and http: protocol
// (the Android app serves https://localhost). Otherwise this file does nothing at all.
// Extra dev params: &sync=ok|busy|offline|error|disconnected   &state=loading|empty|fatal
//   &pos=43.3,-0.37  (fake phone position for "prospects near me" and "Me localiser")
//   &font=2  (text at 200%, like the system font scale)   &tiles=off  (no map background: shows the offline map chip)
(function () {
  'use strict';
  var w = typeof window !== 'undefined' ? window : globalThis;
  var loc = w.location;
  if (!loc || loc.protocol !== 'http:') return;
  var cap = w.Capacitor;
  if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) return;
  if (w.androidBridge) return;
  var params;
  try { params = new URLSearchParams(loc.search || ''); } catch (e) { return; }
  if (params.get('demo') !== '1') return;

  // Fixtures are loaded only now, so the real app never loads them (they run right after this script, before app.js).
  document.write('<script src="dev/fixtures.js"><\/script>');

  var SYNC = params.get('sync') || '';
  var STATE = params.get('state') || '';
  var memory = {}; // file name -> JSON text, writes never leave the page
  var clone = function (x) { return x == null ? null : JSON.parse(JSON.stringify(x)); };

  var PAIRING = { url: 'https://demo.invalid/relay', token: 'demo-token', key: 'demo-key', deviceId: 'phone-demo', pcDeviceId: 'pc-demo', name: 'PC de démo' };

  function initialFile(name) {
    if (name === 'pairing.json') return PAIRING;
    if (name === 'data.json') return STATE === 'empty' ? w.DemoFixtures.empty() : w.DemoFixtures.build();
    return null; // engine.json and anything else: missing
  }

  // ----- fake storage (same API as store.js; nothing touches Capacitor Filesystem) -----
  var fakeStore = {
    read: function (name) {
      if (STATE === 'loading') return new Promise(function () { }); // never resolves: stays on the loading screen
      if (STATE === 'fatal' && name === 'pairing.json') return Promise.reject(new Error('Démo : le fichier data.json est illisible (erreur simulée).'));
      if (Object.prototype.hasOwnProperty.call(memory, name)) return Promise.resolve(memory[name] === null ? null : JSON.parse(memory[name]));
      return Promise.resolve(clone(initialFile(name)));
    },
    write: function (name, obj) { memory[name] = JSON.stringify(obj); return Promise.resolve(); },
    remove: function (name) { memory[name] = null; return Promise.resolve(); },
  };
  fakeStore.saveData = function (proj) { return fakeStore.write('data.json', proj); };
  fakeStore.saveEngine = function (s) { return fakeStore.write('engine.json', s); };

  // ----- fake sync (same API as sync.js; never uses the network) -----
  var listeners = [], phase = 'ok', isActive = false, last = 0, timer = null, running = false;
  var emit = function () { listeners.forEach(function (f) { try { f(); } catch (e) { console.error(e); } }); };
  var TEXT = { ok: 'Synced', busy: 'Syncing…', offline: 'Offline', error: 'Démo : erreur de synchronisation simulée', disconnected: 'Disconnected' };
  var forced = /^(ok|busy|offline|error|disconnected)$/.test(SYNC) ? SYNC : '';

  var fakeSync = {
    init: function () { isActive = true; last = Date.now() - 4 * 60000; phase = forced || 'ok'; emit(); },
    reset: function () { clearTimeout(timer); isActive = false; phase = 'ok'; emit(); },
    status: function () {
      if (!isActive) return { state: 'off', text: '' };
      var s = forced || phase;
      return { state: s, text: TEXT[s] };
    },
    lastSyncAt: function () { return isActive ? last : 0; },
    capture: function () { return Promise.resolve(0); },
    run: function () {
      if (!isActive || running || forced) { if (forced) emit(); return Promise.resolve(); }
      running = true; phase = 'busy'; emit();
      return new Promise(function (resolve) {
        setTimeout(function () { running = false; phase = 'ok'; last = Date.now(); emit(); resolve(); }, 900);
      });
    },
    schedule: function (h, ms) {
      if (!isActive) return;
      clearTimeout(timer);
      timer = setTimeout(function () { fakeSync.run(h); }, ms == null ? 3000 : ms);
    },
    onChange: function (f) { listeners.push(f); },
  };

  // Store and Sync are top-level `const`s (not window properties), so they can't be rebound: mutate them in place.
  Object.assign(Store, fakeStore);
  Object.keys(fakeSync).forEach(function (k) { Sync[k] = fakeSync[k]; });
  Object.defineProperty(Sync, 'active', { get: function () { return isActive; }, configurable: true });

  // The page has no capacitor.js outside the native build: give app.js an empty plugin list so the
  // scanner / phone / maps buttons fall back to their normal "not available" toasts.
  if (!w.Capacitor) w.Capacitor = { isNativePlatform: function () { return false; }, getPlatform: function () { return 'web'; }, Plugins: {} };

  // ----- visible badge -----
  function badge() {
    var b = document.createElement('div');
    b.id = 'demo-badge';
    b.textContent = 'Démo';
    b.setAttribute('aria-hidden', 'true');
    b.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#b91c1c;color:#fff;font:700 10px/1 system-ui,sans-serif;padding:2px 6px;border-radius:0 0 8px 0;opacity:.85;pointer-events:none;letter-spacing:.04em';
    document.body.appendChild(b);
  }
  if (document.body) badge(); else document.addEventListener('DOMContentLoaded', badge);
  // ----- map performance probe (console: await __mapPerf(3000)) -----
  // Pans and zooms the map through a fixed sequence over the demo data (zoom 9 -> 16 -> 9, hopping between towns) while sampling
  // requestAnimationFrame deltas. Only requestAnimationFrame is used (no timers), so nothing keeps running afterwards.
  w.__mapPerf = function (ms) {
    ms = ms > 0 ? ms : 3000;
    return new Promise(function (resolve) {
      var m = typeof PhoneMap !== 'undefined' ? PhoneMap.map : null, app = typeof App !== 'undefined' ? App : null;
      if (!m || !app || m.getContainer().clientWidth <= 0) { resolve({ error: 'open the Carte tab first' }); return; }
      var pts = Object.keys(app.proj.clients).map(function (k) { return app.proj.clients[k]; })
        .filter(function (c) { return Number.isFinite(c.lat) && Number.isFinite(c.lng); })
        .map(function (c) { return [c.lat, c.lng]; });
      if (!pts.length) { resolve({ error: 'no data' }); return; }
      var towns = [0, 1, 2, 3].map(function (i) { return pts[Math.floor(i * (pts.length - 1) / 3)]; });
      var start = { c: m.getCenter(), z: m.getZoom() };
      var longTasks = 0, po = null;
      try { po = new PerformanceObserver(function (l) { longTasks += l.getEntries().length; }); po.observe({ entryTypes: ['longtask'] }); } catch (e) { po = null; }
      var steps = Math.max(8, Math.round(ms / 250)), step = -1, deltas = [], prev = 0, t0 = 0, peak = 0;
      function frame(now) {
        if (!t0) { t0 = now; prev = now; } else { deltas.push(now - prev); prev = now; }
        var p = Math.min(1, (now - t0) / ms), s = Math.min(steps - 1, Math.floor(p * steps));
        if (s !== step && p < 1) {
          step = s;
          var q = steps > 1 ? s / (steps - 1) : 0, z = Math.round(9 + 7 * (1 - Math.abs(2 * q - 1)));   // 9 -> 16 -> 9
          m.setView(towns[s % towns.length], z, { animate: true, duration: 0.2 });
        }
        peak = Math.max(peak, document.querySelectorAll('.leaflet-marker-icon').length);
        if (p < 1) { w.requestAnimationFrame(frame); return; }
        if (po) { longTasks += po.takeRecords().length; po.disconnect(); }
        m.setView(start.c, start.z, { animate: false });
        deltas.sort(function (x, y) { return x - y; });
        var elapsed = Math.max(1, prev - t0);
        resolve({
          frames: deltas.length, avgFps: Math.round(deltas.length / elapsed * 10000) / 10,
          p95FrameMs: deltas.length ? Math.round(deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.95))] * 10) / 10 : 0,
          longTasks: po ? longTasks : null, markersInDom: document.querySelectorAll('.leaflet-marker-icon').length, markersInDomPeak: peak,
        });
      }
      w.requestAnimationFrame(frame);
    });
  };
  // &font=2: root text size 200%, to check that nothing clips or overlaps (all text sizes are rem).
  if (params.get('font') === '2' && document.documentElement) document.documentElement.style.fontSize = '200%';
  w.__DEMO__ = { sync: forced, state: STATE, tiles: params.get('tiles') === 'off' ? 'off' : '', pos: params.get('pos') || '' };
})();

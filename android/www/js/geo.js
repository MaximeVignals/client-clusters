// Phone position, for "prospects near me" and "Me localiser" on the map. Classic script: defines global `Geo`.
// Uses the Capacitor Geolocation plugin when it is there (native app), else navigator.geolocation.
// The position is kept in memory only (Geo.last()): never written to storage, localStorage or sync.
// Failures reject with an Error whose .kind is 'denied' | 'off' | 'timeout' | 'unavailable'; Geo.message(kind) is the French text.
'use strict';

const Geo = (() => {
  const OPTS = { timeout: 10000, quickTimeout: 5000, maximumAge: 60000 };
  const COARSE_OK_M = 500;   // a fix worse than this is retried once with high accuracy
  let inflight = null, inflightFresh = false, lastPos = null;

  const fail = (kind, cause) => { const e = new Error(kind + (cause && cause.message ? ': ' + cause.message : '')); e.kind = kind; return e; };

  // Capacitor Geolocation error codes (Android): 0003 permission denied, 0007 / 0017 location services off,
  // 0009 request to enable location denied (counts as off), 0010 timeout, 0002 / 0014-0016 / 0018 other failures.
  function kindOf(e) {
    if (e && e.kind) return e.kind;
    const code = String((e && (e.code || (e.data && e.data.code))) || ''), msg = String((e && e.message) || '').toLowerCase();
    if (/GLOC-0003$/.test(code)) return 'denied';
    if (/GLOC-(0007|0009|0017)$/.test(code)) return 'off';
    if (/GLOC-0010$/.test(code)) return 'timeout';
    if (code === '1') return 'denied';          // web: PERMISSION_DENIED
    if (code === '3') return 'timeout';         // web: TIMEOUT
    if (code === '2') return 'unavailable';     // web: POSITION_UNAVAILABLE
    if (/denied|permission/.test(msg)) return 'denied';
    if (/not enabled|disabled|services/.test(msg)) return 'off';
    if (/timeout|timed out|in time/.test(msg)) return 'timeout';
    return 'unavailable';
  }

  const plugin = () => {
    const P = window.Capacitor && window.Capacitor.Plugins;
    return (P && P.Geolocation) || null;
  };

  // Demo only (dev/demo.js sets __DEMO__.pos = "lat,lng"): a fixed position, no permission and no sensor.
  function demoPos() {
    const d = window.__DEMO__, m = d && /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(d.pos || ''));
    return m ? { lat: +m[1], lng: +m[2], accuracy: 25, at: Date.now() } : null;
  }

  const norm = p => {
    const c = p && p.coords;
    if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) throw fail('unavailable');
    return { lat: c.latitude, lng: c.longitude, accuracy: Number.isFinite(c.accuracy) ? c.accuracy : 0, at: Number.isFinite(p.timestamp) && p.timestamp > 0 ? p.timestamp : Date.now() };
  };

  const webOnce = o => new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(fail('unavailable')); return; }
    navigator.geolocation.getCurrentPosition(resolve, e => reject(fail(kindOf(e), e)), o);
  });

  // Asks once for both aliases, so Android shows its single precise / approximate dialog. Resolves to true when precise
  // location is granted; coarse-only is a success too (false: never ask again, never retry with high accuracy).
  async function ensurePermission(pl) {
    // checkPermissions and requestPermissions throw when location services are switched off.
    const ok = st => st.location === 'granted' || st.coarseLocation === 'granted';
    let st = await pl.checkPermissions();
    if (!ok(st)) {
      st = await pl.requestPermissions({ permissions: ['location', 'coarseLocation'] });
      if (!ok(st)) throw fail('denied');
    }
    return st.location === 'granted';
  }

  async function fetchPos(fresh) {
    const demo = demoPos();
    if (demo) return demo;
    const pl = plugin();
    const once = o => (pl ? pl.getCurrentPosition(o) : webOnce(o));
    try {
      const precise = pl ? await ensurePermission(pl) : true;
      // Network-based (balanced) fix first. With precise location allowed, GPS is tried when that fix is rough, and also
      // when it fails (no Wi-Fi or mobile network to locate from, e.g. in the countryside): only 'denied' / 'off' stop here.
      let best = null, firstErr = null;
      // With GPS as a fallback, the network fix gets less time (a phone with Wi-Fi or mobile network answers well within 5 s).
      try { best = norm(await once({ enableHighAccuracy: false, timeout: precise ? OPTS.quickTimeout : OPTS.timeout, maximumAge: fresh ? 0 : OPTS.maximumAge })); }
      catch (e) {
        const k = kindOf(e);
        if (!precise || k === 'denied' || k === 'off') throw e;
        firstErr = e;
      }
      if (precise && (!best || best.accuracy > COARSE_OK_M)) {
        try {
          const better = norm(await once({ enableHighAccuracy: true, timeout: OPTS.timeout, maximumAge: 0 }));
          if (!best || better.accuracy < best.accuracy) best = better;
        } catch (e) { if (!best) throw firstErr; /* else keep the coarse fix */ }
      }
      return best;
    } catch (e) { throw e && e.kind ? e : fail(kindOf(e), e); }
  }

  // One request at a time: concurrent callers share the in-flight promise. A { fresh: true } caller never reuses a
  // non-fresh request in flight: its own request starts after that one ends.
  function track(p, fresh) {
    const q = p.then(r => { lastPos = r; return r; }).finally(() => { if (inflight === q) inflight = null; });
    inflight = q; inflightFresh = fresh;
    return q;
  }
  function get(opts) {
    const fresh = !!(opts && opts.fresh);
    if (!inflight) return track(fetchPos(fresh), fresh);
    if (inflightFresh || !fresh) return inflight;
    return track(inflight.catch(() => { }).then(() => fetchPos(true)), true);
  }

  // Great-circle distance in metres.
  function distance(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // "850 m" (to 10 m), "2,3 km" (under 10 km), "12 km".
  function fmt(m) {
    if (!Number.isFinite(m) || m < 0) return '';
    const r = Math.round(m / 10) * 10;
    if (r < 1000) return r + ' m';
    if (m < 9950) return (m / 1000).toFixed(1).replace('.', ',') + ' km';
    return Math.round(m / 1000) + ' km';
  }

  const message = kind => (T.geo.errors[kind] || T.geo.errors.unavailable);

  return { get, last: () => lastPos, distance, fmt, message, kindOf };
})();

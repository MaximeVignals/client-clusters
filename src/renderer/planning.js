// Day planning: ordering stops, estimating driving time, checking opening hours at the
// estimated arrival time, and picking which clients to visit on a given day.
// Pure functions (no DOM, no network). Uses Hours (hours.js) for opening hours.
(function (root) {
  'use strict';

  const ROAD_FACTOR = 1.3;        // roads are longer than the straight line
  const MAX_WAIT = 90;            // minutes we're willing to wait for a client to open
  const PENALTY_CLOSED = 400;     // arriving on a day/time the client is closed for good
  const PENALTY_CLOSING = 25;     // arriving less than a visit-length before closing

  const Hours = () => root.Hours;

  function distanceKm(a, b) {
    const R = 6371, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const roadKm = (a, b) => distanceKm(a, b) * ROAD_FACTOR;

  // Opening ranges of one weekday (0 = Sunday) in minutes from midnight, [] when closed all day,
  // null when hours are unknown.
  function dayRanges(hours, weekday) {
    const H = Hours();
    if (!H || !H.known(hours)) return null;
    return H.dayRanges(hours, weekday);
  }
  const closedAllDay = (hours, weekday) => { const r = dayRanges(hours, weekday); return !!r && r.length === 0; };

  /**
   * Is the client open when we arrive at `minute` on `weekday`, for a visit of `stay` minutes?
   * { state: 'unknown' | 'open' | 'closing' | 'wait' | 'closedLater' | 'closedDay', opensAt?, closesAt? }
   */
  function checkArrival(hours, weekday, minute, stay) {
    const r = dayRanges(hours, weekday);
    if (!r) return { state: 'unknown' };
    if (!r.length) return { state: 'closedDay' };
    for (const [s, e] of r) {
      if (minute >= s && minute < e) return { state: minute + stay <= e ? 'open' : 'closing', closesAt: e };
    }
    const later = r.map(x => x[0]).filter(s => s > minute).sort((a, b) => a - b);
    if (later.length) return { state: 'wait', opensAt: later[0] };
    return { state: 'closedLater', closesAt: Math.max(...r.map(x => x[1])) };
  }

  /**
   * Drive through `stops` in the given order, starting from `start` (or from the first stop when null)
   * and coming back to `start` if there is one.
   * opts: { weekday, startMin, visitMin, speedKmh }
   * Returns { legs: [{ km, drive, arrive, wait, leave, check }], km, drive, wait, endMin, backKm, penalty, cost }
   */
  function simulate(start, stops, opts) {
    const speed = opts.speedKmh || 45, stay = opts.visitMin ?? 30;
    let t = opts.startMin ?? 510, prev = start, km = 0, drive = 0, wait = 0, penalty = 0;
    const legs = [];
    for (const s of stops) {
      const k = prev ? roadKm(prev, s) : 0;
      const d = k / speed * 60;
      km += k; drive += d; t += d;
      const arrive = t;
      let w = 0;
      const check = opts.weekday === undefined ? { state: 'unknown' } : checkArrival(s.hours, opts.weekday, t, stay);
      if (check.state === 'wait') {
        if (check.opensAt - t <= MAX_WAIT) { w = check.opensAt - t; t = check.opensAt; } else penalty += PENALTY_CLOSED / 2;
      } else if (check.state === 'closedDay' || check.state === 'closedLater') penalty += PENALTY_CLOSED;
      else if (check.state === 'closing') penalty += PENALTY_CLOSING;
      wait += w;
      t += stay;
      legs.push({ km: k, drive: d, arrive, wait: w, leave: t, check });
      prev = s;
    }
    let backKm = 0;
    if (start && stops.length) {
      backKm = roadKm(prev, start);
      const d = backKm / speed * 60;
      km += backKm; drive += d; t += d;
    }
    return { legs, km, drive, wait, endMin: t, backKm, penalty, cost: drive + wait + penalty };
  }

  // Order stops to keep driving (and waiting for closed shops) to a minimum:
  // nearest neighbour, then 2-opt and "move one stop" improvements on the full simulated cost.
  function orderStops(start, stops, opts = {}) {
    const n = stops.length;
    if (n <= 1) return stops.map((_, i) => i);
    // Starting point without home: the stop farthest from the middle (an end of the trip).
    let first = null;
    if (!start) {
      const mid = { lat: stops.reduce((a, s) => a + s.lat, 0) / n, lng: stops.reduce((a, s) => a + s.lng, 0) / n };
      first = stops.reduce((bi, s, i) => (distanceKm(s, mid) > distanceKm(stops[bi], mid) ? i : bi), 0);
    }
    const left = new Set(stops.map((_, i) => i));
    let order = [];
    let cur = start;
    if (first !== null) { order.push(first); left.delete(first); cur = stops[first]; }
    while (left.size) {
      let best = -1, bd = Infinity;
      for (const i of left) { const d = distanceKm(cur, stops[i]); if (d < bd) { bd = d; best = i; } }
      order.push(best); left.delete(best); cur = stops[best];
    }
    const cost = o => simulate(start, o.map(i => stops[i]), opts).cost;
    let bestCost = cost(order);
    for (let pass = 0; pass < 40; pass++) {
      let improved = false;
      // 2-opt: reverse a section
      for (let i = 0; i < n - 1; i++) {
        for (let j = i + 1; j < n; j++) {
          const o = order.slice(0, i).concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
          const c = cost(o);
          if (c < bestCost - 1e-6) { order = o; bestCost = c; improved = true; }
        }
      }
      // Or-opt: move one stop elsewhere
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const o = order.slice();
          const [x] = o.splice(i, 1);
          o.splice(j, 0, x);
          const c = cost(o);
          if (c < bestCost - 1e-6) { order = o; bestCost = c; improved = true; }
        }
      }
      if (!improved) break;
    }
    return order;
  }

  // Extra km to fit point p into a route (cheapest place), start/end at `start` when given.
  function insertionKm(start, route, p) {
    const pts = start ? [start, ...route, start] : route.slice();
    if (!pts.length) return 0;
    if (pts.length === 1) return roadKm(pts[0], p) * (start ? 2 : 1);
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = roadKm(pts[i], p) + roadKm(p, pts[i + 1]) - roadKm(pts[i], pts[i + 1]);
      if (d < best) best = d;
    }
    if (!start) best = Math.min(best, roadKm(p, pts[0]), roadKm(pts[pts.length - 1], p));
    return best;
  }

  /**
   * Pick the clients for one day.
   * candidates: [{ id, lat, lng, hours, urgency }] (urgency ≈ 1 when just due, higher when more overdue)
   * opts: { home, anchor, radiusKm, maxStops, weekday, startMin, endMin, visitMin, speedKmh, kmWeight }
   * Returns { ids (in visiting order), anchor, sim, closedThatDay }
   */
  function planDay(candidates, opts) {
    const radius = opts.radiusKm || 25;
    const kmWeight = opts.kmWeight ?? 0.03; // 1 point of urgency is worth ~33 km of detour
    const fixed = opts.fixed || []; // stops already planned that day: always kept
    const closedThatDay = candidates.filter(c => opts.weekday !== undefined && closedAllDay(c.hours, opts.weekday));
    const pool0 = candidates.filter(c => !closedThatDay.includes(c));
    if (!pool0.length && !fixed.length) return { ids: [], anchor: null, sim: null, closedThatDay: closedThatDay.map(c => c.id) };

    // Where to go: the place with the most urgent clients around it (slightly preferring places near home).
    let anchor = opts.anchor;
    if (!anchor && fixed.length) anchor = { lat: fixed.reduce((a, c) => a + c.lat, 0) / fixed.length, lng: fixed.reduce((a, c) => a + c.lng, 0) / fixed.length };
    if (!anchor && pool0.length) {
      const seeds = pool0.slice().sort((a, b) => b.urgency - a.urgency).slice(0, 250);
      let best = null, bestScore = -Infinity;
      for (const s of seeds) {
        let score = 0, count = 0;
        for (const c of pool0) if (distanceKm(s, c) <= radius) { score += c.urgency; count++; }
        score = Math.min(score, (opts.maxStops || 8) * 3) + Math.min(count, opts.maxStops || 8) * 0.2;
        if (opts.home) score -= distanceKm(opts.home, s) * 0.004;
        if (score > bestScore) { bestScore = score; best = s; }
      }
      anchor = { lat: best.lat, lng: best.lng };
    }
    const pool = anchor ? pool0.filter(c => distanceKm(anchor, c) <= radius) : [];
    const chosen = fixed.slice();
    const tried = new Set();
    const maxStops = opts.maxStops || 8;
    const endMin = opts.endMin ?? 1080;
    while (chosen.length < maxStops) {
      let best = null, bestScore = -Infinity;
      for (const c of pool) {
        if (tried.has(c) || chosen.includes(c)) continue;
        const score = c.urgency - kmWeight * (chosen.length ? insertionKm(opts.home, chosen, c) : distanceKm(anchor, c) * ROAD_FACTOR);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (!best) break;
      tried.add(best);
      const trial = chosen.concat(best);
      const o = orderStops(opts.home, trial, opts);
      const sim = simulate(opts.home, o.map(i => trial[i]), opts);
      if (sim.endMin > endMin) continue; // doesn't fit in the day, including the first stop
      chosen.push(best);
    }
    const order = orderStops(opts.home, chosen, opts);
    const ordered = order.map(i => chosen[i]);
    return { ids: ordered.map(c => c.id), anchor, sim: simulate(opts.home, ordered, opts), closedThatDay: closedThatDay.map(c => c.id) };
  }

  /**
   * Google Maps driving links through `points` (in order), from `home` and back when given.
   * Google takes at most 9 stops between origin and destination, so long trips are cut into parts
   * that follow on from each other. Returns [{ url, from, to }] with from/to = stop numbers (1-based).
   */
  function routeLinks(home, points) {
    const ll = p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
    if (!points.length) return [];
    const seq = (home ? [{ ...home, home: true }] : []).concat(points.map((p, i) => ({ ...p, n: i + 1 }))).concat(home ? [{ ...home, home: true }] : []);
    const parts = [];
    let i = 0;
    const firstHasOrigin = !!home;
    while (i < seq.length - (firstHasOrigin || parts.length ? 1 : 0)) {
      const withOrigin = firstHasOrigin || parts.length > 0;
      const chunk = seq.slice(i, i + (withOrigin ? 11 : 10));
      if (chunk.length < (withOrigin ? 2 : 1)) break;
      const origin = withOrigin ? chunk[0] : null;
      const rest = withOrigin ? chunk.slice(1) : chunk;
      const dest = rest[rest.length - 1];
      const wps = rest.slice(0, -1);
      const url = 'https://www.google.com/maps/dir/?api=1' + (origin ? `&origin=${ll(origin)}` : '') + `&destination=${ll(dest)}`
        + (wps.length ? '&waypoints=' + encodeURIComponent(wps.map(ll).join('|')) : '') + '&travelmode=driving';
      const nums = chunk.filter(p => p.n).map(p => p.n);
      parts.push({ url, from: nums[0] || null, to: nums[nums.length - 1] || null, fromHome: !!(origin && origin.home), toHome: !!dest.home });
      i += chunk.length - 1;
      if (i >= seq.length - 1) break;
    }
    return parts;
  }

  const fmtMin = m => { m = Math.round(m); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  const fmtDuration = m => { m = Math.round(m); const h = Math.floor(m / 60), r = m % 60; return h ? `${h} h${r ? ' ' + String(r).padStart(2, '0') : ''}` : `${r} min`; };
  const parseHHMM = s => { const m = /^(\d{1,2})[:h](\d{2})$/.exec(String(s || '').trim()); return m && +m[1] < 24 && +m[2] < 60 ? (+m[1]) * 60 + (+m[2]) : null; };

  const api = { distanceKm, roadKm, dayRanges, closedAllDay, checkArrival, simulate, orderStops, insertionKm, planDay, routeLinks, fmtMin, fmtDuration, parseHHMM, ROAD_FACTOR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Planning = api;
})(typeof window !== 'undefined' ? window : globalThis);

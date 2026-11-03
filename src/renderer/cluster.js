// Capacity-constrained geographic clustering.
// Splits points into groups of at most `maxSize`, keeping each group as compact as possible.
// Method: k-means++ seeding -> capacity-aware assignment (by regret) -> centroid updates,
// then local search (moves and swaps between nearby groups), best of several restarts.
// In automatic mode, extra groups are added when an isolated pocket of clients would
// otherwise be glued to a far-away group.
(function (root) {
  'use strict';

  // Small seeded RNG so results are reproducible for the same data.
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  // Equirectangular projection to kilometres (accurate enough at regional scale).
  function project(points) {
    const lat0 = points.reduce((a, p) => a + p.lat, 0) / points.length;
    const kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.574;
    return points.map(p => [p.lng * kx, p.lat * ky]);
  }
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

  // Indices of the m nearest centres to p, nearest first (m small).
  function nearest(p, cents, m) {
    const idx = [], dist = [];
    for (let j = 0; j < cents.length; j++) {
      const d = d2(p, cents[j]);
      if (idx.length < m || d < dist[dist.length - 1]) {
        let pos = dist.length;
        while (pos > 0 && dist[pos - 1] > d) pos--;
        idx.splice(pos, 0, j); dist.splice(pos, 0, d);
        if (idx.length > m) { idx.pop(); dist.pop(); }
      }
    }
    return { idx, dist };
  }

  function seedPlusPlus(xy, k, rand) {
    const n = xy.length, centers = [xy[Math.floor(rand() * n)].slice()];
    const best = xy.map(p => d2(p, centers[0]));
    while (centers.length < k) {
      let total = 0;
      for (let i = 0; i < n; i++) total += best[i];
      let idx = 0;
      if (total === 0) idx = Math.floor(rand() * n);
      else { let r = rand() * total; for (; idx < n - 1; idx++) { r -= best[idx]; if (r <= 0) break; } }
      centers.push(xy[idx].slice());
      for (let i = 0; i < n; i++) { const d = d2(xy[i], xy[idx]); if (d < best[i]) best[i] = d; }
    }
    return centers;
  }

  // Assign each point to the nearest centre that still has room. Points that would lose the
  // most by not getting their first choice (highest "regret") pick first.
  function assign(xy, cents, cap) {
    const n = xy.length, k = cents.length, M = Math.min(k, 8);
    const prefs = new Array(n);
    for (let i = 0; i < n; i++) {
      const nn = nearest(xy[i], cents, M);
      prefs[i] = { i, nn, regret: k > 1 ? nn.dist[1] - nn.dist[0] : 0 };
    }
    prefs.sort((a, b) => b.regret - a.regret);
    const load = new Array(k).fill(0), label = new Array(n);
    for (const p of prefs) {
      let chosen = -1;
      for (const j of p.nn.idx) if (load[j] < cap) { chosen = j; break; }
      if (chosen < 0) { // all nearby groups full: scan everything
        let bd = Infinity;
        for (let j = 0; j < k; j++) if (load[j] < cap) { const d = d2(xy[p.i], cents[j]); if (d < bd) { bd = d; chosen = j; } }
      }
      label[p.i] = chosen; load[chosen]++;
    }
    return label;
  }

  function centroids(xy, label, k, prev) {
    const sum = Array.from({ length: k }, () => [0, 0, 0]);
    for (let i = 0; i < xy.length; i++) { const s = sum[label[i]]; s[0] += xy[i][0]; s[1] += xy[i][1]; s[2]++; }
    return sum.map((s, j) => (s[2] ? [s[0] / s[2], s[1] / s[2]] : prev[j]));
  }

  function cost(xy, label, cents) {
    let c = 0;
    for (let i = 0; i < xy.length; i++) c += d2(xy[i], cents[label[i]]);
    return c;
  }

  // Local search: move a point to a nearby group with room, or swap it with a point of that
  // group, whenever that lowers the total squared distance to group centres.
  function improve(xy, label, k, cap) {
    const n = xy.length;
    let cents = centroids(xy, label, k, Array.from({ length: k }, () => [0, 0]));
    const size = new Array(k).fill(0);
    const members = Array.from({ length: k }, () => []);
    label.forEach((j, i) => { size[j]++; members[j].push(i); });
    const near = Math.min(k, 6);

    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        const a = label[i];
        const cand = nearest(xy[i], cents, near);
        const curr = d2(xy[i], cents[a]);
        for (let c = 0; c < cand.idx.length; c++) {
          const b = cand.idx[c], db = cand.dist[c];
          if (b === a) continue;
          if (db >= curr) break; // remaining candidates are farther than the current centre
          if (size[b] < cap && size[a] > 1) {
            label[i] = b; size[a]--; size[b]++;
            members[a].splice(members[a].indexOf(i), 1); members[b].push(i);
            changed = true; break;
          }
          let bestGain = 1e-9, bestJ = -1;
          for (const j of members[b]) {
            const gain = curr + d2(xy[j], cents[b]) - db - d2(xy[j], cents[a]);
            if (gain > bestGain) { bestGain = gain; bestJ = j; }
          }
          if (bestJ >= 0) {
            label[i] = b; label[bestJ] = a;
            members[a].splice(members[a].indexOf(i), 1, bestJ);
            members[b].splice(members[b].indexOf(bestJ), 1, i);
            changed = true; break;
          }
        }
      }
      cents = centroids(xy, label, k, cents);
      if (!changed) break;
    }
    return { label, cents };
  }

  function runOnce(xy, k, cap, rand) {
    let cents = seedPlusPlus(xy, k, rand), label = null;
    for (let it = 0; it < 30; it++) {
      const next = assign(xy, cents, cap);
      const same = label && next.every((v, i) => v === label[i]);
      label = next;
      cents = centroids(xy, label, k, cents);
      if (same) break;
    }
    const r = improve(xy, label, k, cap);
    return { label: r.label, cents: r.cents, cost: cost(xy, r.label, r.cents) };
  }

  function solve(xy, k, cap, restarts, seed) {
    const rand = rng(seed);
    let best = null;
    for (let r = 0; r < restarts; r++) {
      const res = runOnce(xy, k, cap, rand);
      if (!best || res.cost < best.cost) best = res;
    }
    return best;
  }

  // Largest distance (km) from a group's centre to one of its clients, for each group.
  function radii(xy, sol, k) {
    const r = new Array(k).fill(0);
    for (let i = 0; i < xy.length; i++) {
      const d = Math.sqrt(d2(xy[i], sol.cents[sol.label[i]]));
      if (d > r[sol.label[i]]) r[sol.label[i]] = d;
    }
    return r;
  }

  /**
   * @param {Array<{lat:number,lng:number}>} points
   * @param {number} maxSize  maximum clients per group
   * @param {object} [opts]   { groups: fixed number of groups (>= minimum) or 0/undefined for automatic }
   * @returns {{labels:number[], groups:number, minGroups:number}}
   */
  function clusterPoints(points, maxSize, opts = {}) {
    const n = points.length;
    if (n === 0) return { labels: [], groups: 0, minGroups: 0 };
    const minK = Math.ceil(n / maxSize);
    if (minK === 1 && !(opts.groups > 1)) return { labels: new Array(n).fill(0), groups: 1, minGroups: 1 };
    const xy = project(points);
    const restarts = opts.restarts || (n <= 300 ? 16 : n <= 1500 ? 4 : 2);
    const seed = opts.seed || 12345;

    let k, best;
    if (opts.groups && opts.groups >= minK) {
      k = Math.min(n, opts.groups);
      best = solve(xy, k, maxSize, restarts, seed);
    } else {
      // Automatic: start from the fewest possible groups; while one group is far more spread
      // out than a typical group (an isolated pocket glued onto another), allow one more group.
      // "Typical" group radius = 30th percentile, so a few stretched groups can't hide each other.
      const spread = (sol, kk) => {
        const r = radii(xy, sol, kk).sort((a, b) => a - b);
        const typical = r[Math.floor((r.length - 1) * 0.3)];
        return { worst: r[r.length - 1], ok: r[r.length - 1] <= Math.max(3 * typical, typical + 8) };
      };
      k = minK;
      best = solve(xy, k, maxSize, restarts, seed);
      let s = spread(best, k);
      const maxK = Math.min(n, minK + Math.ceil(minK * 0.5));
      let bestWorst = s.worst, stale = 0;
      for (let kk = minK + 1; !s.ok && kk <= maxK && stale < 3; kk++) {
        const sol = solve(xy, kk, maxSize, restarts, seed);
        const sp = spread(sol, kk);
        if (sp.ok) { k = kk; best = sol; break; }
        if (sp.worst < bestWorst - 0.5) { bestWorst = sp.worst; stale = 0; } else stale++;
      }
    }

    // Number groups in reading order: north -> south in ~15 km bands, then west -> east.
    const order = best.cents.map((c, j) => [j, c]);
    order.sort((a, b) => {
      const ra = Math.round(a[1][1] / 15), rb = Math.round(b[1][1] / 15);
      return rb - ra || a[1][0] - b[1][0];
    });
    const remap = new Array(k);
    order.forEach(([j], idx) => { remap[j] = idx; });
    return { labels: best.label.map(j => remap[j]), groups: k, minGroups: minK };
  }

  // Convex hull (monotone chain) of [x,y] points, used to outline groups on the map.
  function convexHull(pts) {
    const p = pts.map(q => q.slice()).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  function distanceKm(a, b) {
    const R = 6371, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // ---------------------------------------------------------------------------
  // Town-aware grouping with a distance limit.
  //  1. Clients of the same town form one block. A town is split only if it has more clients
  //     than `flexSize` (split into compact neighbourhoods of at most `maxSize`) or if its
  //     clients are spread over more than `maxSpanKm`.
  //  2. Blocks are merged, closest first (complete linkage: the merge that gives the smallest
  //     group diameter goes first), as long as the group stays within `maxSize` clients and
  //     no two clients are more than `maxSpanKm` apart.
  // So group sizes vary: a lone client 60 km from anyone stays alone, a town of 7 stays whole.
  // ---------------------------------------------------------------------------
  function diameterKm(pts) {
    let d = 0;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) d = Math.max(d, distanceKm(pts[i], pts[j]));
    return d;
  }

  // Minimal binary heap of [cost, ...payload]
  function Heap() { this.a = []; }
  Heap.prototype.push = function (x) {
    const a = this.a; a.push(x); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  };
  Heap.prototype.pop = function () {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  };

  /**
   * @param {Array<{lat:number,lng:number,town?:string}>} points
   * @param {{maxSize:number, flexSize?:number, maxSpanKm?:number}} opts
   * @returns {{labels:number[], groups:number, oversized:number, splitTowns:string[]}}
   */
  function groupByTownAndDistance(points, opts) {
    const n = points.length;
    const maxSize = Math.max(1, opts.maxSize);
    const flex = Math.max(maxSize, opts.flexSize || maxSize);
    const span = opts.maxSpanKm > 0 ? opts.maxSpanKm : Infinity;
    if (!n) return { labels: [], groups: 0, oversized: 0, splitTowns: [] };

    // 1. Blocks
    const blocks = [];
    const splitTowns = [];
    const byTown = new Map();
    points.forEach((p, i) => {
      const key = (p.town || '').trim().toLowerCase();
      if (!key) { blocks.push([i]); return; }
      if (!byTown.has(key)) byTown.set(key, []);
      byTown.get(key).push(i);
    });
    for (const [, idx] of byTown) {
      const pts = idx.map(i => points[i]);
      const spread = idx.length > 1 ? diameterKm(pts) : 0;
      if (spread > span) { idx.forEach(i => blocks.push([i])); continue; } // e.g. same name, different places
      if (idx.length <= flex) { blocks.push(idx); continue; }
      splitTowns.push(points[idx[0]].town);
      const sub = clusterPoints(pts, maxSize).labels;
      const parts = new Map();
      sub.forEach((g, k) => { if (!parts.has(g)) parts.set(g, []); parts.get(g).push(idx[k]); });
      for (const part of parts.values()) {
        if (diameterKm(part.map(i => points[i])) <= span) blocks.push(part); else part.forEach(i => blocks.push([i]));
      }
    }

    // 2. Merge blocks, closest first, within the size and distance limits.
    const K = blocks.length;
    const members = blocks.map(b => b.slice());
    const alive = new Array(K).fill(true), ver = new Array(K).fill(0);
    const cent = members.map(m => ({ lat: m.reduce((a, i) => a + points[i].lat, 0) / m.length, lng: m.reduce((a, i) => a + points[i].lng, 0) / m.length }));
    const nb = Array.from({ length: K }, () => new Map()); // neighbour -> group diameter if merged
    const heap = new Heap();
    // Rough pre-filter in degrees, then exact complete-linkage distance.
    const latDeg = span === Infinity ? 1e9 : span / 110.5;
    const order = cent.map((c, i) => i).sort((a, b) => cent[a].lat - cent[b].lat);
    for (let x = 0; x < K; x++) {
      const a = order[x];
      for (let y = x + 1; y < K; y++) {
        const b = order[y];
        if (cent[b].lat - cent[a].lat > latDeg) break;
        if (distanceKm(cent[a], cent[b]) > span) continue; // centres farther than the limit: some pair is too
        let d = 0;
        for (const i of members[a]) for (const j of members[b]) { const dd = distanceKm(points[i], points[j]); if (dd > d) d = dd; }
        d = Math.max(d, diameterKm(members[a].map(i => points[i])), diameterKm(members[b].map(i => points[i])));
        if (d > span) continue;
        nb[a].set(b, d); nb[b].set(a, d);
        if (members[a].length + members[b].length <= maxSize) heap.push([d, a, b, 0, 0]);
      }
    }
    while (heap.a.length) {
      const [, a, b, va, vb] = heap.pop();
      if (!alive[a] || !alive[b] || ver[a] !== va || ver[b] !== vb) continue;
      if (members[a].length + members[b].length > maxSize) continue;
      // merge b into a
      members[a] = members[a].concat(members[b]);
      alive[b] = false; ver[a]++;
      const merged = new Map();
      for (const [x, da] of nb[a]) {
        if (x === b || !alive[x]) continue;
        const db = nb[b].get(x);
        nb[x].delete(a); nb[x].delete(b);
        if (db === undefined) continue; // too far from something in b
        const d = Math.max(da, db);
        merged.set(x, d); nb[x].set(a, d);
      }
      for (const [x] of nb[b]) if (alive[x]) nb[x].delete(b);
      nb[a] = merged; nb[b] = new Map();
      for (const [x, d] of merged) {
        if (members[a].length + members[x].length <= maxSize) heap.push(a < x ? [d, a, x, ver[a], ver[x]] : [d, x, a, ver[x], ver[a]]);
      }
    }

    // Number groups in reading order (north -> south in ~15 km bands, then west -> east).
    const groups = [];
    for (let k = 0; k < K; k++) if (alive[k]) {
      const m = members[k];
      groups.push({ m, lat: m.reduce((s, i) => s + points[i].lat, 0) / m.length, lng: m.reduce((s, i) => s + points[i].lng, 0) / m.length });
    }
    groups.sort((g, h) => Math.round(h.lat * 110.5 / 15) - Math.round(g.lat * 110.5 / 15) || g.lng - h.lng);
    const labels = new Array(n);
    groups.forEach((g, gi) => g.m.forEach(i => { labels[i] = gi; }));
    return { labels, groups: groups.length, oversized: groups.filter(g => g.m.length > maxSize).length, splitTowns };
  }

  const api = { clusterPoints, groupByTownAndDistance, convexHull, distanceKm, diameterKm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Cluster = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* Client Clusters — renderer: automatic group names from towns, and search */
'use strict';

// =====================================================================
// Automatic group names: the main towns of each group ("Annecy · Seynod · Cran-Gevrier").
// Recomputed whenever members change; a name typed by the user (customName) is kept.
// =====================================================================
const townOf = c => titleCase((c.city || c.geo?.city || c.extra?.Folder?.split(' / ').pop() || '').trim());
const postcodeOf = c => String(c.postcode || c.geo?.postcode || '').trim();
const MAX_TOWNS_IN_NAME = 3;

function townsOfGroup(info) {
  const towns = new Map();
  for (const c of info.members) {
    const t = townOf(c);
    if (!t) continue;
    const e = towns.get(t) || { n: 0, lat: 0, lng: 0, k: 0 };
    e.n++;
    if (hasLoc(c)) { e.lat += c.lat; e.lng += c.lng; e.k++; }
    towns.set(t, e);
  }
  const centre = { lat: info.lat, lng: info.lng };
  return [...towns.entries()].map(([name, e]) => ({
    name, n: e.n,
    d: e.k && info.lat !== null ? Cluster.distanceKm({ lat: e.lat / e.k, lng: e.lng / e.k }, centre) : 1e9,
  })).sort((a, b) => b.n - a.n || a.d - b.d).map(t => t.name);
}

function arrondissement(base, pc) {
  const m = /^(paris|lyon|marseille)\b/i.exec(base);
  if (m && /^(75|69|13)\d{3}$/.test(pc)) {
    const n = m[1].toLowerCase() === 'lyon' ? +pc.slice(4) : +pc.slice(3);
    if ((m[1].toLowerCase() === 'paris' && pc.startsWith('75')) || (m[1].toLowerCase() === 'lyon' && pc.startsWith('6900')) || (m[1].toLowerCase() === 'marseille' && pc.startsWith('130'))) {
      if (n >= 1 && n <= 20) return n === 1 ? '1er' : `${n}e`;
    }
  }
  return `(${pc})`;
}

function compass(dLat, dLng) {
  const a = (Math.atan2(dLat, dLng) * 180 / Math.PI + 360) % 360; // 0 = east, 90 = north
  return ['East', 'North-East', 'North', 'North-West', 'West', 'South-West', 'South', 'South-East'][Math.round(a / 45) % 8];
}

function autoNameGroups(byGroup) {
  const infos = [...byGroup.values()];
  const auto = infos.filter(i => !i.group.customName);
  const proposed = new Map();
  for (const info of auto) {
    const towns = townsOfGroup(info).slice(0, MAX_TOWNS_IN_NAME);
    proposed.set(info, towns.length ? towns.join(' · ') : `Group ${info.group.number}`);
  }
  // Same name for several groups (e.g. three groups inside one city): tell them apart.
  const taken = new Set(infos.filter(i => i.group.customName).map(i => i.group.name));
  const byName = new Map();
  for (const [info, name] of proposed) { if (!byName.has(name)) byName.set(name, []); byName.get(name).push(info); }
  for (const [base, list] of byName) {
    if (list.length === 1 && !taken.has(base)) continue;
    // a) main postcode / arrondissement ("Lyon 3e", "Grenoble (38100)")
    const pcs = list.map(info => {
      const f = {};
      for (const c of info.members) { const p = postcodeOf(c); if (p) f[p] = (f[p] || 0) + 1; }
      return Object.entries(f).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    });
    let names = null;
    if (pcs.every(Boolean) && new Set(pcs).size === pcs.length) names = list.map((_, i) => `${base} ${arrondissement(base, pcs[i])}`);
    // b) direction from the middle of these groups ("Lyon – North")
    if (!names) {
      const located = list.filter(i => i.lat !== null);
      if (located.length === list.length && list.length > 1) {
        const mLat = list.reduce((a, i) => a + i.lat, 0) / list.length, mLng = list.reduce((a, i) => a + i.lng, 0) / list.length;
        const dirs = list.map(i => compass(i.lat - mLat, (i.lng - mLng) * Math.cos(mLat * Math.PI / 180)));
        if (new Set(dirs).size === dirs.length) names = dirs.map(d => `${base} – ${d}`);
      }
    }
    // c) numbers
    if (!names) {
      const order = list.slice().sort((a, b) => a.group.number - b.group.number);
      names = list.map(i => `${base} ${order.indexOf(i) + 1}`);
    }
    list.forEach((info, i) => proposed.set(info, names[i]));
  }
  let changed = false;
  for (const [info, name] of proposed) if (info.group.name !== name) { info.group.name = name; changed = true; }
  return changed;
}

// Look up the town for clients that have a position but no city (KMZ imports, pins placed by hand).
let townJob = false;
async function fillMissingTowns() {
  if (townJob) return;
  const todo = state.data.clients.filter(c => hasLoc(c) && !c.city && !c.geo?.city && !c.geo?.townTried);
  if (!todo.length) return;
  townJob = true;
  try {
    let found = 0, last = Date.now();
    for (const c of todo) {
      let r;
      try { r = await window.api.townAt({ lat: c.lat, lng: c.lng }); } catch { r = null; }
      if (!r || (r.error && !/No town/.test(r.error))) break; // offline: try again next time
      c.geo = { ...(c.geo || {}), townTried: true };
      if (r.city) { c.geo.city = r.city; c.geo.postcode = c.geo.postcode || r.postcode || ''; found++; }
      if (Date.now() - last > 1500) { last = Date.now(); save(); renderAll(); }
    }
    if (found) { save(); renderAll(); }
  } finally { townJob = false; }
}

function matchesSearch(c) {
  if (!state.search) return true;
  const q = norm(state.search);
  const g = c.groupId && groupById(c.groupId);
  return norm([c.name, c.address, c.postcode, c.city, c.notes, g ? g.name : '', g ? '#' + g.number : ''].join(' ')).includes(q);
}

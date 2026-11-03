/* Client Clusters — renderer (UI, map, grouping and visit tracking) */
'use strict';

// =====================================================================
// Utilities
// =====================================================================
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isoToDate(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
function daysSince(iso) {
  if (!iso) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((t - isoToDate(iso)) / 86400000));
}
const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDate = iso => (iso ? dateFmt.format(isoToDate(iso)) : '');
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDay = iso => (iso ? dayFmt.format(isoToDate(iso)) : '');
const shortDateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const fmtShort = iso => (iso ? shortDateFmt.format(isoToDate(iso)) : '');
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function addDaysISO(iso, n) {
  const d = isoToDate(iso); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Next Monday–Friday after `iso` (or `iso` itself when allowed).
function nextWorkday(iso, includeSelf = false) {
  let d = includeSelf ? iso : addDaysISO(iso, 1);
  while ([0, 6].includes(isoToDate(d).getDay())) d = addDaysISO(d, 1);
  return d;
}
function fmtAgo(days) {
  if (days === null || days === undefined) return 'Never visited';
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `${Math.round(days / 30.4)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}
function shortAgo(days) {
  if (days === null || days === undefined) return 'Never';
  if (days === 0) return 'Today';
  if (days < 60) return `${days} d`;
  if (days < 730) return `${Math.round(days / 30.4)} mo`;
  return `${Math.round(days / 365)} y`;
}

// Parse dates as found in spreadsheets: 2025-03-14, 14/03/2025, 14-03-25, Excel serials.
function parseDateLoose(s) {
  s = String(s ?? '').trim();
  if (!s) return null;
  let m;
  const ok = (y, mo, d) => {
    if (y < 100) y += 2000;
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return ok(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/))) return ok(+m[3], +m[2], +m[1]); // day first
  if (/^\d{5}(\.\d+)?$/.test(s)) { // Excel serial date
    const n = parseFloat(s);
    if (n > 20000 && n < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
      return ok(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
  }
  return null;
}
function parseCoord(s, max) {
  const v = parseFloat(String(s ?? '').replace(',', '.').trim());
  return Number.isFinite(v) && Math.abs(v) <= max ? v : null;
}
// Title-case only text typed all in capitals or all in lower case; keep "Villefranche-sur-Saône" as is.
const titleCase = s => (String(s) !== String(s).toUpperCase() && String(s) !== String(s).toLowerCase()) ? String(s) : String(s).toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

const PALETTE = ['#2563eb', '#d9480f', '#0f8a6c', '#9333ea', '#c2185b', '#0e7490', '#a16207', '#4338ca', '#15803d', '#b91c1c', '#0369a1', '#8d5524'];
const STATUS_COLORS = { ok: '#2e8a57', due: '#d08a1d', late: '#c4402c', never: '#8b8d86' };
const NEVER = 1e6;

// =====================================================================
// State
// =====================================================================
const DEFAULT_TIERS = { A: { due: 21, over: 35 }, B: { due: 45, over: 75 }, C: { due: 90, over: 150 } };
const DEFAULT_SETTINGS = {
  maxSize: 6, flexSize: 8, maxSpanKm: 50, dueDays: 30, overdueDays: 60, colorBy: 'group', home: null, hoursRefreshDays: 90,
  tiers: DEFAULT_TIERS,
  // Day planning
  dayStart: '08:30', dayEnd: '18:00', visitMin: 30, maxStops: 8, speedKmh: 45, planRadiusKm: 25,
};
const state = {
  gjob: null,                // Google opening-hours lookup in progress: { total, done, stop }
  googleKey: { hasKey: false, masked: '' },
  data: { version: 1, settings: { ...DEFAULT_SETTINGS }, clients: [], groups: [] },
  tab: 'groups',
  sort: { groups: 'number', clients: 'name' },
  search: '',
  clientFilter: null,        // 'unlocated' | null
  selectedDay: null,         // ISO date shown on the map in the Planned tab
  selection: new Set(),      // clients picked on the map (shift-drag / ctrl-click)
  selectedClientId: null,
  selectedGroupId: null,
  placingClientId: null,
  geocoding: null,           // { total, done, stop }
  derived: null,
};
const S = () => state.data.settings;
const clientById = id => state.data.clients.find(c => c.id === id);
const groupById = id => state.data.groups.find(g => g.id === id);
const hasLoc = c => Number.isFinite(c.lat) && Number.isFinite(c.lng);
const homeOf = () => { const h = S().home; return h && Number.isFinite(h.lat) && Number.isFinite(h.lng) ? h : null; };
const fmtKm = km => (km < 10 ? km.toFixed(1).replace(/\.0$/, '') : Math.round(km)) + ' km';
// Opening hours (from the client's Google business page, or typed by hand)
const hoursOf = c => (c.gbp && Hours.known(c.gbp.hours) ? c.gbp.hours : null);
const needsGoogleCheck = c => !!c.gbp && (c.gbp.status === 'review' || c.gbp.status === 'notfound');
const notLookedUp = c => !c.gbp || c.gbp.status === 'pending';

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 250);
}
function flushSave() {
  clearTimeout(saveTimer);
  window.api.saveData(state.data).catch(e => toast('Could not save: ' + e.message, { error: true }));
}
window.addEventListener('beforeunload', () => { if (saveTimer) flushSave(); });

// =====================================================================
// Derived values (visit status, group summaries)
// =====================================================================
// ---------- Visits ----------
// A visit is { id, date, note, status: 'done' | 'planned' | 'cancelled', type: 'visit' | 'call', outcome, order? }.
// Only done in-person visits where someone was met count as the "last visit".
// A planned visit whose date has passed stays planned ("not confirmed") until it is marked done or cancelled.
const VISIT_TYPES = { visit: 'Visit', call: 'Phone call' };
const OUTCOMES = { '': 'No outcome', ok: 'Went well', order: 'Order taken', followup: 'Follow-up needed', absent: 'Nobody available', closed: 'Closed on arrival' };
const NO_MEETING = new Set(['absent', 'closed']);
const vStatus = v => v.status || (v.date > todayISO() ? 'planned' : 'done');
const countsAsVisit = v => vStatus(v) === 'done' && (v.type || 'visit') === 'visit' && !NO_MEETING.has(v.outcome);
function normalizeVisits(c) {
  c.visits = (c.visits || []).filter(v => v && v.date);
  for (const v of c.visits) {
    if (!v.id) v.id = uid();
    if (!v.status) v.status = v.date > todayISO() ? 'planned' : 'done';
    if (!v.type) v.type = 'visit';
    if (v.outcome === undefined) v.outcome = '';
    if (v.note === undefined) v.note = '';
  }
  return c;
}
function lastVisit(c) {
  const t = todayISO();
  let best = null;
  for (const v of c.visits || []) if (countsAsVisit(v) && v.date <= t && (!best || v.date > best)) best = v.date;
  return best;
}
const plannedOf = c => (c.visits || []).filter(v => vStatus(v) === 'planned');
function nextPlannedVisit(c) {
  const t = todayISO();
  let best = null;
  for (const v of plannedOf(c)) if (v.date >= t && (!best || v.date < best)) best = v.date;
  return best;
}
const unconfirmedOf = c => plannedOf(c).filter(v => v.date < todayISO());
const doneToday = c => (c.visits || []).some(v => v.date === todayISO() && countsAsVisit(v));
const plannedToday = c => plannedOf(c).some(v => v.date === todayISO() && (v.type || 'visit') === 'visit');

// Records a visit. A visit marked done on a day when one was planned confirms that planned visit.
function recordVisit(c, { date, note = '', type = 'visit', outcome = '', status, order } = {}) {
  c.visits = c.visits || [];
  const st = status || (date > todayISO() ? 'planned' : 'done');
  if (st === 'done' && type === 'visit') { // a phone call doesn't confirm a planned visit
    const p = c.visits.find(v => vStatus(v) === 'planned' && v.date === date && (v.type || 'visit') === type);
    if (p) { Object.assign(p, { status: 'done', note: note || p.note || '', type, outcome, confirmedFrom: 'planned' }); return p; }
  }
  if (st === 'planned') {
    const p = c.visits.find(v => vStatus(v) === 'planned' && v.date === date && (v.type || 'visit') === type);
    if (p) { if (note) p.note = note; return p; }
  }
  const v = { id: uid(), date, note, type, outcome, status: st };
  if (order !== undefined) v.order = order;
  c.visits.push(v);
  return v;
}
function addVisit(c, date, note = '') { return recordVisit(c, { date, note }); }
// Undo "mark done": a confirmed planned visit goes back to planned, any other is removed.
function undoDone(c, v) {
  if (v.confirmedFrom === 'planned') { v.status = 'planned'; v.outcome = ''; delete v.confirmedFrom; }
  else c.visits = c.visits.filter(x => x !== v);
}

// ---------- Priority (A/B/C) and visit status ----------
const TIER_NAMES = { A: 'A — key client', B: 'B — regular', C: 'C — occasional' };
function thresholds(c) {
  const t = c && c.tier && S().tiers && S().tiers[c.tier];
  return t ? { due: t.due, over: t.over } : { due: S().dueDays, over: S().overdueDays };
}
function statusOfDays(days, c) {
  if (days === null || days === undefined) return 'never';
  const th = thresholds(c);
  if (days >= th.over) return 'late';
  if (days >= th.due) return 'due';
  return 'ok';
}
function clientStatus(c) { return statusOfDays(daysSince(lastVisit(c)), c); }
// How pressing a visit is: 1 when just due, 2 when twice the due delay has passed, etc.
const NEVER_URGENCY = 1.25;
function urgencyOf(c) {
  const d = daysSince(lastVisit(c));
  return d === null ? NEVER_URGENCY : d / Math.max(1, thresholds(c).due);
}
function parseTier(s) {
  const t = String(s ?? '').trim().toUpperCase();
  if (/^[ABC](\b|$)/.test(t)) return t[0];
  return { 1: 'A', 2: 'B', 3: 'C' }[t] || '';
}

function derive() {
  const byGroup = new Map();
  for (const g of state.data.groups) byGroup.set(g.id, { group: g, members: [] });
  for (const c of state.data.clients) {
    const info = c.groupId && byGroup.get(c.groupId);
    if (info) info.members.push(c);
    else if (c.groupId) c.groupId = null; // dangling reference
  }
  for (const info of byGroup.values()) {
    const loc = info.members.filter(hasLoc);
    info.lat = loc.length ? loc.reduce((a, c) => a + c.lat, 0) / loc.length : null;
    info.lng = loc.length ? loc.reduce((a, c) => a + c.lng, 0) / loc.length : null;
    let urgency = -1, neverCount = 0, oldest = null, worst = 0, planned = 0, nextPlan = null;
    const RANK = { ok: 0, due: 1, late: 2 };
    for (const c of info.members) {
      const d = daysSince(lastVisit(c));
      urgency = Math.max(urgency, urgencyOf(c));
      if (d === null) neverCount++;
      else { if (oldest === null || d > oldest) oldest = d; worst = Math.max(worst, RANK[clientStatus(c)]); }
      const np = nextPlannedVisit(c);
      if (np) { planned++; if (!nextPlan || np < nextPlan) nextPlan = np; }
    }
    info.urgency = urgency;
    info.neverCount = neverCount;
    info.oldestDays = oldest;
    info.plannedCount = planned;
    info.nextPlanned = nextPlan;
    // Worst status among clients visited at least once (each judged against its own priority).
    info.status = info.members.length === 0 ? 'ok' : (oldest !== null ? ['ok', 'due', 'late'][worst] : 'never');
    let spread = 0;
    for (const a of loc) for (const b of loc) spread = Math.max(spread, Cluster.distanceKm(a, b));
    info.spreadKm = spread;
  }
  const home = homeOf();
  for (const info of byGroup.values()) info.homeKm = home && info.lat !== null ? Cluster.distanceKm(home, info) : null;
  const renumbered = home ? renumberFromHome([...byGroup.values()]) : false;
  if (autoNameGroups(byGroup) || renumbered) save();
  const clients = state.data.clients;
  state.derived = {
    byGroup,
    googleReview: clients.filter(needsGoogleCheck),
    unlocated: clients.filter(c => !hasLoc(c) && c.geo?.status !== 'pending'),
    pending: clients.filter(c => !hasLoc(c) && c.geo?.status === 'pending'),
    ungrouped: clients.filter(c => hasLoc(c) && !c.groupId),
    unconfirmed: clients.flatMap(c => unconfirmedOf(c).map(v => ({ c, v }))).sort((a, b) => a.v.date.localeCompare(b.v.date) || a.c.name.localeCompare(b.c.name)),
    upcoming: clients.reduce((n, c) => n + plannedOf(c).filter(v => v.date >= todayISO()).length, 0),
  };
  if (state.selection.size) for (const id of [...state.selection]) if (!clientById(id)) state.selection.delete(id);
}

// With a home address, group 1 is the group nearest to home, then 2, 3… (straight-line distance from
// home to the middle of the group). Kept up to date like the group names.
function renumberFromHome(infos) {
  const sorted = infos.slice().sort((a, b) => (a.homeKm ?? 1e9) - (b.homeKm ?? 1e9) || a.group.number - b.group.number);
  let changed = false;
  sorted.forEach((info, i) => { if (info.group.number !== i + 1) { info.group.number = i + 1; changed = true; } });
  return changed;
}

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

// =====================================================================
// Map
// =====================================================================
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([46.6, 2.4], 6);
L.control.zoom({ position: 'topleft' }).addTo(map);
// Free map backgrounds, no API key needed.
const BASEMAPS = {
  'Plan IGN (France)': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.ign.fr/">IGN</a> Géoplateforme',
  }),
  'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }),
};
let basemapName = 'Plan IGN (France)';
try { const saved = localStorage.getItem('basemap'); if (BASEMAPS[saved]) basemapName = saved; } catch { /* ignore */ }
BASEMAPS[basemapName].addTo(map);
L.control.layers(BASEMAPS, null, { position: 'topleft' }).addTo(map);
map.on('baselayerchange', e => { try { localStorage.setItem('basemap', e.name); } catch { /* ignore */ } });
// If the chosen background fails to load (offline or service down), switch to the other one once.
let tileErrors = 0, switched = false;
Object.entries(BASEMAPS).forEach(([name, layer]) => layer.on('tileerror', () => {
  if (switched || !map.hasLayer(layer) || ++tileErrors < 8) return;
  switched = true;
  const other = Object.keys(BASEMAPS).find(n => n !== name);
  map.removeLayer(layer); BASEMAPS[other].addTo(map);
  toast(`The “${name}” map didn't load, switched to “${other}”.`);
}));
const hullLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const markerLayer = L.layerGroup().addTo(map);
const markers = new Map();

function groupColor(c) {
  const g = c.groupId && groupById(c.groupId);
  return g ? g.color : '#6b6d66';
}

function renderMap() {
  markerLayer.clearLayers(); hullLayer.clearLayers(); routeLayer.clearLayers(); markers.clear();
  const colorBy = S().colorBy;
  const selG = state.tab === 'planned' ? null : state.selectedGroupId;
  // Planned tab with a day picked: that day's stops are numbered and joined by the route.
  const day = state.tab === 'planned' && state.selectedDay ? dayPlan(state.selectedDay) : null;
  const stopNo = new Map();
  if (day) {
    day.stops.forEach((s, i) => { if (hasLoc(s.c)) stopNo.set(s.c.id, i + 1); });
    const pts = day.stops.filter(s => hasLoc(s.c)).map(s => [s.c.lat, s.c.lng]);
    const home = homeOf();
    const line = home && pts.length ? [[home.lat, home.lng], ...pts, [home.lat, home.lng]] : pts;
    if (line.length > 1) L.polyline(line, { color: '#0f6b62', weight: 3, opacity: 0.75, dashArray: '6 6', interactive: false }).addTo(routeLayer);
  }

  const prospecting = state.tab === 'prospecting';
  if (!day && !prospecting) for (const info of state.derived.byGroup.values()) {
    const pts = info.members.filter(hasLoc).map(c => [c.lat, c.lng]);
    if (pts.length < 2) continue;
    const dim = selG && selG !== info.group.id;
    const sel = selG === info.group.id;
    const style = {
      color: info.group.color, weight: sel ? 2.5 : 1.5, opacity: dim ? 0.25 : 0.8,
      fillColor: info.group.color, fillOpacity: dim ? 0.03 : sel ? 0.16 : 0.08, interactive: true,
    };
    const shape = pts.length === 2 ? L.polyline(pts, style) : L.polygon(Cluster.convexHull(pts), style);
    shape.on('click', e => { if (state.placingClientId) return; L.DomEvent.stopPropagation(e); selectGroup(info.group.id, { fit: false }); });
    shape.addTo(hullLayer);
  }

  for (const c of state.data.clients) {
    if (!hasLoc(c)) continue;
    const g = c.groupId && groupById(c.groupId);
    const st = clientStatus(c);
    const n = stopNo.get(c.id);
    const bg = n ? '#0f6b62' : colorBy === 'status' ? STATUS_COLORS[st] : groupColor(c);
    const dim = prospecting || (day && !n) || (selG && c.groupId !== selG) || (state.search && !matchesSearch(c));
    const sel = c.id === state.selectedClientId;
    const np = nextPlannedVisit(c);
    const cls = ['pin', dim && 'dim', sel && 'sel', np && !n && 'has-plan', state.selection.has(c.id) && 'picked', n && 'stop'].filter(Boolean).join(' ');
    const html = `<div class="${cls}" style="background:${bg}">${n || (g ? g.number : '·')}</div>`;
    const m = L.marker([c.lat, c.lng], {
      icon: L.divIcon({ className: '', html, iconSize: [22, 22], iconAnchor: [11, 11] }),
      zIndexOffset: sel ? 2000 : n ? 1500 : dim ? -500 : 0,
      keyboard: false,
    });
    const lv = lastVisit(c);
    const hs = hoursOf(c) && Hours.status(hoursOf(c));
    m.bindTooltip(`<b>${esc(c.name)}</b><span>${n ? `Stop ${n} · ` : g ? 'Group ' + g.number + ' · ' : ''}${esc(lv ? 'Last visit ' + fmtDate(lv) : 'Never visited')}${c.tier ? ` · Priority ${c.tier}` : ''}${np ? `<br>Planned ${esc(fmtDay(np))}` : ''}${hs ? `<br><i class="${hs.open ? 'open' : 'closed'}">${esc(hs.text)}</i>` : ''}</span>`,
      { className: 'tip', direction: 'top', offset: [0, -12] });
    m.on('click', e => {
      L.DomEvent.stopPropagation(e);
      if (e.originalEvent && (e.originalEvent.ctrlKey || e.originalEvent.metaKey || e.originalEvent.shiftKey)) { toggleSelection([c.id]); return; }
      selectClient(c.id, { pan: false });
    });
    m.addTo(markerLayer);
    markers.set(c.id, m);
  }

  const home = homeOf();
  if (home) {
    const hm = L.marker([home.lat, home.lng], {
      icon: L.divIcon({ className: '', html: '<div class="home-pin"><svg width="14" height="14" viewBox="0 0 24 24"><path d="M3.5 11.2L12 4l8.5 7.2M6 9.6V20h4.4v-5.6h3.2V20H18V9.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/></svg></div>', iconSize: [28, 28], iconAnchor: [14, 14] }),
      zIndexOffset: 3000, keyboard: false,
    });
    hm.bindTooltip(`<b>Home</b><span>${esc(home.label || home.address)}<br>Groups are numbered from here, nearest first</span>`, { className: 'tip', direction: 'top', offset: [0, -14] });
    hm.on('click', e => L.DomEvent.stopPropagation(e));
    hm.addTo(markerLayer);
  }
  if (typeof renderProspectLayer === 'function') renderProspectLayer();
}

function fitAll() {
  const pts = state.data.clients.filter(hasLoc).map(c => [c.lat, c.lng]);
  if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 13 });
}
function fitPoints(pts) {
  if (!pts.length) return;
  const right = $('#detail').hidden ? 40 : 400;
  map.fitBounds(pts, { paddingTopLeft: [40, 40], paddingBottomRight: [right, 40], maxZoom: 14 });
}

// ---------- Picking several clients on the map: shift-drag a box, or ctrl/shift-click pins ----------
map.boxZoom.disable();
let lasso = null, lassoJustEnded = false;
map.on('mousedown', e => {
  if (!e.originalEvent.shiftKey || state.placingClientId || e.originalEvent.button !== 0) return;
  e.originalEvent.preventDefault();
  document.body.classList.add('lassoing');
  map.dragging.disable();
  lasso = { start: e.latlng, startPt: e.containerPoint, rect: L.rectangle([e.latlng, e.latlng], { color: '#1e1f1c', weight: 1.5, dashArray: '4 4', fillOpacity: 0.06, interactive: false }).addTo(map) };
});
map.on('mousemove', e => { if (lasso) { lasso.end = e.containerPoint; lasso.rect.setBounds(L.latLngBounds(lasso.start, e.latlng)); } });
function endLasso() {
  if (!lasso) return;
  const { rect, startPt, end } = lasso;
  const b = rect.getBounds();
  map.removeLayer(rect); lasso = null; map.dragging.enable();
  document.body.classList.remove('lassoing');
  try { window.getSelection().removeAllRanges(); } catch { /* ignore */ }
  if (!end || startPt.distanceTo(end) < 6) return; // a shift-click, not a box
  lassoJustEnded = true; setTimeout(() => { lassoJustEnded = false; }, 50);
  const ids = state.data.clients.filter(c => hasLoc(c) && b.contains([c.lat, c.lng])).map(c => c.id);
  ids.forEach(id => state.selection.add(id));
  renderMap(); renderSelectBar();
  if (!ids.length) toast('No client in that box.');
}
map.on('mouseup', endLasso);
document.addEventListener('mouseup', endLasso);
function toggleSelection(ids) {
  for (const id of ids) { if (state.selection.has(id)) state.selection.delete(id); else state.selection.add(id); }
  renderMap(); renderSelectBar();
}
function clearSelection() { state.selection.clear(); renderMap(); renderSelectBar(); }
function renderSelectBar() {
  const bar = $('#select-bar');
  const ids = [...state.selection];
  bar.hidden = !ids.length;
  if (!ids.length) { bar.innerHTML = ''; return; }
  const due = ids.map(clientById).filter(c => c && ['due', 'late', 'never'].includes(clientStatus(c))).length;
  bar.innerHTML = `<span><b>${ids.length} client${ids.length > 1 ? 's' : ''} selected</b>${due ? ` · ${due} due or overdue` : ''}</span>
    <button class="btn small primary" data-sel="planday">Plan a day with them…</button>
    <button class="btn small" data-sel="plan">Plan visits…</button>
    <button class="btn small" data-sel="log">Log visits…</button>
    <select data-sel="tier" title="Set the priority of the selected clients"><option value="">Priority…</option>${Object.keys(TIER_NAMES).map(t => `<option value="${t}">${esc(TIER_NAMES[t])}</option>`).join('')}<option value="none">No priority</option></select>
    <button class="btn small ghost" data-sel="clear" title="Clear the selection (Esc)">Clear</button>`;
}
$('#select-bar').addEventListener('click', e => {
  const act = e.target.closest('button[data-sel]')?.dataset.sel;
  if (!act) return;
  const ids = [...state.selection];
  if (act === 'clear') clearSelection();
  if (act === 'plan') visitDialog({ ids, mode: 'plan', title: `${ids.length} selected client${ids.length > 1 ? 's' : ''}` });
  if (act === 'log') visitDialog({ ids, mode: 'log', title: `${ids.length} selected client${ids.length > 1 ? 's' : ''}` });
  if (act === 'planday') planDayDialog({ only: ids });
});
$('#select-bar').addEventListener('change', e => {
  if (e.target.dataset.sel !== 'tier' || !e.target.value) return;
  const t = e.target.value === 'none' ? '' : e.target.value;
  const ids = [...state.selection];
  ids.forEach(id => { const c = clientById(id); if (c) c.tier = t; });
  save(); renderAll(); renderDetail();
  toast(`${ids.length} client${ids.length > 1 ? 's' : ''} set to ${t ? 'priority ' + t : 'no priority'}.`);
});

map.on('click', e => {
  if (lassoJustEnded) return;
  if (state.placingClientId) {
    const c = clientById(state.placingClientId);
    stopPlacing();
    if (!c) return;
    c.lat = e.latlng.lat; c.lng = e.latlng.lng;
    c.geo = { status: 'manual', label: 'Placed by hand on the map', score: 1, source: 'manual' }; // town looked up again
    if (!c.groupId && state.data.groups.length) assignToNearest([c], { quiet: true });
    save(); renderAll(); renderDetail();
    const left = state.data.clients.filter(x => !hasLoc(x)).length;
    toast(`${c.name} placed on the map.${left ? ` ${left} still to place.` : ''}`, left ? { action: { label: 'Next', fn: reviewUnlocated } } : {});
    return;
  }
  if (state.selectedClientId || state.selectedGroupId) {
    state.selectedClientId = null; state.selectedGroupId = null;
    renderAll(); renderDetail();
  }
});

function renderLegend() {
  if (state.tab === 'prospecting') {
    $('#legend').innerHTML = prospectLegend();
    $('#legend').hidden = !state.data.prospecting;
    return;
  }
  const by = S().colorBy;
  let keys;
  const tiers = state.data.clients.some(c => c.tier);
  if (state.tab === 'planned' && state.selectedDay) {
    keys = `<div class="key"><i style="background:#0f6b62"></i>${esc(fmtDay(state.selectedDay))}: stops in visiting order</div>`;
  } else if (by === 'status') {
    keys = tiers ? `
      <div class="key"><i style="background:${STATUS_COLORS.ok}"></i>Up to date</div>
      <div class="key"><i style="background:${STATUS_COLORS.due}"></i>Due</div>
      <div class="key"><i style="background:${STATUS_COLORS.late}"></i>Overdue</div>
      <div class="key"><i style="background:${STATUS_COLORS.never}"></i>Never visited</div>
      <div class="key sub">Delays depend on each client's priority (A/B/C)</div>` : `
      <div class="key"><i style="background:${STATUS_COLORS.ok}"></i>Visited in the last ${S().dueDays} days</div>
      <div class="key"><i style="background:${STATUS_COLORS.due}"></i>${S().dueDays}–${S().overdueDays - 1} days ago</div>
      <div class="key"><i style="background:${STATUS_COLORS.late}"></i>${S().overdueDays}+ days ago</div>
      <div class="key"><i style="background:${STATUS_COLORS.never}"></i>Never visited</div>`;
  } else {
    keys = `<div class="key">Each colour is a group · the number on a pin is its group</div>`;
  }
  if (!(state.tab === 'planned' && state.selectedDay)) {
    keys += `${state.data.clients.some(nextPlannedVisit) ? '<div class="key"><i class="ring"></i>Visit planned</div>' : ''}
      <div class="key sub">Shift-drag on the map to select clients</div>`;
  }
  $('#legend').innerHTML = `
    <div class="seg"><button data-color="group" class="${by === 'group' ? 'on' : ''}">Colour by group</button><button data-color="status" class="${by === 'status' ? 'on' : ''}">By last visit</button></div>
    <div class="keys">${keys}</div>`;
  $('#legend').hidden = !state.data.clients.some(hasLoc);
}
$('#legend').addEventListener('click', e => {
  const b = e.target.closest('[data-color]');
  if (!b) return;
  S().colorBy = b.dataset.color; save(); renderMap(); renderLegend();
});

// =====================================================================
// Sidebar
// =====================================================================
function renderStats() {
  const cl = state.data.clients;
  let late = 0, never = 0;
  for (const c of cl) { const s = clientStatus(c); if (s === 'late') late++; if (s === 'never') never++; }
  const up = state.derived.upcoming;
  $('#stats').innerHTML = `
    <div class="stat"><b>${cl.length}</b><span>Clients</span></div>
    <div class="stat${late ? ' late' : ''}" title="Overdue for their visit (each client against its own priority)"><b>${late}</b><span>Overdue</span></div>
    <div class="stat"><b>${never}</b><span>Never visited</span></div>
    <button class="stat link-stat" data-stat="planned" title="Show planned visits"><b>${up}</b><span>Planned</span></button>`;
}
$('#stats').addEventListener('click', e => {
  if (e.target.closest('[data-stat="planned"]')) { state.tab = 'planned'; renderAll(); renderDetail(); }
});

const SORTS = {
  groups: [['number', 'Group number'], ['urgent', 'Most overdue first'], ['name', 'Name']],
  clients: [['name', 'Name A–Z'], ['urgent', 'Most overdue first'], ['planned', 'Next planned visit'], ['group', 'Group'], ['city', 'City']],
  planned: [],
  prospecting: [],
};
const TAB_LABELS = { groups: 'Groups', clients: 'Clients', planned: 'Planned', prospecting: 'Prospects' };
function renderTabs() {
  document.querySelectorAll('.tab').forEach(t => {
    const k = t.dataset.tab;
    const n = k === 'groups' ? state.data.groups.length : k === 'clients' ? state.data.clients.length : k === 'prospecting' ? (state.data.prospecting?.prospects.length || 0) : state.derived.upcoming;
    const warn = k === 'planned' && state.derived.unconfirmed.length;
    t.classList.toggle('active', k === state.tab);
    t.innerHTML = `${TAB_LABELS[k]}<span class="count">${n}</span>${warn ? `<span class="dot-warn" title="${warn} planned visit${warn > 1 ? 's' : ''} not confirmed"></span>` : ''}`;
  });
  SORTS.groups[0][1] = homeOf() ? 'Nearest to home' : 'Group number';
  $('#sort').innerHTML = SORTS[state.tab].map(([v, l]) => `<option value="${v}"${state.sort[state.tab] === v ? ' selected' : ''}>${l}</option>`).join('');
  $('.sort-wrap').hidden = !SORTS[state.tab].length;
}

function renderBanners() {
  const d = state.derived, out = [];
  if (state.tab === 'prospecting') { $('#banners').innerHTML = ''; return; }
  if (d.unconfirmed.length && state.tab !== 'planned') {
    const n = d.unconfirmed.length;
    out.push(`<div class="banner">${n} planned visit${n > 1 ? 's have' : ' has'} passed without being confirmed. Did ${n > 1 ? 'they' : 'it'} happen?<div class="acts"><button class="btn small primary" data-b="unconfirmed">Review</button></div></div>`);
  }
  if (state.data.demo) {
    out.push(`<div class="banner info">You're looking at demo data.<div class="acts"><button class="btn small primary" data-b="demo-clear">Clear it and import my list</button></div></div>`);
  }
  if (d.pending.length && !state.geocoding) {
    out.push(`<div class="banner">${d.pending.length} address${d.pending.length > 1 ? 'es' : ''} still to place on the map.<div class="acts"><button class="btn small" data-b="locate">Locate now</button></div></div>`);
  }
  if (d.unlocated.length && state.clientFilter !== 'unlocated') {
    const names = d.unlocated.slice(0, 3).map(c => `<b>${esc(c.name)}</b>`).join(', ') + (d.unlocated.length > 3 ? ` and ${d.unlocated.length - 3} more` : '');
    out.push(`<div class="banner">${d.unlocated.length} client${d.unlocated.length > 1 ? 's are' : ' is'} not on the map because the address wasn't found: ${names}.<div class="acts"><button class="btn small primary" data-b="review-unlocated">Review and fix</button><button class="btn small" data-b="show-unlocated">Show in client list</button></div></div>`);
  }
  if (d.ungrouped.length && state.data.groups.length) {
    out.push(`<div class="banner">${d.ungrouped.length} client${d.ungrouped.length > 1 ? 's are' : ' is'} not in a group yet.<div class="acts"><button class="btn small" data-b="nearest">Add to nearest groups</button><button class="btn small" data-b="regroup">Regroup everything</button></div></div>`);
  }
  if (state.tab === 'clients' && state.clientFilter === 'unlocated') {
    out.push(`<div class="banner info">Showing clients that aren't on the map. Open one to fix its address or place it by hand.<div class="acts"><button class="btn small" data-b="filter-clear">Show all clients</button></div></div>`);
  }
  if (d.googleReview.length && !state.gjob) {
    const n = d.googleReview.length;
    out.push(`<div class="banner">Opening hours: ${n} client${n > 1 ? 's' : ''} couldn't be matched to a Google business page for sure.<div class="acts"><button class="btn small primary" data-b="google-review">Review and choose</button></div></div>`);
  }
  if (!state.googleKey.hasKey && !S().hoursPromptHidden && !state.data.demo && state.data.clients.length) {
    out.push(`<div class="banner info">See each client's opening hours: add a Google API key in Settings and the app links clients to their Google business page. You can also type hours by hand on a client's card.<div class="acts"><button class="btn small" data-b="google-setup">Set up</button><button class="btn small ghost" data-b="google-hide">Not now</button></div></div>`);
  }
  $('#banners').innerHTML = out.join('');
}
$('#banners').addEventListener('click', e => {
  const b = e.target.closest('[data-b]');
  if (!b) return;
  const act = b.dataset.b;
  if (act === 'unconfirmed') { state.tab = 'planned'; renderAll(); renderDetail(); }
  if (act === 'locate') geocodeClients(state.derived.pending).then(afterLocate);
  if (act === 'review-unlocated') reviewUnlocated();
  if (act === 'show-unlocated') { state.tab = 'clients'; state.clientFilter = 'unlocated'; renderAll(); }
  if (act === 'filter-clear') { state.clientFilter = null; renderAll(); }
  if (act === 'nearest') { assignToNearest(state.derived.ungrouped); save(); renderAll(); }
  if (act === 'regroup') regroup();
  if (act === 'demo-clear') clearAll(true);
  if (act === 'google-review') reviewGoogle();
  if (act === 'google-setup') settingsDialog({ focus: '#s-gkey' });
  if (act === 'google-hide') { S().hoursPromptHidden = true; save(); renderBanners(); }
});

function groupLabel(info) {
  if (!info.members.length) return '<span class="pill never">Empty</span>';
  if (info.oldestDays === null) return '<span class="pill never">Never visited</span>';
  const cls = info.status === 'late' ? 'late' : info.status === 'due' ? 'due' : 'ok';
  const txt = info.neverCount ? `${info.neverCount} never visited` : info.oldestDays === 0 ? 'All visited today' : `Oldest visit ${shortAgo(info.oldestDays)} ago`;
  return `<span class="pill ${info.neverCount ? 'never' : cls}" title="Longest time since a visit in this group: ${fmtAgo(info.oldestDays)}">${txt}</span>`;
}

function renderGroupsList() {
  const infos = [...state.derived.byGroup.values()];
  const visible = state.search ? infos.filter(i => i.members.some(matchesSearch) || norm(i.group.name).includes(norm(state.search)) || String(i.group.number) === state.search.trim().replace('#', '')) : infos;
  const s = state.sort.groups;
  visible.sort((a, b) => s === 'urgent' ? (b.urgency - a.urgency) || (a.group.number - b.group.number)
    : s === 'name' ? a.group.name.localeCompare(b.group.name) || a.group.number - b.group.number
      : a.group.number - b.group.number);
  if (!state.data.groups.length) {
    const located = state.data.clients.filter(hasLoc).length;
    return `<div class="none">${located ? `No groups yet.<br><br><button class="btn primary" data-act="regroup">Group ${located} clients by proximity</button>` : 'No groups yet.'}</div>`;
  }
  if (!visible.length) return `<div class="none">No group matches “${esc(state.search)}”.</div>`;
  const max = S().maxSize;
  return visible.map(info => {
    const g = info.group, sel = g.id === state.selectedGroupId;
    const towns = townsOfGroup(info);
    const extraTowns = g.customName ? towns : towns.slice(MAX_TOWNS_IN_NAME);
    const spreadTxt = info.spreadKm >= 0.1 ? `Within ${info.spreadKm < 10 ? info.spreadKm.toFixed(1) : Math.round(info.spreadKm)} km` : '';
    const subTxt = extraTowns.length ? (g.customName ? '' : 'Also ') + extraTowns.slice(0, 4).join(', ') + (extraTowns.length > 4 ? '…' : '') : spreadTxt || '—';
    const head = `
      <button class="row" data-group="${g.id}">
        <span class="swatch" style="background:${g.color}">${g.number}</span>
        <span class="main"><div class="title" title="${esc(g.name)}">${esc(g.name)}</div><div class="sub" title="${esc(towns.join(', '))}">${esc(subTxt)}</div></span>
        <span class="side"><span class="size${info.members.length > S().flexSize || (info.members.length > max && towns.length > 1) ? ' over' : ''}" title="${info.members.length > max ? (towns.length === 1 && info.members.length <= S().flexSize ? 'A bit over the usual size to keep ' + towns[0] + ' in one group' : 'More clients than the group size limit') : ''}">${info.members.length} client${info.members.length === 1 ? '' : 's'}</span>${info.homeKm !== null && info.homeKm !== undefined ? `<span class="homekm" title="From home to the middle of the group, as the crow flies">${fmtKm(info.homeKm)} from home</span>` : ''}${groupLabel(info)}${info.plannedCount ? `<span class="homekm plan-note" title="Clients of this group with a visit planned">${info.plannedCount} planned · next ${esc(fmtShort(info.nextPlanned))}</span>` : ''}</span>
      </button>`;
    if (!sel) return `<div class="group">${head}</div>`;
    const members = info.members.slice().sort((a, b) => urgencyOf(b) - urgencyOf(a) || a.name.localeCompare(b.name));
    const rows = members.map(c => memberRow(c)).join('');
    const withHours = info.members.filter(hoursOf).length;
    const openNow = info.members.filter(c => hoursOf(c) && Hours.status(hoursOf(c)).open).length;
    const spread = [towns.length > 1 ? `${towns.length} towns: ${towns.join(', ')}` : '', info.spreadKm >= 0.1 ? `all within about ${info.spreadKm < 10 ? info.spreadKm.toFixed(1) : Math.round(info.spreadKm)} km` : '',
      withHours ? `${openNow} of ${withHours} with known hours open now` : ''].filter(Boolean).join(' · ').replace(/^a/, 'A');
    return `<div class="group selected">${head}
      ${spread ? `<div class="group-meta">${spread}</div>` : ''}
      <div class="members">${rows || '<div class="none">No clients in this group.</div>'}
        <div class="group-acts">
          <button class="btn small primary" data-gact="plan" data-id="${g.id}">Plan visits…</button>
          <button class="btn small" data-gact="log" data-id="${g.id}">Log a visit…</button>
          <button class="btn small" data-gact="planday" data-id="${g.id}">Plan a day here…</button>
          <button class="btn small" data-gact="route" data-id="${g.id}">Route in Google Maps</button>
          <button class="btn small ghost" data-gact="rename" data-id="${g.id}">Rename</button>
        </div>
      </div></div>`;
  }).join('');
}

// One client row inside an open group: status dot, name, hours, last visit / planned date, ✓ button.
function memberRow(c) {
  const lv = lastVisit(c), done = doneToday(c), planToday = !done && plannedToday(c);
  const np = nextPlannedVisit(c);
  const h = hoursOf(c), hs = h && Hours.short(h);
  const hTitle = h ? Hours.weekText(h) : '';
  const tickTitle = done ? 'Visited today — click to undo' : planToday ? 'Planned today — click to mark it done' : 'Mark as visited today';
  return `<div class="member" data-client="${c.id}">
    <span class="dot" style="background:${STATUS_COLORS[clientStatus(c)]}"></span>
    <span class="name">${c.tier ? `<span class="tier t${c.tier}" title="${esc(TIER_NAMES[c.tier])}">${c.tier}</span>` : ''}${esc(c.name)}<small>${esc(titleCase(c.city || ''))}</small></span>
    ${hs ? `<span class="hrs ${hs.cls}" title="${esc(hTitle)}">${esc(hs.text)}</span>` : ''}
    ${np && !planToday ? `<span class="pill plan" title="Visit planned ${esc(fmtDate(np))}">${esc(fmtShort(np))}</span>` : ''}
    <span class="when" title="${lv ? 'Last visit ' + fmtDate(lv) : ''}">${shortAgo(daysSince(lv))}</span>
    <button class="tick${done ? ' done' : ''}${planToday ? ' planned' : ''}" data-tick="${c.id}" title="${tickTitle}">
      <svg width="13" height="13" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>`;
}

function renderClientsList() {
  let list = state.data.clients.filter(matchesSearch);
  if (state.clientFilter === 'unlocated') list = list.filter(c => !hasLoc(c));
  const s = state.sort.clients;
  const days = c => daysSince(lastVisit(c));
  list.sort((a, b) => {
    if (s === 'urgent') return urgencyOf(b) - urgencyOf(a) || (days(b) ?? NEVER) - (days(a) ?? NEVER) || a.name.localeCompare(b.name);
    if (s === 'planned') return (nextPlannedVisit(a) || '9999').localeCompare(nextPlannedVisit(b) || '9999') || a.name.localeCompare(b.name);
    if (s === 'group') return ((groupById(a.groupId)?.number ?? 1e9) - (groupById(b.groupId)?.number ?? 1e9)) || a.name.localeCompare(b.name);
    if (s === 'city') return norm(a.city).localeCompare(norm(b.city)) || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });
  if (!state.data.clients.length) return '<div class="none">No clients yet.</div>';
  if (!list.length) return `<div class="none">No client matches.</div>`;
  return list.map(c => {
    const g = c.groupId && groupById(c.groupId);
    const st = clientStatus(c), d = days(c);
    let side = `<span class="pill ${st}">${shortAgo(d)}</span>`;
    if (!hasLoc(c)) side = `<span class="pill warn">${c.geo?.status === 'pending' ? 'To locate' : 'Not on map'}</span>`;
    const np = nextPlannedVisit(c);
    if (np) side = `<span class="pill plan" title="Visit planned ${esc(fmtDate(np))}">${esc(fmtShort(np))}</span>` + side;
    return `<button class="row client-row${c.id === state.selectedClientId ? ' selected' : ''}" data-client="${c.id}">
      <span class="main"><div class="title">${c.tier ? `<span class="tier t${c.tier}">${c.tier}</span>` : ''}${esc(c.name)}</div><div class="sub">${esc([c.address, [c.postcode, titleCase(c.city || '')].filter(Boolean).join(' ')].filter(Boolean).join(', ') || c.extra?.Folder || '—')}</div></span>
      <span class="side">${side}${g ? `<span class="gbadge" style="background:${g.color}" title="${esc(g.name)}">${g.number}</span>` : ''}</span>
    </button>`;
  }).join('');
}

function renderList() {
  const scroll = $('#list').scrollTop;
  $('#list').innerHTML = state.tab === 'groups' ? renderGroupsList() : state.tab === 'planned' ? renderPlannedList() : state.tab === 'prospecting' ? renderProspectingList() : renderClientsList();
  $('#list').scrollTop = scroll;
}

$('#list').addEventListener('click', e => {
  if (state.tab === 'prospecting') return; // handled in prospecting.js
  if (state.tab === 'planned' && plannedListClick(e)) return;
  const tick = e.target.closest('[data-tick]');
  if (tick) { e.stopPropagation(); toggleVisitedToday(tick.dataset.tick); return; }
  const gact = e.target.closest('[data-gact]');
  if (gact) {
    const id = gact.dataset.id;
    const info = state.derived.byGroup.get(id);
    if (gact.dataset.gact === 'log') visitDialog({ ids: info.members.map(c => c.id), mode: 'log', title: info.group.name });
    if (gact.dataset.gact === 'plan') visitDialog({ ids: info.members.map(c => c.id), mode: 'plan', title: info.group.name });
    if (gact.dataset.gact === 'planday') planDayDialog({ groupId: id });
    if (gact.dataset.gact === 'route') openRoute(id);
    if (gact.dataset.gact === 'rename') renameGroup(id);
    return;
  }
  const act = e.target.closest('[data-act="regroup"]');
  if (act) { regroup(); return; }
  const g = e.target.closest('[data-group]');
  if (g) {
    if (state.selectedGroupId === g.dataset.group) { state.selectedGroupId = null; state.selectedClientId = null; renderAll(); renderDetail(); }
    else selectGroup(g.dataset.group, { fit: true });
    return;
  }
  const c = e.target.closest('[data-client]');
  if (c) selectClient(c.dataset.client, { pan: true });
});

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  const was = state.tab;
  state.tab = t.dataset.tab;
  if (state.tab === 'groups') state.clientFilter = null;
  if (state.tab === 'prospecting') { state.selectedClientId = null; renderDetail(); }
  renderAll();
  if (state.tab === 'prospecting' && was !== 'prospecting') fitProspects();
  if (state.tab === 'planned' && was !== 'planned' && state.selectedDay) fitDay(state.selectedDay);
}));
$('#sort').addEventListener('change', e => { state.sort[state.tab] = e.target.value; renderList(); });
$('#search').addEventListener('input', e => { state.search = e.target.value.trim(); renderList(); renderMap(); });

// =====================================================================
// Selection
// =====================================================================
function selectGroup(id, { fit } = {}) {
  state.selectedGroupId = id;
  if (state.selectedClientId && clientById(state.selectedClientId)?.groupId !== id) state.selectedClientId = null;
  renderAll(); renderDetail();
  const info = state.derived.byGroup.get(id);
  if (fit && info) fitPoints(info.members.filter(hasLoc).map(c => [c.lat, c.lng]));
  const el = document.querySelector(`.group.selected`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}
function selectClient(id, { pan } = {}) {
  const c = clientById(id);
  if (!c) return;
  state.selectedClientId = id;
  if (c.groupId) state.selectedGroupId = c.groupId;
  renderAll(); renderDetail();
  if (pan && hasLoc(c)) {
    const z = Math.max(map.getZoom(), 12);
    const p = map.project([c.lat, c.lng], z).add([190, 0]); // keep pin clear of the detail panel
    map.setView(map.unproject(p, z), z);
  }
  const row = document.querySelector(`[data-client="${id}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

// =====================================================================
// Planned tab: visits day by day, route and opening hours for each day
// =====================================================================
function dayOpts(date) {
  return {
    weekday: isoToDate(date).getDay(),
    startMin: Planning.parseHHMM(S().dayStart) ?? 510,
    endMin: Planning.parseHHMM(S().dayEnd) ?? 1080,
    visitMin: S().visitMin, speedKmh: S().speedKmh,
  };
}
const stopPoint = c => ({ lat: c.lat, lng: c.lng, hours: hoursOf(c) });

// The visits of one day in visiting order, with arrival times and opening-hours checks.
// Today also shows what was already done today.
function dayPlan(date) {
  const isToday = date === todayISO();
  const byClient = new Map();
  for (const c of state.data.clients) {
    for (const v of c.visits || []) {
      if (v.date !== date) continue;
      const s = vStatus(v);
      if (!(s === 'planned' || (s === 'done' && (v.confirmedFrom === 'planned' || (isToday && v.type !== 'call'))))) continue;
      const prev = byClient.get(c.id);
      if (!prev || (vStatus(prev.v) !== 'planned' && s === 'planned')) byClient.set(c.id, { c, v });
    }
  }
  const stops = [...byClient.values()].sort((a, b) => (a.v.order ?? 1e6) - (b.v.order ?? 1e6) || a.c.name.localeCompare(b.c.name));
  const located = stops.filter(s => hasLoc(s.c));
  const opts = dayOpts(date);
  const sim = located.length ? Planning.simulate(homeOf(), located.map(s => stopPoint(s.c)), opts) : null;
  located.forEach((s, i) => { s.leg = sim.legs[i]; });
  return { date, stops, sim, opts };
}
function nextOrder(date) {
  let m = 0;
  for (const c of state.data.clients) for (const v of c.visits || []) if (v.date === date && v.order !== undefined && vStatus(v) !== 'cancelled') m = Math.max(m, v.order);
  return m + 1;
}
// Best visiting order for a day's stops still to do (done ones stay first).
function optimizeDay(date) {
  const p = dayPlan(date);
  const done = p.stops.filter(s => vStatus(s.v) === 'done');
  const todo = p.stops.filter(s => vStatus(s.v) === 'planned');
  const loc = todo.filter(s => hasLoc(s.c)), noLoc = todo.filter(s => !hasLoc(s.c));
  const lastDone = [...done].reverse().find(s => hasLoc(s.c));
  const start = lastDone ? stopPoint(lastDone.c) : homeOf();
  const order = Planning.orderStops(start, loc.map(s => stopPoint(s.c)), p.opts);
  [...done, ...order.map(i => loc[i]), ...noLoc].forEach((s, i) => { s.v.order = i + 1; });
}
function showDay(date) {
  state.tab = 'planned'; state.selectedDay = date; state.selectedClientId = null;
  renderAll(); renderDetail(); fitDay(date);
  setTimeout(() => document.querySelector(`.day[data-date="${date}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
}
function fitDay(date) {
  const pts = dayPlan(date).stops.filter(s => hasLoc(s.c)).map(s => [s.c.lat, s.c.lng]);
  const home = homeOf();
  if (pts.length && home) pts.push([home.lat, home.lng]);
  fitPoints(pts);
}

function hoursBadge(c, check, weekday) {
  if (c.gbp?.businessStatus === 'CLOSED_PERMANENTLY') return '<span class="hrs closed">Closed for good</span>';
  if (!check || check.state === 'unknown') return '';
  const f = Planning.fmtMin;
  switch (check.state) {
    case 'open': return `<span class="hrs open" title="Open when you arrive">Open till ${f(check.closesAt)}</span>`;
    case 'closing': return `<span class="hrs soon" title="Closes soon after you arrive">Closes ${f(check.closesAt)}</span>`;
    case 'wait': return `<span class="hrs later" title="Still closed when you arrive">Opens ${f(check.opensAt)}</span>`;
    case 'closedLater': return `<span class="hrs closed" title="Already closed when you arrive">Closed from ${f(check.closesAt)}</span>`;
    case 'closedDay': return `<span class="hrs closed" title="Closed all day">Closed on ${WEEKDAYS[weekday]}s</span>`;
    default: return '';
  }
}
const isProblem = (c, leg) => c.gbp?.businessStatus === 'CLOSED_PERMANENTLY' || (leg && ['closedDay', 'closedLater'].includes(leg.check.state)) || (leg && leg.check.state === 'wait' && leg.wait === 0);

function dayCard(date) {
  const t = todayISO();
  const p = dayPlan(date);
  const n = p.stops.length, sel = state.selectedDay === date;
  const home = homeOf();
  const problems = p.stops.filter(s => isProblem(s.c, s.leg)).length;
  const doneN = p.stops.filter(s => vStatus(s.v) === 'done').length;
  const sum = !n ? 'Nothing planned' : [
    `${n} visit${n > 1 ? 's' : ''}${doneN ? ` (${doneN} done)` : ''}`,
    p.sim && p.sim.km >= 0.5 ? `${Math.round(p.sim.km)} km` : '',
    p.sim && p.sim.drive >= 1 ? `~${Planning.fmtDuration(p.sim.drive)} driving` : '',
    p.sim && home ? `back ~${Planning.fmtMin(p.sim.endMin)}` : p.sim ? `done ~${Planning.fmtMin(p.sim.endMin)}` : '',
  ].filter(Boolean).join(' · ');
  const late = p.sim && p.sim.endMin > p.opts.endMin;
  const rows = p.stops.map((s, i) => {
    const done = vStatus(s.v) === 'done';
    const town = titleCase(townOf(s.c));
    const when = s.leg ? `arrive ~${Planning.fmtMin(s.leg.arrive)}${s.leg.wait >= 1 ? `, wait ${Math.round(s.leg.wait)} min` : ''}` : hasLoc(s.c) ? '' : 'not on the map';
    return `<div class="stop${done ? ' done' : ''}${isProblem(s.c, s.leg) ? ' problem' : ''}" draggable="${done ? 'false' : 'true'}" data-client="${s.c.id}" data-v="${s.v.id}">
      <span class="num">${i + 1}</span>
      <span class="name">${s.c.tier ? `<span class="tier t${s.c.tier}">${s.c.tier}</span>` : ''}${esc(s.c.name)}<small>${esc([town, when].filter(Boolean).join(' · '))}</small></span>
      ${hoursBadge(s.c, s.leg && s.leg.check, p.opts.weekday)}
      ${done ? '<span class="pill ok">Done</span>' : `${date === t ? `<button class="mini ok" data-pact="done" data-c="${s.c.id}" data-v="${s.v.id}" title="Mark as done">✓</button>` : ''}<button class="mini" data-pact="remove" data-c="${s.c.id}" data-v="${s.v.id}" title="Take this visit off the plan">×</button>`}
    </div>`;
  }).join('');
  return `<div class="day${sel ? ' selected' : ''}${date === t ? ' today' : ''}${n ? '' : ' noplan'}" data-date="${date}">
    <button class="day-head" data-pact="day" data-date="${date}">
      <span class="day-name">${date === t ? 'Today · ' : date === addDaysISO(t, 1) ? 'Tomorrow · ' : ''}${esc(fmtDay(date))}</span>
      <span class="day-sum">${esc(sum)}${problems ? ` · <b class="bad">${problems} closed when you arrive</b>` : ''}${late ? ` · <b class="bad">ends after ${esc(S().dayEnd)}</b>` : ''}</span>
    </button>
    ${n ? `<div class="stops">${rows}</div>` : `<div class="day-empty"><button class="link" data-pact="planday" data-date="${date}">Plan this day…</button></div>`}
    ${sel && n ? `<div class="day-acts">
      <button class="btn small primary" data-pact="route" data-date="${date}">Route in Google Maps</button>
      <button class="btn small" data-pact="optimize" data-date="${date}" title="Re-order the stops to drive less and arrive when clients are open">Best order</button>
      <button class="btn small" data-pact="planday" data-date="${date}" title="Add the most urgent clients near this day's route">Add clients…</button>
      <button class="btn small ghost" data-pact="clear" data-date="${date}">Clear day</button>
    </div>` : ''}
  </div>`;
}

function renderPlannedList() {
  const t = todayISO(), d = state.derived;
  if (!state.data.clients.length) return '<div class="none">No clients yet.</div>';
  let html = `<div class="plan-top"><button class="btn primary" data-pact="planday">Plan a day…</button><span>Click a day to see its route · drag visits between days</span></div>`;
  if (d.unconfirmed.length) {
    html += `<div class="day unconf"><div class="day-head static"><span class="day-name">Not confirmed yet</span><span class="day-sum">These planned visits have passed. Did they happen?</span></div><div class="stops">
      ${d.unconfirmed.map(({ c, v }) => `<div class="stop" data-client="${c.id}">
        <span class="name">${esc(c.name)}<small>${esc([fmtDay(v.date), titleCase(townOf(c))].filter(Boolean).join(' · '))}</small></span>
        <span class="vacts"><button class="mini ok" data-pact="done" data-c="${c.id}" data-v="${v.id}">Done</button><button class="mini" data-pact="cancel" data-c="${c.id}" data-v="${v.id}">Didn't happen</button><button class="mini" data-pact="move" data-c="${c.id}" data-v="${v.id}">Move</button></span>
      </div>`).join('')}</div>
      ${d.unconfirmed.length > 1 ? `<div class="day-acts"><button class="btn small" data-pact="alldone">They all happened</button></div>` : ''}</div>`;
  }
  const days = new Set();
  for (let i = 0; i < 14; i++) { const x = addDaysISO(t, i); if (i === 0 || ![0, 6].includes(isoToDate(x).getDay())) days.add(x); }
  for (const c of state.data.clients) for (const v of plannedOf(c)) if (v.date >= t) days.add(v.date);
  const sorted = [...days].sort();
  const horizon = addDaysISO(t, 13);
  html += sorted.filter(x => x <= horizon).map(dayCard).join('');
  const later = sorted.filter(x => x > horizon);
  if (later.length) html += `<div class="later-head">Later</div>` + later.map(dayCard).join('');
  return html;
}

// Clicks in the Planned tab. Returns true when handled.
function plannedListClick(e) {
  const b = e.target.closest('[data-pact]');
  if (!b) return false;
  e.stopPropagation();
  const act = b.dataset.pact, date = b.dataset.date;
  const c = b.dataset.c && clientById(b.dataset.c);
  const v = c && c.visits.find(x => x.id === b.dataset.v);
  if (act === 'day') {
    state.selectedDay = state.selectedDay === date ? null : date;
    state.selectedClientId = null;
    renderAll(); renderDetail();
    if (state.selectedDay) fitDay(date);
  }
  if (act === 'planday') planDayDialog({ date });
  if (['done', 'cancel', 'move'].includes(act)) plannedVisitAction(c, v, act);
  if (act === 'remove' && v) {
    c.visits = c.visits.filter(x => x !== v);
    save(); renderAll(); renderDetail();
    toast(`${c.name} taken off ${fmtDay(v.date)}.`, { action: { label: 'Undo', fn: () => { c.visits.push(v); save(); renderAll(); renderDetail(); } } });
  }
  if (act === 'alldone') {
    const list = state.derived.unconfirmed.slice();
    list.forEach(({ v: x }) => Object.assign(x, { status: 'done', confirmedFrom: 'planned' }));
    save(); renderAll(); renderDetail();
    toast(`${list.length} visits marked as done.`, { action: { label: 'Undo', fn: () => { list.forEach(({ v: x }) => { x.status = 'planned'; delete x.confirmedFrom; }); save(); renderAll(); renderDetail(); } } });
  }
  if (act === 'optimize') {
    const before = dayPlan(date);
    const old = before.stops.map(s => [s.v, s.v.order]);
    optimizeDay(date);
    const after = dayPlan(date);
    save(); renderAll(); fitDay(date);
    const better = before.sim && after.sim ? before.sim.cost - after.sim.cost : 0;
    const mins = before.sim && after.sim ? (before.sim.drive + before.sim.wait) - (after.sim.drive + after.sim.wait) : 0;
    const fixedHours = before.stops.filter(s => isProblem(s.c, s.leg)).length - after.stops.filter(s => isProblem(s.c, s.leg)).length;
    const parts = [];
    if (mins >= 1) parts.push(`about ${Math.max(0, Math.round(before.sim.km - after.sim.km))} km and ${Planning.fmtDuration(mins)} saved`);
    if (fixedHours > 0) parts.push(`${fixedHours} fewer client${fixedHours > 1 ? 's' : ''} closed on arrival`);
    toast(better > 1 ? `Stops re-ordered${parts.length ? ': ' + parts.join(', ') : ''}.` : 'This order was already the best one found.',
      better > 1 ? { action: { label: 'Undo', fn: () => { old.forEach(([x, o]) => { x.order = o; }); save(); renderAll(); } } } : {});
  }
  if (act === 'clear') {
    const p = dayPlan(date);
    const removed = [];
    for (const s of p.stops) if (vStatus(s.v) === 'planned') { s.c.visits = s.c.visits.filter(x => x !== s.v); removed.push(s); }
    save(); renderAll(); renderDetail();
    toast(`${removed.length} planned visit${removed.length === 1 ? '' : 's'} removed from ${fmtDay(date)}.`, { action: { label: 'Undo', fn: () => { removed.forEach(s => s.c.visits.push(s.v)); save(); renderAll(); renderDetail(); } } });
  }
  if (act === 'route') {
    const p = dayPlan(date);
    const todo = p.stops.filter(s => hasLoc(s.c) && (date !== todayISO() || vStatus(s.v) === 'planned'));
    if (!todo.length) { toast('No stop left to drive to on this day.'); return true; }
    openRouteLinks(homeOf(), todo.map(s => s.c), fmtDay(date));
  }
  return true;
}

// Drag a visit onto another day (or onto another visit to put it before that one).
let dragVisit = null;
$('#list').addEventListener('dragstart', e => {
  const s = e.target.closest && e.target.closest('.stop[draggable="true"]');
  if (!s) return;
  dragVisit = { c: s.dataset.client, v: s.dataset.v };
  e.dataTransfer.setData('text/plain', `${dragVisit.c}|${dragVisit.v}`);
  e.dataTransfer.effectAllowed = 'move';
  s.classList.add('dragging');
});
$('#list').addEventListener('dragend', () => {
  dragVisit = null;
  document.querySelectorAll('.dragging, .drop-over, .drop-before').forEach(x => x.classList.remove('dragging', 'drop-over', 'drop-before'));
});
$('#list').addEventListener('dragover', e => {
  if (!dragVisit) return;
  const day = e.target.closest('.day[data-date]');
  if (!day) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.drop-over, .drop-before').forEach(x => { if (x !== day) x.classList.remove('drop-over', 'drop-before'); });
  day.classList.add('drop-over');
  const before = e.target.closest('.stop[data-v]');
  if (before && before.dataset.v !== dragVisit.v) before.classList.add('drop-before');
});
$('#list').addEventListener('drop', e => {
  if (!dragVisit) return;
  const day = e.target.closest('.day[data-date]');
  if (!day) return;
  e.preventDefault();
  const c = clientById(dragVisit.c), v = c && c.visits.find(x => x.id === dragVisit.v);
  dragVisit = null;
  if (!v) return;
  const date = day.dataset.date, from = v.date;
  const beforeEl = e.target.closest('.stop[data-v]');
  const beforeId = beforeEl && beforeEl.dataset.v !== v.id ? beforeEl.dataset.v : null;
  const other = date === from ? null : plannedOf(c).find(x => x.date === date && x !== v);
  if (other) { toast(`${c.name} already has a visit planned on ${fmtDay(date)}.`, { error: true }); renderList(); return; }
  v.date = date; v.status = 'planned';
  const list = dayPlan(date).stops.filter(s => s.v !== v);
  const idx = beforeId ? list.findIndex(s => s.v.id === beforeId) : -1;
  list.splice(idx < 0 ? list.length : idx, 0, { c, v });
  list.forEach((s, i) => { s.v.order = i + 1; });
  save(); renderAll();
  if (date !== from) toast(`${c.name} moved to ${fmtDay(date)}.`);
});

// Google Maps routes (split in parts when there are more stops than Google accepts).
function openRouteLinks(home, clients, label) {
  const parts = Planning.routeLinks(home, clients.map(c => ({ lat: c.lat, lng: c.lng })));
  if (!parts.length) return;
  if (parts.length === 1) { window.api.openExternal(parts[0].url); return; }
  const desc = p => `${p.fromHome ? 'Home → ' : ''}stop${p.from === p.to ? '' : 's'} ${p.from === p.to ? p.from : `${p.from} to ${p.to}`}${p.toHome ? ' → home' : ''}`;
  showModal({
    title: `Route — ${esc(label)}`,
    desc: `Google Maps takes at most 9 stops in one route, so this one is cut into ${parts.length} parts that follow on from each other. Open part 1 now and part 2 when you get to its first stop.`,
    render: () => parts.map((p, i) => `<div class="route-part"><b>Part ${i + 1}</b><span>${esc(desc(p))}</span><button class="btn small primary" data-rp="${i}">Open in Google Maps</button></div>`).join(''),
    buttons: [{ label: 'Close', action: 'close' }],
    onClick(e) { const b = e.target.closest('[data-rp]'); if (b) window.api.openExternal(parts[+b.dataset.rp].url); },
  });
}

// =====================================================================
// Client detail panel
// =====================================================================
function renderDetail() {
  const panel = $('#detail');
  const c = state.selectedClientId && clientById(state.selectedClientId);
  if (!c) { panel.hidden = true; panel.innerHTML = ''; return; }
  panel.hidden = false;
  const lv = lastVisit(c), d = daysSince(lv), st = clientStatus(c);
  const groups = state.data.groups.slice().sort((a, b) => a.number - b.number);
  const sizes = new Map([...state.derived.byGroup.values()].map(i => [i.group.id, i.members.length]));
  let loc;
  if (hasLoc(c)) {
    const approx = c.geo && c.geo.source !== 'manual' && c.geo.source !== 'file' && (c.geo.score < 0.5 || c.geo.precision === 'municipality');
    loc = `<div class="locline">${approx ? '<span class="pill due">Approximate — please check</span>' : '<span class="pill ok">On the map</span>'}
      <button class="link" data-d="maps">Open in Google Maps</button><button class="link" data-d="place">Move pin</button></div>
      ${c.geo?.label && c.geo.source !== 'manual' ? `<div class="locline" style="margin-top:4px">Found as: ${esc(c.geo.label)}</div>` : ''}`;
  } else {
    loc = `<div class="locline"><span class="pill warn">${c.geo?.status === 'pending' ? 'Not located yet' : 'Address not found'}</span>
      <button class="link" data-d="place">Place on the map by hand</button></div>`;
  }
  const extra = Object.entries(c.extra || {}).filter(([, v]) => String(v).trim());
  const t = todayISO();
  // Planned visits first (soonest first), then the history (newest first).
  const visits = (c.visits || []).slice().sort((a, b) => {
    const pa = vStatus(a) === 'planned', pb = vStatus(b) === 'planned';
    if (pa !== pb) return pa ? -1 : 1;
    return pa ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
  });
  const np = nextPlannedVisit(c), th = thresholds(c);
  const draft = state.visitDraft && state.visitDraft.id === c.id ? state.visitDraft : { date: t, type: 'visit', outcome: '', note: '' };
  const future = draft.date > t;
  const visitLine = v => {
    const s = vStatus(v);
    const pills = [];
    if (s === 'planned') pills.push(v.date < t ? '<span class="pill warn">Not confirmed</span>' : '<span class="pill plan">Planned</span>');
    if (s === 'cancelled') pills.push('<span class="pill never">Didn\'t happen</span>');
    if (v.type === 'call') pills.push('<span class="pill call">Phone call</span>');
    if (v.outcome) pills.push(`<span class="pill ${NO_MEETING.has(v.outcome) ? 'due' : v.outcome === 'followup' ? 'due' : 'ok'}">${esc(OUTCOMES[v.outcome] || v.outcome)}</span>`);
    const acts = s === 'planned'
      ? `<span class="vacts"><button class="mini ok" data-vact="done" data-v="${v.id}" title="It happened: mark as done">✓</button><button class="mini" data-vact="move" data-v="${v.id}" title="Move to another day">Move</button><button class="mini" data-vact="cancel" data-v="${v.id}" title="It didn't happen / won't happen">Cancel</button></span>`
      : `<button class="x" data-delvisit="${v.id}" title="Delete this visit">×</button>`;
    return `<li class="${s}"><span class="d">${fmtDate(v.date)}</span><span class="n">${pills.join(' ')}${v.note ? `<span class="vnote">${esc(v.note)}</span>` : ''}</span>${acts}</li>`;
  };
  panel.innerHTML = `
    <div class="detail-head">
      <input class="name" data-f="name" value="${esc(c.name)}" title="Client name">
      <button class="btn icon ghost" data-d="close" title="Close (Esc)"><svg width="14" height="14" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>
    </div>
    <div class="detail-body">
      <div class="section">
        <h3>Visits</h3>
        <div class="lastvisit"><b>${lv ? fmtDate(lv) : 'Never visited'}</b>${lv ? `<span class="pill ${st}">${fmtAgo(d)}</span>` : ''}</div>
        ${np ? `<div class="lastvisit"><span class="pill plan">Next planned</span> <b>${fmtDay(np)}</b></div>` : ''}
        <div class="tier-row"><span>Priority</span>
          <div class="seg tiers">${['', 'A', 'B', 'C'].map(k => `<button data-tier="${k}" class="${(c.tier || '') === k ? 'on' : ''}" title="${k ? esc(TIER_NAMES[k]) : 'No priority: the general delays apply'}">${k || '—'}</button>`).join('')}</div>
          <small>due after ${th.due} d, overdue after ${th.over} d</small>
        </div>
        <div class="addvisit${future ? ' future' : ''}">
          <input type="date" class="input" id="v-date" value="${draft.date}" title="Pick a future date to plan a visit in advance">
          <select class="input" id="v-type">${Object.entries(VISIT_TYPES).map(([k, l]) => `<option value="${k}"${draft.type === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <select class="input" id="v-outcome"${future ? ' hidden' : ''}>${Object.entries(OUTCOMES).map(([k, l]) => `<option value="${k}"${draft.outcome === k ? ' selected' : ''}>${k ? l : 'Outcome (optional)'}</option>`).join('')}</select>
          <input type="text" class="input" id="v-note" placeholder="Note (optional)" value="${esc(draft.note)}">
          <button class="btn primary" data-d="addvisit">${future ? `Plan visit for ${esc(fmtDay(draft.date))}` : draft.date === t ? 'Add today\'s visit' : 'Add visit'}</button>
        </div>
        ${visits.length ? `<ul class="visits">${visits.map(visitLine).join('')}</ul>` : ''}
        ${(c.visits || []).some(v => !countsAsVisit(v) && vStatus(v) === 'done') ? '<p class="vhint">Phone calls and visits where nobody was available are kept here but don\'t count as the last visit.</p>' : ''}
      </div>
      ${hoursSection(c)}
      <div class="section">
        <h3>Group</h3>
        <select data-f="groupId">
          <option value="">— No group —</option>
          ${groups.map(g => `<option value="${g.id}"${g.id === c.groupId ? ' selected' : ''}>${g.number}. ${esc(g.name)} (${sizes.get(g.id) || 0}/${S().maxSize})</option>`).join('')}
        </select>
      </div>
      <div class="section">
        <h3>Address</h3>
        <div class="field"><input class="input" data-f="address" value="${esc(c.address)}" placeholder="Street address"></div>
        <div class="field-row field"><input class="input" data-f="postcode" value="${esc(c.postcode)}" placeholder="Postal code"><input class="input" data-f="city" value="${esc(c.city)}" placeholder="City"></div>
        <div class="field"><input class="input" data-f="country" value="${esc(c.country)}" placeholder="Country (optional, France by default)"></div>
        ${loc}
        <div style="margin-top:8px"><button class="btn small" data-d="relocate">Locate this address again</button></div>
      </div>
      <div class="section">
        <h3>Notes</h3>
        <textarea data-f="notes" placeholder="Contact, access, anything useful…">${esc(c.notes)}</textarea>
      </div>
      ${extra.length ? `<div class="section"><h3>From your file</h3><dl class="extra">${extra.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>` : ''}
      <div class="section"><button class="btn small danger" data-d="delete">Delete this client</button></div>
    </div>`;
}

function hoursSection(c) {
  const g = c.gbp || {}, h = hoursOf(c), hasKey = state.googleKey.hasKey;
  const out = [];
  const btn = (act, label, cls = '') => `<button class="btn small ${cls}" data-d="${act}">${label}</button>`;
  if (g.businessStatus === 'CLOSED_PERMANENTLY') out.push('<div class="hours-warn"><span class="pill warn">Permanently closed on Google</span></div>');
  else if (g.businessStatus === 'CLOSED_TEMPORARILY') out.push('<div class="hours-warn"><span class="pill due">Temporarily closed on Google</span></div>');
  if (h) {
    const st = Hours.status(h);
    const today = new Date().getDay();
    out.push(`<div class="hours-now"><span class="pill ${st.open ? 'ok' : 'late'}">${st.open ? 'Open now' : 'Closed now'}</span><span>${esc(st.text.replace(/^(Open|Closed) · /, ''))}</span></div>`);
    out.push(`<table class="hours">${Hours.weekLines(h).map(l => `<tr${l.day === today ? ' class="today"' : ''}><th>${l.name}</th><td>${esc(l.text)}</td></tr>`).join('')}</table>`);
    out.push(`<div class="hours-src">${h.source === 'manual' ? 'Entered by hand' : 'From Google'}${h.updatedAt ? ' · ' + fmtDate(h.updatedAt) : ''}</div>`);
  } else {
    const msg = {
      linked: 'This Google business page has no opening hours.',
      review: 'Google found businesses that may be this client. Choose the right one to get its opening hours.',
      notfound: 'No Google business page was found for this name and address.',
      none: 'Marked as having no Google business page.',
      manual: 'No opening hours entered.',
    }[g.status] || (hasKey ? 'Not looked up on Google yet.' : 'Add a Google API key in Settings to get opening hours automatically, or type them in.');
    out.push(`<div class="hours-empty">${msg}</div>`);
  }
  if (g.placeId || g.mapsUrl) {
    out.push(`<div class="gpage">${g.placeId ? `<b>${esc(g.name || 'Google page')}</b>${g.address ? `<small>${esc(g.address)}</small>` : ''}` : ''}
      <div class="glinks"><button class="link" data-d="gpage">Google page</button>${g.website ? `<button class="link" data-d="gweb">Website</button>` : ''}${g.phone ? `<span class="gphone">${esc(g.phone)}</span>` : ''}${g.matchedBy === 'auto' ? '<span class="gauto" title="Matched automatically from the name and address">matched automatically</span>' : ''}</div></div>`);
  }
  const acts = [];
  if (g.status === 'review' || g.status === 'notfound') acts.push(btn('greview', 'Choose the Google page…', 'primary'));
  else if (!g.placeId && hasKey && (!g.status || g.status === 'pending' || g.status === 'none' || g.status === 'manual')) acts.push(btn('glookup', 'Find on Google'));
  if (g.placeId && hasKey) acts.push(btn('grefresh', 'Refresh from Google'));
  if (g.placeId || g.status === 'review' || g.status === 'notfound' || g.status === 'none') acts.push(btn('greview', g.placeId ? 'Change page…' : 'Search or paste a link…', 'ghost'));
  else if (!hasKey) acts.push(btn('greview', 'Paste a Google Maps link…', 'ghost'));
  acts.push(btn('ghours', h ? 'Edit hours' : 'Enter hours by hand', 'ghost'));
  return `<div class="section"><h3>Opening hours</h3>${out.join('')}<div class="hours-acts">${[...new Set(acts)].join('')}</div></div>`;
}

$('#detail').addEventListener('change', e => {
  const f = e.target.dataset.f;
  const c = clientById(state.selectedClientId);
  if (!f || !c) return;
  if (f === 'groupId') {
    c.groupId = e.target.value || null;
    if (c.groupId) state.selectedGroupId = c.groupId;
    save(); renderAll(); renderDetail();
    return;
  }
  const v = e.target.value.trim();
  if (f === 'name' && !v) { e.target.value = c.name; return; }
  const addressChanged = ['address', 'postcode', 'city', 'country'].includes(f) && c[f] !== v;
  c[f] = v;
  save();
  if (f === 'name') renderAll();
  if (addressChanged) renderList();
});
$('#detail').addEventListener('input', e => {
  if (e.target.dataset.f === 'notes') { const c = clientById(state.selectedClientId); if (c) { c.notes = e.target.value; save(); } }
  // Keep what is typed in the "add visit" form while the card re-renders.
  if (['v-date', 'v-type', 'v-outcome', 'v-note'].includes(e.target.id)) {
    const box = $('#detail');
    state.visitDraft = { id: state.selectedClientId, date: box.querySelector('#v-date').value || todayISO(), type: box.querySelector('#v-type').value, outcome: box.querySelector('#v-outcome').value, note: box.querySelector('#v-note').value };
    if (e.target.id === 'v-date') {
      const future = state.visitDraft.date > todayISO();
      box.querySelector('#v-outcome').hidden = future;
      box.querySelector('.addvisit').classList.toggle('future', future);
      box.querySelector('[data-d="addvisit"]').textContent = future ? `Plan visit for ${fmtDay(state.visitDraft.date)}` : state.visitDraft.date === todayISO() ? 'Add today\'s visit' : 'Add visit';
    }
  }
});
$('#detail').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'v-note') $('[data-d="addvisit"]').click();
  if (e.key === 'Enter' && e.target.dataset.f === 'name') e.target.blur();
});
$('#detail').addEventListener('click', async e => {
  const c = clientById(state.selectedClientId);
  if (!c) return;
  const dv = e.target.closest('[data-delvisit]');
  if (dv) {
    const idx = c.visits.findIndex(v => v.id === dv.dataset.delvisit);
    if (idx < 0) return;
    const [removed] = c.visits.splice(idx, 1);
    save(); renderAll(); renderDetail();
    toast(`Visit of ${fmtDate(removed.date)} deleted.`, { action: { label: 'Undo', fn: () => { c.visits.push(removed); save(); renderAll(); renderDetail(); } } });
    return;
  }
  const va = e.target.closest('[data-vact]');
  if (va) { await plannedVisitAction(c, c.visits.find(v => v.id === va.dataset.v), va.dataset.vact); return; }
  const tb = e.target.closest('[data-tier]');
  if (tb) {
    c.tier = tb.dataset.tier || '';
    save(); renderAll(); renderDetail();
    return;
  }
  const b = e.target.closest('[data-d]');
  if (!b) return;
  const act = b.dataset.d;
  if (act === 'close') { state.selectedClientId = null; renderAll(); renderDetail(); }
  if (act === 'addvisit') {
    const date = $('#v-date').value, note = $('#v-note').value.trim(), type = $('#v-type').value;
    if (!date) { toast('Pick a date for the visit.', { error: true }); return; }
    const future = date > todayISO();
    const outcome = future ? '' : $('#v-outcome').value;
    const v = recordVisit(c, { date, note, type, outcome, order: future ? nextOrder(date) : undefined });
    state.visitDraft = null;
    save(); renderAll(); renderDetail();
    if (future) toast(`Visit planned for ${c.name} on ${fmtDay(date)}.`, { action: { label: 'Show day', fn: () => showDay(date) } });
    else toast(v.confirmedFrom ? `Planned visit confirmed for ${c.name}.` : `${type === 'call' ? 'Call' : 'Visit'} noted for ${c.name}.`);
  }
  if (act === 'gpage') window.api.openExternal(c.gbp?.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.name + ' ' + geoQuery(c))}`);
  if (act === 'gweb' && c.gbp?.website) window.api.openExternal(c.gbp.website);
  if (act === 'greview') reviewGoogle([c.id]);
  if (act === 'ghours') editHours(c);
  if (act === 'glookup' || act === 'grefresh') {
    b.disabled = true; b.textContent = act === 'glookup' ? 'Searching…' : 'Refreshing…';
    const r = await (act === 'glookup' ? findGooglePage(c, { force: true }) : refreshHours(c, { force: true }));
    save(); renderAll(); renderDetail();
    if (r.error) toast(googleErrorText(r), { error: true });
    else if (r.result === 'linked' || r.result === 'refreshed') toast(hoursOf(c) ? `Opening hours ${r.result === 'refreshed' ? 'updated' : 'found'} for ${c.name}.` : `${c.name} is linked to its Google page, but Google has no opening hours for it.`);
    else if (r.result === 'review') toast('Google found possible matches — choose the right one.', { action: { label: 'Choose', fn: () => reviewGoogle([c.id]) } });
    else toast('No Google business page found. You can search with other words or paste a link.', { action: { label: 'Search', fn: () => reviewGoogle([c.id]) } });
  }
  if (act === 'maps' && hasLoc(c)) window.api.openExternal(`https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}`);
  if (act === 'place') startPlacing(c.id);
  if (act === 'relocate') {
    b.disabled = true; b.textContent = 'Locating…';
    const ok = await geocodeOne(c);
    save(); renderAll(); renderDetail();
    if (ok) {
      toast(`${c.name} located.`);
      if (!c.groupId && state.data.groups.length) { assignToNearest([c], { quiet: true }); save(); renderAll(); renderDetail(); }
      const m = markers.get(c.id); if (m) map.setView(m.getLatLng(), Math.max(map.getZoom(), 13));
    } else toast(`Couldn't find this address. You can place the client on the map by hand.`, { error: true });
  }
  if (act === 'delete') {
    if (!(await confirmDialog('Delete this client?', `${esc(c.name)} and its ${c.visits?.length || 0} recorded visit(s) will be removed.`, 'Delete', true))) return;
    state.data.clients = state.data.clients.filter(x => x.id !== c.id);
    state.selectedClientId = null;
    save(); renderAll(); renderDetail();
  }
});

// ✓ button: marks today's visit done (confirming the visit planned today, if any); clicking again undoes it.
function toggleVisitedToday(id) {
  const c = clientById(id);
  if (!c) return;
  const t = todayISO();
  const todays = (c.visits || []).filter(v => v.date === t && countsAsVisit(v));
  if (todays.length) {
    const last = todays[todays.length - 1];
    undoDone(c, last);
    toast(last.status === 'planned' ? `${c.name}: back to planned for today.` : `Today's visit removed for ${c.name}.`);
  } else {
    const v = recordVisit(c, { date: t });
    toast(`${c.name} marked as visited today.`, { action: { label: 'Undo', fn: () => { undoDone(c, v); save(); renderAll(); renderDetail(); } } });
  }
  save(); renderAll(); renderDetail();
}

// Done / Move / Cancel on a planned visit (client card, Planned tab).
async function plannedVisitAction(c, v, act) {
  if (!c || !v) return;
  if (act === 'done') {
    const before = { ...v };
    Object.assign(v, { status: 'done', confirmedFrom: 'planned' });
    save(); renderAll(); renderDetail();
    toast(`${c.name}: visit of ${fmtDate(v.date)} marked as done.`, { action: { label: 'Undo', fn: () => { Object.keys(v).forEach(k => delete v[k]); Object.assign(v, before); save(); renderAll(); renderDetail(); } } });
  }
  if (act === 'cancel') {
    const before = { ...v };
    v.status = 'cancelled'; delete v.order;
    save(); renderAll(); renderDetail();
    toast(`${c.name}: visit of ${fmtDate(v.date)} marked as not happening.`, { action: { label: 'Undo', fn: () => { Object.assign(v, before); save(); renderAll(); renderDetail(); } } });
  }
  if (act === 'move') {
    const date = await pickDateDialog(`Move the visit to ${esc(c.name)}`, v.date < todayISO() ? nextWorkday(todayISO(), true) : v.date, { min: todayISO() });
    if (!date || date === v.date) return;
    v.date = date; v.order = nextOrder(date); v.status = 'planned';
    save(); renderAll(); renderDetail();
    toast(`${c.name}: visit moved to ${fmtDay(date)}.`, { action: { label: 'Show day', fn: () => showDay(date) } });
  }
}

function pickDateDialog(title, value, { min } = {}) {
  return new Promise(resolve => {
    let result = null;
    showModal({
      title, render: () => `<div class="field"><label>New date</label><input type="date" id="p-date" value="${value}"${min ? ` min="${min}"` : ''} autofocus></div><div class="err" id="p-err"></div>`,
      buttons: [{ label: 'Cancel', action: 'close' }, { label: 'Move', primary: true, action: 'ok' }],
      onOk(close, box) {
        const d = box.querySelector('#p-date').value;
        if (!d) return;
        if (min && d < min) { box.querySelector('#p-err').textContent = 'Pick today or a later day.'; return; }
        result = d; close();
      },
      onClose: () => resolve(result),
    });
  });
}

function startPlacing(id) {
  const c = clientById(id);
  state.placingClientId = id;
  $('.map-wrap').classList.add('placing');
  const b = $('#place-banner');
  b.innerHTML = `<span>Click on the map where <b>${esc(c.name)}</b> is</span><button class="btn small" id="place-cancel">Cancel</button>`;
  b.hidden = false;
  $('#place-cancel').onclick = stopPlacing;
}
function stopPlacing() {
  state.placingClientId = null;
  $('.map-wrap').classList.remove('placing');
  $('#place-banner').hidden = true;
}

// =====================================================================
// Review clients that are not on the map
// =====================================================================
function reviewUnlocated() {
  const notes = {}; // per-client message after a new search
  const list = () => state.data.clients.filter(c => !hasLoc(c));
  showModal({
    wide: true,
    title: 'Clients not on the map',
    desc: 'The address search found nothing for these clients. Correct the address and search again, place them on the map yourself, or look them up in Google Maps first.',
    render: () => {
      const items = list();
      if (!items.length) return '<p style="margin:6px 0 10px">All clients are on the map now. 🎉</p>';
      return items.map(c => {
        const q = geoQuery(c);
        const n = notes[c.id];
        return `<div class="fix-row" data-id="${c.id}">
          <div class="fix-head"><b>${esc(c.name)}</b>
            <span class="fix-q">${q ? `Searched for: “${esc(q)}”` : 'No address in your file'}</span></div>
          <div class="fix-fields">
            <input data-k="address" value="${esc(c.address)}" placeholder="Street address">
            <input data-k="postcode" value="${esc(c.postcode)}" placeholder="Postal code">
            <input data-k="city" value="${esc(c.city)}" placeholder="City">
          </div>
          ${n ? `<div class="fix-msg ${n.ok ? 'ok' : 'bad'}">${esc(n.text)}</div>` : ''}
          <div class="fix-acts">
            <button class="btn small primary" data-fix="search">Search again</button>
            <button class="btn small" data-fix="place">Place on the map myself</button>
            <button class="btn small ghost" data-fix="google">Look it up in Google Maps</button>
            <button class="btn small ghost" data-fix="open">Open client card</button>
          </div>
        </div>`;
      }).join('');
    },
    buttons: [{ label: 'Close', action: 'close' }],
    async onClick(e, box, close, rerender) {
      const b = e.target.closest('[data-fix]');
      if (!b) return;
      const row = b.closest('.fix-row');
      const c = clientById(row.dataset.id);
      if (!c) return;
      // Save what was typed in the row first.
      row.querySelectorAll('input[data-k]').forEach(i => { c[i.dataset.k] = i.value.trim(); });
      save();
      const act = b.dataset.fix;
      if (act === 'search') {
        b.disabled = true; b.textContent = 'Searching…';
        const ok = await geocodeOne(c);
        if (ok) {
          if (state.data.groups.length) assignToNearest([c], { quiet: true });
          const g = c.groupId && groupById(c.groupId);
          toast(`${c.name} found: ${c.geo.label}${g ? ` — added to group ${g.number}` : ''}.`);
        } else notes[c.id] = { ok: false, text: ok === null ? "Couldn't reach the address service — check the internet connection." : 'Still not found. Check the spelling, add the postal code and city, or place it on the map yourself.' };
        save(); renderAll(); rerender();
      }
      if (act === 'place') { close(); startPlacing(c.id); }
      if (act === 'google') {
        const q = geoQuery(c) || c.name;
        window.api.openExternal('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q));
      }
      if (act === 'open') { close(); state.tab = 'clients'; selectClient(c.id, {}); }
    },
  });
}

// =====================================================================
// Opening hours from Google business pages
//  c.gbp = { status: 'linked' | 'review' | 'notfound' | 'none' | 'manual' | 'pending',
//            placeId, name, address, mapsUrl, phone, website, businessStatus, matchedBy: 'auto'|'user'|'file',
//            candidates: [...], checkedAt, hours: { periods, source: 'google'|'manual', updatedAt } }
// =====================================================================
const BLOCKING = ['KEY', 'QUOTA', 'NOKEY'];
function googleErrorText(r) {
  if (r.code === 'NOKEY') return 'Add a Google API key in Settings first.';
  if (r.code === 'QUOTA') return 'Google refused: too many requests or the daily quota is used up. Try again later.';
  if (r.code === 'KEY') return 'Google refused the API key: ' + r.error;
  if (r.code === 'NETWORK') return "Couldn't reach Google. Check the internet connection.";
  return r.error || 'Something went wrong with Google.';
}
const keepManualHours = c => (c.gbp?.hours?.source === 'manual' ? { hours: c.gbp.hours } : {});
const preciseLoc = c => hasLoc(c) && !(c.geo && c.geo.source !== 'manual' && c.geo.source !== 'file' && (c.geo.score < 0.5 || c.geo.precision === 'municipality'));
const slimCandidate = p => ({ id: p.id, name: p.name, address: p.address, lat: p.lat, lng: p.lng, mapsUrl: p.mapsUrl, type: p.type, status: p.status, sim: p.sim, dist: p.dist });

// Fetch the page's details (hours, phone, website) and link the client to it.
async function linkPlace(c, placeId, by, candidates) {
  const r = await window.api.googleDetails(placeId);
  if (r.error) return r;
  const p = r.place;
  const manual = c.gbp?.hours?.source === 'manual' ? c.gbp.hours : null;
  c.gbp = {
    status: 'linked', placeId: p.id, name: p.name, address: p.address, mapsUrl: p.mapsUrl, phone: p.phone, website: p.website,
    businessStatus: p.status, matchedBy: by, checkedAt: todayISO(),
    candidates: candidates && candidates.length > 1 ? candidates : undefined,
    // Google's hours win, except over hours the user typed in when Google has none.
    hours: p.hours && p.hours.periods.length ? { periods: p.hours.periods, source: 'google', updatedAt: todayISO() } : manual,
  };
  return { result: 'linked' };
}

async function refreshHours(c, { force } = {}) {
  const g = c.gbp;
  if (!g?.placeId) return { result: 'skipped' };
  if (g.hours?.source === 'manual' && !force) return { result: 'skipped' }; // don't overwrite hours typed by hand
  const r = await window.api.googleDetails(g.placeId);
  if (r.error) {
    if (r.code === 'NOTFOUND') { c.gbp = { ...g, status: 'notfound', placeId: null, checkedAt: todayISO() }; return { result: 'notfound' }; }
    return r;
  }
  const p = r.place;
  Object.assign(g, { name: p.name, address: p.address, mapsUrl: p.mapsUrl || g.mapsUrl, phone: p.phone, website: p.website, businessStatus: p.status, checkedAt: todayISO() });
  if (p.hours && p.hours.periods.length) g.hours = { periods: p.hours.periods, source: 'google', updatedAt: todayISO() };
  else if (g.hours?.source === 'google') g.hours = null;
  return { result: 'refreshed' };
}

// A Google Maps link (pasted, or from the imported file) → the business it points to.
async function linkFromUrl(c, url, by = 'user') {
  const r = await window.api.googleResolveLink(url);
  if (r.error) return { error: r.error, code: 'LINK' };
  if (r.placeId) {
    const x = await linkPlace(c, r.placeId, by);
    if (!x.error || BLOCKING.includes(x.code) || x.code === 'NETWORK') return x;
  }
  const lat = Number.isFinite(r.lat) ? r.lat : c.lat, lng = Number.isFinite(r.lat) ? r.lng : c.lng;
  if (!r.name && !Number.isFinite(r.lat)) return { error: "This link doesn't point to a business. Open the business in Google Maps, then Share → Copy link.", code: 'LINK' };
  const s = await window.api.googleSearch({ query: r.name || c.name, lat, lng, radius: 300 });
  if (s.error) return s;
  let best = null;
  for (const p of s.places) {
    const sim = Hours.nameSimilarity(r.name || c.name, p.name);
    const d = Number.isFinite(r.lat) && Number.isFinite(p.lat) ? Cluster.distanceKm(r, p) : 0;
    if ((r.name ? sim >= 0.5 : d < 0.05) && (!best || sim - d > best.score)) best = { p, score: sim - d };
  }
  if (!best) return { error: "Couldn't find the business from this link. Try searching with its name instead.", code: 'LINK' };
  return linkPlace(c, best.p.id, by);
}

// Search Google for the client; link it when one result is a sure match, otherwise keep the results for review.
async function findGooglePage(c, { force } = {}) {
  if (c.gbp?.status === 'pending' && c.gbp.mapsUrl) {
    const r = await linkFromUrl(c, c.gbp.mapsUrl, 'file');
    if (!r.error || BLOCKING.includes(r.code) || r.code === 'NETWORK') return r;
  }
  if (!force && (c.gbp?.matchedBy === 'user' || c.gbp?.status === 'none')) return { result: 'skipped' };
  const who = { name: c.name, postcode: postcodeOf(c), address: c.address, lat: c.lat, lng: c.lng, preciseLocation: preciseLoc(c) };
  const bias = hasLoc(c) ? { lat: c.lat, lng: c.lng, radius: who.preciseLocation ? 1000 : 5000 } : {};
  const town = [postcodeOf(c), townOf(c)].filter(Boolean).join(' ');
  const queries = [...new Set([[c.name, geoQuery(c)].filter(Boolean).join(', '), town ? `${c.name} ${town}` : ''])].filter(Boolean);
  const found = new Map();
  let verdict = { match: null, candidates: [] };
  for (const q of queries) {
    const r = await window.api.googleSearch({ query: q, ...bias });
    if (r.error) return r;
    for (const p of r.places) if (!found.has(p.id)) found.set(p.id, p);
    verdict = Hours.judge(who, [...found.values()]);
    if (verdict.match || verdict.candidates.some(x => x.sim >= 0.5)) break; // good enough, save a second search
  }
  const cands = verdict.candidates.slice(0, 5).map(slimCandidate);
  if (verdict.match) return linkPlace(c, verdict.match.id, 'auto', cands);
  c.gbp = { ...keepManualHours(c), status: cands.length ? 'review' : 'notfound', candidates: cands, checkedAt: todayISO(), mapsUrl: c.gbp?.mapsUrl };
  return { result: cands.length ? 'review' : 'notfound' };
}

async function lookupGoogle(list, { refresh = false, auto = false } = {}) {
  if (!list.length) return null;
  if (state.gjob || state.geocoding) { if (!auto) toast('Please wait until the current search is finished.'); return null; }
  if (!state.googleKey.hasKey) { if (!auto) toast('Add a Google API key in Settings first.', { error: true, action: { label: 'Settings', fn: () => settingsDialog({ focus: '#s-gkey' }) } }); return null; }
  const job = state.gjob = { total: list.length, done: 0, stop: false };
  const label = refresh ? 'Updating opening hours' : 'Finding Google business pages';
  showProgress(`${label}… 0 / ${job.total}`, 0);
  const res = { linked: 0, review: 0, notfound: 0, refreshed: 0, skipped: 0 };
  let next = 0, last = Date.now(), netErrors = 0, failure = null;
  const worker = async () => {
    while (!job.stop && next < list.length) {
      const c = list[next++];
      let r;
      try { r = refresh ? await refreshHours(c) : await findGooglePage(c); } catch (e) { r = { error: e.message, code: 'ERROR' }; }
      if (r.error) {
        if (BLOCKING.includes(r.code) || (r.code === 'NETWORK' && ++netErrors >= 3)) { job.stop = true; failure = r; }
      } else res[r.result] = (res[r.result] || 0) + 1;
      job.done++;
      showProgress(`${label}… ${job.done} / ${job.total}`, job.done / job.total);
      if (Date.now() - last > 1500) { last = Date.now(); save(); renderAll(); }
    }
  };
  try { await Promise.all([worker(), worker()]); } finally { state.gjob = null; hideProgress(); }
  save(); renderAll();
  if (state.selectedClientId && !$('#detail').contains(document.activeElement)) renderDetail();
  if (failure) toast(googleErrorText(failure), { error: true });
  else if (refresh) toast(`Opening hours updated for ${res.refreshed} client${res.refreshed === 1 ? '' : 's'}${res.notfound ? `; ${res.notfound} Google page${res.notfound > 1 ? 's' : ''} no longer exist${res.notfound > 1 ? '' : 's'}` : ''}.`);
  else {
    const toCheck = res.review + res.notfound;
    toast(`${res.linked} client${res.linked === 1 ? '' : 's'} linked to their Google page${toCheck ? `, ${toCheck} to check by you` : ''}${job.done < job.total ? ' (stopped)' : ''}.`,
      toCheck ? { action: { label: 'Review', fn: () => reviewGoogle() } } : {});
  }
  return res;
}

// Runs by itself: clients never looked up (new imports), then hours that are getting old.
function autoLookupGoogle() {
  if (!state.googleKey.hasKey || state.gjob || state.geocoding || state.data.demo) return;
  const todo = state.data.clients.filter(c => notLookedUp(c) && (hasLoc(c) || c.gbp?.mapsUrl));
  const days = S().hoursRefreshDays;
  const stale = days > 0 ? state.data.clients.filter(c => c.gbp?.status === 'linked' && c.gbp.placeId && c.gbp.hours?.source !== 'manual'
    && daysSince(c.gbp.hours?.updatedAt || c.gbp.checkedAt) >= days) : [];
  (async () => {
    if (todo.length) await lookupGoogle(todo, { auto: true });
    if (stale.length && !state.gjob) await lookupGoogle(stale, { refresh: true, auto: true });
  })();
}

// ---------- Review: choose the right Google page, search again, paste a link, or type hours ----------
function reviewGoogle(ids) {
  const single = !!ids;
  const notes = {}, typed = {};
  const list = () => (single ? ids.map(clientById).filter(Boolean) : state.data.clients.filter(needsGoogleCheck).sort((a, b) => a.name.localeCompare(b.name)));
  const distTxt = d => (d === null || d === undefined ? '' : d < 1 ? `${Math.round(d * 1000 / 10) * 10} m from the client's address` : `${fmtKm(d)} from the client's address`);
  const hasKey = state.googleKey.hasKey;
  showModal({
    wide: true,
    title: single ? `Google business page — ${esc(clientById(ids[0])?.name || '')}` : 'Choose the Google business pages',
    desc: hasKey
      ? (single ? 'Pick the right business, search Google with other words, paste the link of its Google Maps page, or type the hours yourself.'
        : 'These clients couldn\'t be matched for sure. Pick the right business, search with other words, paste the link of its Google Maps page, or type the hours yourself.')
      : 'Without a Google API key the app can\'t read Google pages. You can still save the link of the Google Maps page and type the hours yourself — or add a key in Settings.',
    render: () => {
      const items = list();
      if (!items.length) return '<p style="margin:6px 0 10px">Nothing left to check. 🎉</p>';
      return items.map(c => {
        const g = c.gbp || {}, t = typed[c.id] || {}, n = notes[c.id];
        const cands = (g.candidates || []).filter(p => p.id !== g.placeId);
        const current = g.placeId ? `<div class="cand current"><div class="cand-main"><span class="pill ok">Linked now</span> <b>${esc(g.name)}</b><div class="cand-addr">${esc(g.address || '')}</div></div><div class="cand-acts"><button class="btn small ghost" data-g="view" data-url="${esc(g.mapsUrl || '')}">View on Google</button></div></div>` : '';
        const candHtml = cands.map(p => `<div class="cand">
            <div class="cand-main"><b>${esc(p.name)}</b>${p.type ? ` <span class="cand-type">${esc(p.type)}</span>` : ''}
              <div class="cand-addr">${esc(p.address)}</div>
              <div class="cand-meta">${esc(distTxt(p.dist))}${p.status === 'CLOSED_PERMANENTLY' ? ' · <b class="bad">Permanently closed</b>' : p.status === 'CLOSED_TEMPORARILY' ? ' · Temporarily closed' : ''}</div></div>
            <div class="cand-acts"><button class="btn small primary" data-g="pick" data-pid="${esc(p.id)}">This is it</button>${p.mapsUrl ? `<button class="btn small ghost" data-g="view" data-url="${esc(p.mapsUrl)}">View on Google</button>` : ''}</div>
          </div>`).join('');
        const none = !cands.length && !g.placeId && g.status !== 'pending' && g.status ? `<div class="fix-msg">${g.status === 'none' ? 'Marked as having no Google page.' : 'Google found no business with this name and address.'}</div>` : '';
        return `<div class="fix-row" data-id="${c.id}">
          <div class="fix-head"><b>${esc(c.name)}</b><span class="fix-q">${esc(geoQuery(c) || 'No address')}</span></div>
          ${current}${candHtml}${none}
          <div class="gtools">
            ${hasKey ? `<input data-k="q" value="${esc(t.q ?? [c.name, townOf(c)].filter(Boolean).join(' '))}" placeholder="Name and town to search on Google"><button class="btn small" data-g="search">Search Google</button>` : ''}
            <input data-k="url" value="${esc(t.url ?? '')}" placeholder="…or paste the link of its Google Maps page (Share → Copy link)"><button class="btn small" data-g="link">Use this link</button>
          </div>
          ${n ? `<div class="fix-msg ${n.ok ? 'ok' : 'bad'}">${esc(n.text)}</div>` : ''}
          <div class="fix-acts">
            <button class="btn small ghost" data-g="maps">Look it up in Google Maps</button>
            <button class="btn small ghost" data-g="hours">${hoursOf(c) ? 'Edit hours by hand' : 'Enter hours by hand'}</button>
            ${g.status !== 'none' ? '<button class="btn small ghost" data-g="none">It has no Google page</button>' : ''}
            ${single ? '' : '<button class="btn small ghost" data-g="open">Open client card</button>'}
          </div>
        </div>`;
      }).join('');
    },
    buttons: [{ label: 'Close', action: 'close' }],
    onInput(e) {
      const row = e.target.closest('.fix-row'), k = e.target.dataset.k;
      if (row && k) (typed[row.dataset.id] = typed[row.dataset.id] || {})[k] = e.target.value;
    },
    onClose: () => { save(); renderAll(); renderDetail(); },
    async onClick(e, box, close, rerender) {
      const b = e.target.closest('[data-g]');
      if (!b) return;
      const row = b.closest('.fix-row');
      const c = row && clientById(row.dataset.id);
      if (!c) return;
      const act = b.dataset.g;
      const busy = txt => { b.disabled = true; b.textContent = txt; };
      const done = (r, okText) => {
        if (r.error) notes[c.id] = { ok: false, text: googleErrorText(r) };
        else if (r.result === 'linked') {
          delete notes[c.id];
          toast(`${c.name} → ${c.gbp.name}${okText || ''}${hoursOf(c) ? '' : ' (Google has no opening hours for it)'}.`);
          if (single) { close(); return; }
        }
        save(); renderAll(); rerender();
      };
      if (act === 'view' && b.dataset.url) window.api.openExternal(b.dataset.url);
      if (act === 'maps') window.api.openExternal('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([c.name, geoQuery(c)].filter(Boolean).join(', ')));
      if (act === 'open') { close(); state.tab = 'clients'; selectClient(c.id, { pan: true }); }
      if (act === 'pick') { busy('Linking…'); done(await linkPlace(c, b.dataset.pid, 'user', c.gbp?.candidates)); }
      if (act === 'search') {
        const q = (typed[c.id]?.q ?? row.querySelector('[data-k="q"]').value).trim();
        if (!q) return;
        busy('Searching…');
        const r = await window.api.googleSearch({ query: q, lat: c.lat, lng: c.lng, radius: preciseLoc(c) ? 2000 : 8000 });
        if (r.error) { done(r); return; }
        const v = Hours.judge({ name: c.name, postcode: postcodeOf(c), address: c.address, lat: c.lat, lng: c.lng, preciseLocation: preciseLoc(c) }, r.places);
        c.gbp = { ...(c.gbp || {}), status: c.gbp?.placeId ? 'linked' : v.candidates.length ? 'review' : 'notfound', candidates: v.candidates.slice(0, 5).map(slimCandidate), checkedAt: todayISO() };
        notes[c.id] = v.candidates.length ? { ok: true, text: `${v.candidates.length} result${v.candidates.length > 1 ? 's' : ''} for “${q}”.` } : { ok: false, text: `Nothing found for “${q}”.` };
        save(); rerender();
      }
      if (act === 'link') {
        const url = (typed[c.id]?.url ?? row.querySelector('[data-k="url"]').value).trim();
        if (!/^https?:\/\//i.test(url)) { notes[c.id] = { ok: false, text: 'Paste a link that starts with https:// (in Google Maps: Share → Copy link).' }; rerender(); return; }
        if (!hasKey) {
          c.gbp = { ...keepManualHours(c), status: 'manual', mapsUrl: url, matchedBy: 'user', checkedAt: todayISO() };
          toast(`Link saved for ${c.name}. Type its hours so they show in the app.`);
          close(); editHours(c, single ? null : () => reviewGoogle());
          return;
        }
        busy('Reading link…');
        done(await linkFromUrl(c, url, 'user'));
      }
      if (act === 'hours') { close(); editHours(c, single ? null : () => reviewGoogle()); }
      if (act === 'none') {
        c.gbp = { ...keepManualHours(c), status: hoursOf(c) ? 'manual' : 'none', mapsUrl: undefined, checkedAt: todayISO() };
        toast(`${c.name}: marked as having no Google page.`);
        if (single) { close(); return; }
        save(); renderAll(); rerender();
      }
    },
  });
}

// ---------- Typing opening hours by hand ----------
function editHours(c, after) {
  const lines = Hours.toLines(hoursOf(c));
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  let errDay = -1;
  const apply = hours => {
    c.gbp = { ...(c.gbp || {}), hours };
    if (c.gbp.status !== 'linked') c.gbp.status = hours ? 'manual' : (c.gbp.mapsUrl ? 'manual' : 'none');
    delete c.gbp.candidates;
    save(); renderAll(); renderDetail();
  };
  showModal({
    title: `Opening hours — ${esc(c.name)}`,
    desc: 'For each day, type the opening times, e.g. <b>9:00–12:00, 14:00–18:30</b> or <b>9h-12h 14h-18h30</b>. Leave a day empty when it is closed.',
    render: () => `
      <div class="hours-edit">${DAYS.map((d, i) => `<label for="h-${i}">${d}</label><input id="h-${i}" data-day="${i}" value="${esc(lines[i] === 'Closed' ? '' : lines[i])}" placeholder="Closed"${i === errDay ? ' class="bad"' : ''}>`).join('')}</div>
      <div style="margin-top:8px"><button class="btn small ghost" data-h="copy">Copy Monday to Tuesday–Friday</button></div>
      ${c.gbp?.hours?.source === 'google' ? '<p class="note">These hours come from Google. If you change them, the app will keep your version until you click “Refresh from Google”.</p>' : ''}
      <div class="err" id="h-err"></div>`,
    buttons: [
      ...(hoursOf(c) ? [{ label: 'Remove hours', fn: close => { close(); apply(null); toast(`Opening hours removed for ${c.name}.`); } }] : []),
      { label: 'Cancel', action: 'close' },
      { label: 'Save', primary: true, action: 'ok' },
    ],
    onInput(e) {
      if (e.target.dataset.day === undefined) return;
      lines[+e.target.dataset.day] = e.target.value;
      if (+e.target.dataset.day === errDay) { errDay = -1; e.target.classList.remove('bad'); }
    },
    onClick(e, box, close, rerender) {
      if (e.target.closest('[data-h="copy"]')) { for (let i = 1; i <= 4; i++) lines[i] = lines[0]; rerender(); }
    },
    onOk(close, box) {
      let parsed;
      try { parsed = Hours.parseWeek(lines); } catch (err) {
        errDay = err.day ?? -1;
        box.querySelectorAll('.hours-edit input').forEach((inp, i) => inp.classList.toggle('bad', i === errDay));
        box.querySelector('#h-err').textContent = `${DAYS[errDay] || ''}: ${err.message}`;
        return;
      }
      if (!parsed.periods.length) { box.querySelector('#h-err').textContent = 'Type at least one opening, or use “Remove hours”.'; return; }
      close();
      apply({ periods: parsed.periods, source: 'manual', updatedAt: todayISO() });
      toast(`Opening hours saved for ${c.name}.`);
    },
    onClose: () => { if (after) setTimeout(after, 0); },
  });
}

// ---------- Overview (… menu → Opening hours) ----------
function hoursOverview() {
  const cl = state.data.clients;
  const count = f => cl.filter(f).length;
  const nGoogle = count(c => hoursOf(c)?.source === 'google'), nHand = count(c => hoursOf(c)?.source === 'manual');
  const nNoHours = count(c => c.gbp?.status === 'linked' && !hoursOf(c));
  const nReview = count(needsGoogleCheck), nNone = count(c => c.gbp?.status === 'none');
  const todo = cl.filter(c => notLookedUp(c) && (hasLoc(c) || c.gbp?.mapsUrl));
  const linked = cl.filter(c => c.gbp?.placeId && c.gbp.status === 'linked');
  const hasKey = state.googleKey.hasKey;
  showModal({
    title: 'Opening hours',
    desc: hasKey ? `Google API key saved (${esc(state.googleKey.masked)}).` : 'No Google API key yet — hours can only be typed by hand.',
    render: () => `
      <dl class="extra hours-stats">
        <dt>Hours from Google</dt><dd>${nGoogle}</dd>
        <dt>Hours typed by hand</dt><dd>${nHand}</dd>
        <dt>Google page without hours</dt><dd>${nNoHours}</dd>
        <dt>To check (no sure match)</dt><dd>${nReview}</dd>
        <dt>No Google page</dt><dd>${nNone}</dd>
        <dt>Not looked up yet</dt><dd>${todo.length}</dd>
      </dl>
      <div class="fix-acts" style="margin-top:14px">
        ${hasKey && todo.length ? `<button class="btn small primary" data-o="lookup">Look up ${todo.length} client${todo.length > 1 ? 's' : ''} on Google</button>` : ''}
        ${nReview ? `<button class="btn small${hasKey && todo.length ? '' : ' primary'}" data-o="review">Review ${nReview}…</button>` : ''}
        ${hasKey && linked.length ? `<button class="btn small" data-o="refresh">Update hours of ${linked.length} linked client${linked.length > 1 ? 's' : ''}</button>` : ''}
        <button class="btn small ghost" data-o="settings">${hasKey ? 'Google settings' : 'Add a Google API key'}</button>
      </div>
      ${hasKey ? `<p class="note">Hours are updated automatically every ${S().hoursRefreshDays || '—'} days${S().hoursRefreshDays ? '' : ' (off)'}. Each update reads one Google page per client; Google bills this beyond its monthly free allowance.</p>` : ''}`,
    buttons: [{ label: 'Close', action: 'close' }],
    onClick(e, box, close) {
      const o = e.target.closest('[data-o]')?.dataset.o;
      if (!o) return;
      close();
      if (o === 'lookup') lookupGoogle(todo);
      if (o === 'review') reviewGoogle();
      if (o === 'refresh') lookupGoogle(linked, { refresh: true });
      if (o === 'settings') settingsDialog({ focus: '#s-gkey' });
    },
  });
}

// Hours change with the clock: refresh "Open till…" labels every minute.
setInterval(() => {
  if (document.hidden || !state.data.clients.some(hoursOf)) return;
  renderList();
  if (state.selectedClientId && !$('#detail').contains(document.activeElement)) renderDetail();
}, 60000);

// =====================================================================
// Grouping
// =====================================================================
function assignColors(groups) {
  const usage = new Array(PALETTE.length).fill(0);
  const done = [];
  for (const g of groups) {
    const near = done.filter(o => o.lat !== null && g.lat !== null)
      .map(o => [o, Cluster.distanceKm(g, o)]).sort((a, b) => a[1] - b[1]).slice(0, 6).map(x => x[0].color);
    let best = 0, bestScore = Infinity;
    PALETTE.forEach((col, i) => {
      const nIdx = near.indexOf(col);
      const score = (nIdx >= 0 ? 100 * (6 - nIdx) : 0) + usage[i];
      if (score < bestScore) { bestScore = score; best = i; }
    });
    g.color = PALETTE[best]; usage[best]++;
    done.push(g);
  }
}

async function regroup({ confirm = true } = {}) {
  const located = state.data.clients.filter(hasLoc);
  if (!located.length) { toast('No client is on the map yet, so there is nothing to group.', { error: true }); return; }
  if (confirm && state.data.groups.length) {
    const ok = await confirmDialog('Regroup all clients?', `The current ${state.data.groups.length} groups will be replaced by new ones (up to ${S().maxSize} clients each, all within ${S().maxSpanKm} km). Group names you chose yourself will be lost. Visit history is kept.`, 'Regroup');
    if (!ok) return;
  }
  showProgress('Grouping clients by proximity…', null);
  await new Promise(r => setTimeout(r, 30));
  try {
    const res = Cluster.groupByTownAndDistance(located.map(c => ({ lat: c.lat, lng: c.lng, town: townOf(c) })),
      { maxSize: S().maxSize, flexSize: S().flexSize, maxSpanKm: S().maxSpanKm });
    const groups = Array.from({ length: res.groups }, (_, i) => ({ id: uid(), number: i + 1, name: '', color: '', lat: null, lng: null }));
    const members = groups.map(() => []);
    for (const c of state.data.clients) c.groupId = null;
    located.forEach((c, i) => { c.groupId = groups[res.labels[i]].id; members[res.labels[i]].push(c); });
    groups.forEach((g, i) => {
      g.lat = members[i].reduce((a, c) => a + c.lat, 0) / members[i].length;
      g.lng = members[i].reduce((a, c) => a + c.lng, 0) / members[i].length;
    });
    assignColors(groups);
    groups.forEach(g => { delete g.lat; delete g.lng; });
    state.data.groups = groups;
    state.selectedGroupId = null; state.selectedClientId = null;
    state.tab = 'groups';
    save(); renderAll(); renderDetail(); fitAll();
    const notes = [];
    if (res.oversized) notes.push(`${res.oversized} ${res.oversized === 1 ? 'is' : 'are'} a bit bigger to keep a town together`);
    if (res.splitTowns.length) notes.push(`${res.splitTowns.map(titleCase).join(', ')} had too many clients for one group and ${res.splitTowns.length === 1 ? 'was' : 'were'} split by neighbourhood`);
    toast(`${res.groups} group${res.groups === 1 ? '' : 's'} created, each within ${S().maxSpanKm} km${notes.length ? ' — ' + notes.join('; ') : ''}.${homeOf() ? ' Group 1 is the nearest to home.' : ''}`);
  } finally { hideProgress(); }
}

function assignToNearest(list, { quiet } = {}) {
  derive();
  const groups = [...state.derived.byGroup.values()].map(i => ({ info: i, members: i.members.filter(hasLoc) }));
  let created = 0, added = 0;
  for (const c of list) {
    if (!hasLoc(c)) continue;
    const town = norm(townOf(c));
    let best = null, bestScore = Infinity;
    for (const g of groups) {
      if (!g.members.length) continue;
      const far = g.members.reduce((m, x) => Math.max(m, Cluster.distanceKm(c, x)), 0);
      if (far > S().maxSpanKm) continue;                          // would break the distance rule
      const allSameTown = town && g.members.every(x => norm(townOf(x)) === town);
      const limit = allSameTown ? S().flexSize : S().maxSize;     // a town may go a bit over to stay together
      if (g.members.length >= limit) continue;
      const sameTown = town && g.members.some(x => norm(townOf(x)) === town);
      const score = far - (sameTown ? 1000 : 0);                  // prefer the group of the same town
      if (score < bestScore) { bestScore = score; best = g; }
    }
    if (!best) {
      // Nothing close enough with room: start a new group.
      const number = state.data.groups.reduce((m, g) => Math.max(m, g.number), 0) + 1;
      const g = { id: uid(), number, name: '', color: PALETTE[(number - 1) % PALETTE.length] };
      state.data.groups.push(g);
      best = { info: { group: g }, members: [] };
      groups.push(best);
      created++;
    }
    c.groupId = best.info.group.id;
    best.members.push(c);
    added++;
  }
  if (!quiet && added) toast(`${added} client${added > 1 ? 's' : ''} added to the nearest group${created ? `; ${created} new group${created > 1 ? 's' : ''} started because no group within ${S().maxSpanKm} km had room` : ''}.`);
}

// =====================================================================
// Geocoding
// =====================================================================
function geoQuery(c) {
  return [c.address, [c.postcode, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}
async function geocodeOne(c) {
  const query = geoQuery(c);
  if (!query) { c.geo = { status: 'failed', label: '', score: 0 }; return false; }
  const r = await window.api.geocode({ query, postcode: c.postcode, country: c.country });
  if (r && Number.isFinite(r.lat)) {
    c.lat = r.lat; c.lng = r.lng;
    c.geo = { status: 'ok', label: r.label, score: r.score, source: r.source, precision: r.precision, city: r.city || '', postcode: r.postcode || '' };
    return true;
  }
  const notFound = !r || /not found/i.test(r.error || '');
  if (notFound) { c.geo = { status: 'failed', label: '', score: 0 }; delete c.lat; delete c.lng; }
  return notFound ? false : null; // null = network problem, try again later
}

async function geocodeClients(list) {
  if (!list.length || state.geocoding) return { ok: 0, failed: 0, network: 0 };
  if (state.gjob) state.gjob.stop = true; // addresses first; the Google lookup starts again afterwards
  const job = state.geocoding = { total: list.length, done: 0, stop: false };
  renderBanners();
  showProgress(`Locating addresses… 0 / ${job.total}`, 0);
  const res = { ok: 0, failed: 0, network: 0 };
  let next = 0, lastRender = Date.now();
  const worker = async () => {
    while (!job.stop && next < list.length) {
      const c = list[next++];
      let r;
      try { r = await geocodeOne(c); } catch { r = null; }
      if (r === true) res.ok++; else if (r === false) res.failed++; else res.network++;
      job.done++;
      showProgress(`Locating addresses… ${job.done} / ${job.total}`, job.done / job.total);
      if (res.network >= 6 && res.ok === 0) job.stop = true; // probably offline
      if (Date.now() - lastRender > 1200) { lastRender = Date.now(); save(); renderAll(); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  state.geocoding = null;
  hideProgress();
  save(); renderAll();
  if (res.network && !res.ok) toast("Couldn't reach the address service. Check the internet connection, then use “Locate now”.", { error: true });
  else toast(`${res.ok} address${res.ok === 1 ? '' : 'es'} placed on the map${res.failed ? `, ${res.failed} not found` : ''}${job.stop && job.done < job.total ? ' (stopped)' : ''}.`,
    res.failed ? { action: { label: 'See which', fn: reviewUnlocated } } : {});
  return res;
}
$('#progress-stop').addEventListener('click', () => { if (state.geocoding) state.geocoding.stop = true; if (state.gjob) state.gjob.stop = true; });

function afterLocate() {
  if (!state.data.groups.length) { if (state.data.clients.some(hasLoc)) regroup({ confirm: false }); }
  else fitAll();
  setTimeout(autoLookupGoogle, 400);
}

// =====================================================================
// Import
// =====================================================================
const FIELDS = [
  { key: 'name', label: 'Client name', required: true, re: /^(nom|name|client|raison sociale|societe|company|enseigne|customer|denomination|etablissement)/ },
  { key: 'address', label: 'Street address', re: /(adresse|address|rue|street|voie)/ },
  { key: 'postcode', label: 'Postal code', re: /(code postal|^cp$|postal|zip|postcode)/ },
  { key: 'city', label: 'City', re: /(ville|city|commune|localite|town)/ },
  { key: 'country', label: 'Country', re: /(pays|country)/ },
  { key: 'lat', label: 'Latitude', re: /^(lat|latitude)$/ },
  { key: 'lng', label: 'Longitude', re: /^(lon|lng|long|longitude)$/ },
  { key: 'lastVisit', label: 'Last visit date', re: /(derniere visite|last visit|date visite|visite|visit)/ },
  { key: 'notes', label: 'Notes', re: /(note|comment|remarque|observation|description)/ },
  { key: 'googleUrl', label: 'Google Maps link', re: /(google|maps|gmb|fiche)/ },
  { key: 'tier', label: 'Priority (A/B/C)', re: /(priorit|^tier$|^abc$)/ },
];
const GUESS_ORDER = ['lat', 'lng', 'googleUrl', 'postcode', 'city', 'country', 'lastVisit', 'tier', 'notes', 'name', 'address'];
// Columns written by the app's own Excel export that are recomputed, not kept, when the file is imported back.
const EXPORT_ONLY_COLUMNS = new Set(['Opening hours', 'Phone (Google)', 'Distance from home (km)', 'Next planned visit', 'Visits done']);

function guessMapping(headers) {
  const used = new Set(), map = {};
  const h = headers.map(norm);
  for (const key of GUESS_ORDER) {
    const f = FIELDS.find(x => x.key === key);
    const idx = h.findIndex((x, i) => !used.has(i) && x && f.re.test(x));
    map[key] = idx;
    if (idx >= 0) used.add(idx);
  }
  return map;
}
const colLetter = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

// ---------- KMZ / KML (Google Earth, Google My Maps) ----------
// Turns placemarks into a table so they go through the same column-matching screen as Excel files.
function kmlToSheets(kmlText, fileName) {
  const doc = new DOMParser().parseFromString(kmlText.replace(/^﻿/, ''), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('This KML file could not be read.');
  const kids = (el, name) => [...el.children].filter(c => c.localName === name);
  const kid = (el, name) => kids(el, name)[0];
  const text = (el, name) => (kid(el, name)?.textContent || '').trim();
  const htmlToText = h => {
    if (!/[<&]/.test(h)) return h.trim();
    const d = new DOMParser().parseFromString(h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li)>/gi, '\n'), 'text/html');
    return (d.body.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };
  const parseCoords = s => s.trim().split(/\s+/).map(t => t.split(',').map(Number)).filter(c => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]));
  const placemarks = [...doc.getElementsByTagNameNS('*', 'Placemark')];
  const extraKeys = [];
  let skipped = 0;
  const recs = placemarks.map(pm => {
    const rec = { name: text(pm, 'name'), address: text(pm, 'address'), description: htmlToText(text(pm, 'description')), data: {} };
    // Folder path (e.g. "Clients / Lyon")
    const folders = [];
    for (let p = pm.parentElement; p; p = p.parentElement) if (p.localName === 'Folder' && text(p, 'name')) folders.unshift(text(p, 'name'));
    rec.folder = folders.join(' / ');
    // Extra fields: <ExtendedData><Data name=".."><value>..</value></Data> and <SchemaData><SimpleData name="..">
    for (const d of pm.getElementsByTagNameNS('*', 'Data')) {
      if (d.closest('Placemark') !== pm) continue;
      const k = (d.getAttribute('name') || '').trim(); if (!k) continue;
      rec.data[k] = htmlToText(text(d, 'value'));
    }
    for (const d of pm.getElementsByTagNameNS('*', 'SimpleData')) {
      const k = (d.getAttribute('name') || '').trim(); if (k) rec.data[k] = d.textContent.trim();
    }
    for (const k of Object.keys(rec.data)) if (!extraKeys.includes(k)) extraKeys.push(k);
    // Position: a Point if there is one, otherwise the centre of the shape's coordinates.
    const point = pm.getElementsByTagNameNS('*', 'Point')[0];
    const coordEls = point ? point.getElementsByTagNameNS('*', 'coordinates') : pm.getElementsByTagNameNS('*', 'coordinates');
    let pts = [];
    for (const c of coordEls) pts = pts.concat(parseCoords(c.textContent));
    if (!point && pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    if (pts.length) {
      rec.lng = pts.reduce((a, c) => a + c[0], 0) / pts.length;
      rec.lat = pts.reduce((a, c) => a + c[1], 0) / pts.length;
    } else if (!rec.address) skipped++;
    return rec;
  });
  if (!recs.length) return { sheets: [], skipped };
  // Don't duplicate a column that the placemark fields already provide.
  const ownExport = [...doc.getElementsByTagNameNS('*', 'Data')].some(d => d.getAttribute('name') === 'generator' && d.textContent.trim() === 'Client Clusters');
  if (ownExport) recs.forEach(r => { r.description = ''; r.folder = ''; delete r.data.Group; });
  const extras = extraKeys.filter(k => !(ownExport && k === 'Group'))
    .filter(k => !['name', 'address', 'description', 'latitude', 'longitude'].includes(norm(k)) || recs.every(r => !r[norm(k)]));
  // Description goes after the data fields so a real "Notes" field is preferred for notes.
  const headers = ['Name', 'Address', 'Folder', ...extras, 'Description', 'Latitude', 'Longitude'];
  const rows = [headers, ...recs.map(r => [r.name, r.address, r.folder, ...extras.map(k => r.data[k] ?? ''), r.description,
    r.lat !== undefined ? r.lat.toFixed(7) : '', r.lng !== undefined ? r.lng.toFixed(7) : ''])];
  // Drop columns that are empty everywhere (e.g. no Address or Folder in the file).
  const keep = headers.map((_, i) => i >= headers.length - 2 || rows.slice(1).some(r => String(r[i] ?? '').trim()));
  const docName = (doc.getElementsByTagNameNS('*', 'Document')[0] && text(doc.getElementsByTagNameNS('*', 'Document')[0], 'name')) || fileName;
  return { sheets: [{ name: docName, rows: rows.map(r => r.filter((_, i) => keep[i])) }], skipped };
}

async function openImport() {
  let file;
  try { file = await window.api.openImportFile(); } catch (e) { toast('Could not read this file: ' + e.message, { error: true }); return; }
  if (!file) return;
  if (file.kml !== undefined) {
    try {
      const k = kmlToSheets(file.kml, file.fileName);
      file.sheets = k.sheets;
      if (k.skipped) toast(`${k.skipped} placemark${k.skipped > 1 ? 's have' : ' has'} no position: ${k.skipped > 1 ? 'they' : 'it'} will be listed as “not on the map” so you can place ${k.skipped > 1 ? 'them' : 'it'} by hand.`);
    } catch (e) { toast(e.message, { error: true }); return; }
    if (!file.sheets.length) { toast('No placemarks found in this file.', { error: true }); return; }
  }
  if (!file.sheets.length) { toast('This file looks empty.', { error: true }); return; }
  const st = { sheet: 0, header: true, mapping: null, mode: state.data.clients.length && !state.data.demo ? 'merge' : 'replace' };
  const sheetData = () => {
    const rows = file.sheets[st.sheet].rows;
    const width = Math.max(...rows.map(r => r.length));
    const headers = st.header ? Array.from({ length: width }, (_, i) => String(rows[0][i] ?? '').trim() || `Column ${colLetter(i)}`) : Array.from({ length: width }, (_, i) => `Column ${colLetter(i)}`);
    return { headers, data: st.header ? rows.slice(1) : rows };
  };
  st.mapping = guessMapping(sheetData().headers);

  showModal({
    wide: true,
    title: 'Import clients',
    desc: `From <b>${esc(file.fileName)}</b>. Tell the app which column holds what — it guessed from your column titles.`,
    render(box) {
      const { headers, data } = sheetData();
      const opt = (key) => `<option value="-1">— none —</option>` + headers.map((h, i) => `<option value="${i}"${st.mapping[key] === i ? ' selected' : ''}>${esc(h)}</option>`).join('');
      const mapped = FIELDS.filter(f => st.mapping[f.key] >= 0);
      const preview = data.slice(0, 6).map(r => `<tr>${mapped.map(f => `<td>${esc(r[st.mapping[f.key]] ?? '')}</td>`).join('')}</tr>`).join('');
      return `
        ${file.sheets.length > 1 ? `<div class="field" style="max-width:300px"><label>Sheet</label><select data-imp="sheet">${file.sheets.map((s, i) => `<option value="${i}"${i === st.sheet ? ' selected' : ''}>${esc(s.name)} (${s.rows.length} rows)</option>`).join('')}</select></div>` : ''}
        <label class="check" style="margin-bottom:12px"><input type="checkbox" data-imp="header"${st.header ? ' checked' : ''}> The first row contains column titles</label>
        <div class="map-grid">
          ${FIELDS.map(f => `<div class="field"><label>${f.label}${f.required ? ' <b>*</b>' : ''}</label><select data-map="${f.key}">${opt(f.key)}</select></div>`).join('')}
        </div>
        <p class="note">You need a name, plus an address (street, postal code and/or city) or latitude and longitude. Other columns are kept and shown on each client's card.</p>
        <div class="preview"><table><thead><tr>${mapped.map(f => `<th>${f.label}</th>`).join('')}</tr></thead><tbody>${preview}</tbody></table></div>
        <p class="note">${data.length} rows in this sheet.</p>
        ${state.data.clients.length && !state.data.demo ? `
          <div class="field" style="margin-top:12px"><label>What to do with your current ${state.data.clients.length} clients</label>
            <div class="radio-list">
              <label><input type="radio" name="impmode" value="merge"${st.mode === 'merge' ? ' checked' : ''}><span><b>Add to my list</b> — clients already in the app (same name and address) are updated; their visits are kept.</span></label>
              <label><input type="radio" name="impmode" value="replace"${st.mode === 'replace' ? ' checked' : ''}><span><b>Replace my whole list</b> — current clients and their visit history are removed.</span></label>
            </div></div>` : ''}
        <div class="err" id="imp-err"></div>`;
    },
    buttons: [{ label: 'Cancel', action: 'close' }, { label: 'Import', primary: true, action: 'ok' }],
    onChange(e, rerender) {
      const t = e.target;
      if (t.dataset.imp === 'sheet') { st.sheet = +t.value; st.mapping = guessMapping(sheetData().headers); }
      else if (t.dataset.imp === 'header') { st.header = t.checked; st.mapping = guessMapping(sheetData().headers); }
      else if (t.dataset.map) st.mapping[t.dataset.map] = +t.value;
      else if (t.name === 'impmode') st.mode = t.value;
      rerender();
    },
    async onOk(close, box) {
      const m = st.mapping;
      const err = msg => { box.querySelector('#imp-err').textContent = msg; };
      if (m.name < 0) return err('Choose the column with the client name.');
      if (m.address < 0 && m.city < 0 && m.postcode < 0 && !(m.lat >= 0 && m.lng >= 0)) return err('Choose at least an address, postal code or city column (or latitude and longitude).');
      if (st.mode === 'replace' && state.data.clients.length && !state.data.demo) {
        if (!(await confirmDialog('Replace your whole list?', `Your current ${state.data.clients.length} clients and all their recorded visits will be removed.`, 'Replace', true))) return;
      }
      close();
      runImport(sheetData(), m, st.mode);
    },
  });
}

function runImport({ headers, data }, m, mode) {
  const get = (r, k) => (m[k] >= 0 ? String(r[m[k]] ?? '').trim() : '');
  const mappedIdx = new Set(Object.values(m).filter(i => i >= 0));
  if (mode === 'replace' || state.data.demo) { state.data.clients = []; state.data.groups = []; state.data.demo = false; }
  const keyOf = c => norm(c.name) + '|' + norm(c.address) + '|' + norm(c.postcode) + '|' + norm(c.city);
  const index = new Map(state.data.clients.map(c => [keyOf(c), c]));
  let added = 0, updated = 0, skipped = 0, badDates = 0;

  for (const r of data) {
    const rec = {
      name: get(r, 'name'), address: get(r, 'address'), postcode: get(r, 'postcode'), city: get(r, 'city'),
      country: get(r, 'country'), notes: get(r, 'notes'),
    };
    if (!rec.name && !rec.address) { skipped++; continue; }
    if (!rec.name) rec.name = rec.address;
    if (/^\d{4}$/.test(rec.postcode) && (!rec.country || /^fr/i.test(rec.country))) rec.postcode = '0' + rec.postcode; // Excel drops leading zeros
    const lat = parseCoord(get(r, 'lat'), 90), lng = parseCoord(get(r, 'lng'), 180);
    const lvRaw = get(r, 'lastVisit');
    const lv = parseDateLoose(lvRaw);
    if (lvRaw && !lv) badDates++;
    const extra = {};
    headers.forEach((h, i) => { if (!mappedIdx.has(i) && !EXPORT_ONLY_COLUMNS.has(h) && String(r[i] ?? '').trim()) extra[h] = String(r[i]).trim(); });

    const existing = index.get(keyOf(rec));
    const c = existing || { id: uid(), visits: [], groupId: null, createdAt: todayISO() };
    const addrChanged = !existing || ['address', 'postcode', 'city', 'country'].some(k => (c[k] || '') !== rec[k]);
    Object.assign(c, { name: rec.name, address: rec.address, postcode: rec.postcode, city: rec.city, country: rec.country });
    if (rec.notes && !c.notes) c.notes = rec.notes; else c.notes = c.notes || '';
    c.extra = { ...(c.extra || {}), ...extra };
    if (lat !== null && lng !== null && !(lat === 0 && lng === 0)) {
      c.lat = lat; c.lng = lng; c.geo = { status: 'ok', label: 'From your file', score: 1, source: 'file' };
    } else if (addrChanged) {
      delete c.lat; delete c.lng; c.geo = { status: 'pending' };
      if (existing) c.groupId = null;
    }
    // Google business page: a link in the file is used as is; otherwise a new address means looking it up again.
    const gUrl = get(r, 'googleUrl');
    if (/^https?:\/\//i.test(gUrl)) {
      if (!c.gbp || (c.gbp.mapsUrl !== gUrl && c.gbp.matchedBy !== 'user')) c.gbp = { ...keepManualHours(c), status: 'pending', mapsUrl: gUrl };
    } else if (existing && addrChanged && c.gbp && c.gbp.matchedBy === 'auto') delete c.gbp;
    const tier = parseTier(get(r, 'tier'));
    if (tier) c.tier = tier;
    if (lv && !c.visits.some(v => v.date === lv)) recordVisit(c, { date: lv, note: existing ? 'From imported file' : '' });
    if (existing) updated++;
    else { state.data.clients.push(c); index.set(keyOf(c), c); added++; }
  }
  state.selectedClientId = null; state.selectedGroupId = null; state.clientFilter = null;
  save(); renderAll(); renderDetail();
  toast(`${added} client${added === 1 ? '' : 's'} added${updated ? `, ${updated} updated` : ''}${skipped ? `, ${skipped} empty row${skipped > 1 ? 's' : ''} skipped` : ''}.${badDates ? ` ${badDates} visit date${badDates > 1 ? 's' : ''} couldn't be read.` : ''}`);
  const pending = state.data.clients.filter(c => !hasLoc(c) && c.geo?.status === 'pending');
  const finish = () => {
    if (!state.data.groups.length) afterLocate();
    else { fitAll(); if (state.derived.ungrouped.length) toast('New clients are not in a group yet — see the note above the groups list.'); autoLookupGoogle(); }
  };
  if (pending.length) geocodeClients(pending).then(finish); else finish();
}

// =====================================================================
// Add client manually
// =====================================================================
function addClientDialog() {
  showModal({
    title: 'Add a client',
    render: () => `
      <div class="field"><label>Name <b style="color:var(--late)">*</b></label><input id="n-name" autofocus></div>
      <div class="field"><label>Street address</label><input id="n-address"></div>
      <div class="field-row field"><div class="field" style="margin:0"><label>Postal code</label><input id="n-postcode"></div><div class="field" style="margin:0"><label>City</label><input id="n-city"></div></div>
      <div class="field"><label>Country (optional)</label><input id="n-country" placeholder="France"></div>
      <div class="field-row field" style="grid-template-columns:1fr 1fr 1fr">
        <div class="field" style="margin:0"><label>Last visit (optional)</label><input id="n-visit" type="date" max="${todayISO()}"></div>
        <div class="field" style="margin:0"><label>Next visit planned (optional)</label><input id="n-plan" type="date" min="${todayISO()}"></div>
        <div class="field" style="margin:0"><label>Priority</label><select id="n-tier"><option value="">None</option>${Object.entries(TIER_NAMES).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
      </div>
      <div class="err" id="n-err"></div>`,
    buttons: [{ label: 'Cancel', action: 'close' }, { label: 'Add client', primary: true, action: 'ok' }],
    async onOk(close, box) {
      const v = id => box.querySelector(id).value.trim();
      if (!v('#n-name')) { box.querySelector('#n-err').textContent = 'Enter a name.'; return; }
      if (v('#n-visit') && v('#n-visit') > todayISO()) { box.querySelector('#n-err').textContent = 'The last visit can\'t be in the future — use “Next visit planned”.'; return; }
      if (v('#n-plan') && v('#n-plan') < todayISO()) { box.querySelector('#n-err').textContent = 'The planned visit must be today or later.'; return; }
      const c = {
        id: uid(), name: v('#n-name'), address: v('#n-address'), postcode: v('#n-postcode'), city: v('#n-city'), country: v('#n-country'),
        notes: '', extra: {}, visits: [], groupId: null, createdAt: todayISO(), geo: { status: 'pending' }, tier: v('#n-tier'),
      };
      if (v('#n-visit')) recordVisit(c, { date: v('#n-visit'), status: 'done' });
      if (v('#n-plan')) recordVisit(c, { date: v('#n-plan'), status: 'planned', order: nextOrder(v('#n-plan')) });
      if (state.data.demo) { toast('Clear the demo data first (see the note in the sidebar).', { error: true }); return; }
      state.data.clients.push(c);
      close();
      const ok = await geocodeOne(c);
      if (ok && state.data.groups.length) assignToNearest([c], { quiet: true });
      save();
      selectClient(c.id, { pan: true });
      if (ok === true) toast(`${c.name} added${c.groupId ? ` to group ${groupById(c.groupId).number}` : ''}.`);
      else toast(`${c.name} added, but the address wasn't found. Place it on the map by hand from its card.`, { error: true });
    },
  });
}

// =====================================================================
// Group actions
// =====================================================================
// Log visits that happened, or plan visits, for several clients at once (a group, or clients picked on the map).
function visitDialog({ ids, mode = 'log', title = '' }) {
  const clients = ids.map(clientById).filter(Boolean).sort((a, b) => urgencyOf(b) - urgencyOf(a) || a.name.localeCompare(b.name));
  if (!clients.length) return;
  const t = todayISO();
  const st = { mode, date: mode === 'plan' ? nextWorkday(t) : t, type: 'visit', outcome: '', note: '', checked: null };
  const needsVisit = c => ['due', 'late', 'never'].includes(clientStatus(c));
  const defaults = () => {
    if (st.mode === 'plan') return new Set(clients.filter(c => needsVisit(c) && !nextPlannedVisit(c)).map(c => c.id));
    const planned = clients.filter(c => plannedOf(c).some(v => v.date === st.date));
    return new Set((planned.length ? planned : clients).map(c => c.id));
  };
  st.checked = defaults();
  const statusTxt = c => {
    const np = nextPlannedVisit(c), d = daysSince(lastVisit(c)), s = clientStatus(c);
    const plannedThatDay = plannedOf(c).some(v => v.date === st.date);
    return `${plannedThatDay ? '<span class="pill plan">Planned that day</span>' : np ? `<span class="pill plan">Planned ${esc(fmtShort(np))}</span>` : ''}<span class="pill ${s}">${d === null ? 'Never' : shortAgo(d)}</span>`;
  };
  showModal({
    title: `${st.mode === 'plan' ? 'Plan visits' : 'Log a visit'}${title ? ' — ' + esc(title) : ''}`,
    render: () => `
      <div class="seg wide-seg" style="margin-bottom:12px"><button data-vm="log" class="${st.mode === 'log' ? 'on' : ''}">Log visits that happened</button><button data-vm="plan" class="${st.mode === 'plan' ? 'on' : ''}">Plan visits</button></div>
      <div class="vd-grid">
        <div class="field"><label>Date</label><input type="date" id="g-date" value="${st.date}" ${st.mode === 'plan' ? `min="${t}"` : `max="${t}"`}></div>
        <div class="field"><label>Type</label><select id="g-type">${Object.entries(VISIT_TYPES).map(([k, l]) => `<option value="${k}"${st.type === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        ${st.mode === 'log' ? `<div class="field"><label>Outcome</label><select id="g-outcome">${Object.entries(OUTCOMES).map(([k, l]) => `<option value="${k}"${st.outcome === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>` : '<div></div>'}
      </div>
      <div class="field"><label>Note (optional)</label><input id="g-note" value="${esc(st.note)}"></div>
      <div class="pick-links">Tick: <button class="link" data-pick="all">all</button> · <button class="link" data-pick="none">none</button> · <button class="link" data-pick="due">due, overdue or never visited</button>${st.mode === 'log' ? ` · <button class="link" data-pick="planned">planned that day</button>` : ''}<span class="count">${st.checked.size} of ${clients.length} ticked</span></div>
      <div class="checklist">${clients.map(c => `<label><input type="checkbox" value="${c.id}"${st.checked.has(c.id) ? ' checked' : ''}> ${c.tier ? `<span class="tier t${c.tier}">${c.tier}</span>` : ''}${esc(c.name)}<small>${statusTxt(c)}</small></label>`).join('')}</div>
      <p class="note">${st.mode === 'plan' ? 'Clients that are due, overdue or never visited and have nothing planned yet are ticked.' : 'A planned visit on this date is confirmed instead of adding a second visit.'}</p>
      <div class="err" id="g-err"></div>`,
    buttons: [{ label: 'Cancel', action: 'close' }, { label: st.mode === 'plan' ? 'Plan visits' : 'Save visits', primary: true, action: 'ok' }],
    onClick(e, box, close, rerender) {
      const m = e.target.closest('[data-vm]');
      if (m && m.dataset.vm !== st.mode) {
        st.mode = m.dataset.vm;
        if (st.mode === 'plan' && st.date <= t) st.date = nextWorkday(t);
        if (st.mode === 'log' && st.date > t) st.date = t;
        st.checked = defaults();
        box.querySelector('.modal-head h2').textContent = `${st.mode === 'plan' ? 'Plan visits' : 'Log a visit'}${title ? ' — ' + title : ''}`;
        box.querySelector('.modal-foot .btn.primary').textContent = st.mode === 'plan' ? 'Plan visits' : 'Save visits';
        rerender();
      }
      const p = e.target.closest('[data-pick]')?.dataset.pick;
      if (p) {
        st.checked = new Set(clients.filter(c => p === 'all' || (p === 'due' && needsVisit(c)) || (p === 'planned' && plannedOf(c).some(v => v.date === st.date))).map(c => c.id));
        rerender();
      }
    },
    onInput(e) {
      const id = e.target.id;
      if (id === 'g-note') st.note = e.target.value;
    },
    onChange(e, rerender) {
      const tg = e.target;
      if (tg.type === 'checkbox') { if (tg.checked) st.checked.add(tg.value); else st.checked.delete(tg.value); tg.closest('.modal-body').querySelector('.pick-links .count').textContent = `${st.checked.size} of ${clients.length} ticked`; return; }
      if (tg.id === 'g-type') st.type = tg.value;
      if (tg.id === 'g-outcome') st.outcome = tg.value;
      if (tg.id === 'g-date' && tg.value) {
        st.date = tg.value;
        if (st.mode === 'log') st.checked = defaults();
        rerender();
      }
    },
    onOk(close, box) {
      const err = m => { box.querySelector('#g-err').textContent = m; };
      const ids2 = [...st.checked];
      if (!st.date) return err('Pick a date.');
      if (!ids2.length) return err('Tick at least one client.');
      if (st.mode === 'plan' && st.date < t) return err('Planned visits need today or a later date.');
      if (st.mode === 'log' && st.date > t) return err('A visit that happened can\'t be in the future — switch to “Plan visits”.');
      const note = box.querySelector('#g-note').value.trim();
      const wasEmpty = st.mode === 'plan' && !dayPlan(st.date).stops.length;
      let confirmed = 0;
      for (const id of ids2) {
        const c = clientById(id);
        if (st.mode === 'plan') recordVisit(c, { date: st.date, note, type: st.type, status: 'planned', order: nextOrder(st.date) });
        else if (recordVisit(c, { date: st.date, note, type: st.type, outcome: st.outcome, status: 'done' }).confirmedFrom) confirmed++;
      }
      if (st.mode === 'plan' && wasEmpty) optimizeDay(st.date);
      close(); save(); renderAll(); renderDetail();
      if (st.mode === 'plan') toast(`${ids2.length} visit${ids2.length > 1 ? 's' : ''} planned on ${fmtDay(st.date)}.`, { action: { label: 'Show day', fn: () => showDay(st.date) } });
      else toast(`Visit on ${fmtDate(st.date)} saved for ${ids2.length} client${ids2.length > 1 ? 's' : ''}${confirmed ? ` (${confirmed} planned visit${confirmed > 1 ? 's' : ''} confirmed)` : ''}.`);
    },
  });
}

// =====================================================================
// Plan a day: picks the most urgent clients in one area, in a good order, open when you get there
// =====================================================================
function planDayDialog({ date, groupId, only } = {}) {
  const t = todayISO();
  if (!state.data.clients.some(hasLoc)) { toast('Put clients on the map first.', { error: true }); return; }
  const firstFree = () => { let d = nextWorkday(t); for (let i = 0; i < 30 && dayPlan(d).stops.length; i++) d = nextWorkday(d); return d; };
  const st = {
    date: date && date >= t ? date : firstFree(),
    area: only && only.length ? 'selection' : groupId ? 'g:' + groupId : 'auto',
    maxStops: S().maxStops, radius: S().planRadiusKm,
    inc: { late: true, due: true, never: true, ok: false },
    skipPlanned: true, excluded: new Set(), result: null,
  };
  const groups = state.data.groups.slice().sort((a, b) => a.number - b.number);
  const compute = () => {
    const opts = dayOpts(st.date);
    const existing = dayPlan(st.date).stops.filter(s => vStatus(s.v) === 'planned' && hasLoc(s.c));
    const fixedIds = new Set(existing.map(s => s.c.id));
    let pool = state.data.clients.filter(c => hasLoc(c) && !fixedIds.has(c.id) && !st.excluded.has(c.id));
    if (st.area === 'selection') pool = pool.filter(c => state.selection.has(c.id) || (only || []).includes(c.id));
    else pool = pool.filter(c => st.inc[clientStatus(c)]);
    if (st.skipPlanned && st.area !== 'selection') pool = pool.filter(c => !nextPlannedVisit(c));
    pool = pool.filter(c => c.gbp?.businessStatus !== 'CLOSED_PERMANENTLY');
    let anchor = null;
    if (st.area.startsWith('g:')) {
      const info = state.derived.byGroup.get(st.area.slice(2));
      if (info && info.lat !== null) anchor = { lat: info.lat, lng: info.lng };
    }
    const cand = pool.map(c => ({ id: c.id, ...stopPoint(c), urgency: urgencyOf(c) }));
    const fixed = existing.map(s => ({ id: s.c.id, ...stopPoint(s.c), urgency: 0, fixed: true }));
    const radius = st.area === 'selection' ? 1e4 : st.radius;
    st.result = Planning.planDay(cand, { ...opts, home: homeOf(), anchor, radiusKm: radius, maxStops: Math.max(st.maxStops, fixed.length), fixed });
    st.fixedIds = fixedIds;
  };
  compute();
  const rowHtml = (id, i) => {
    const c = clientById(id), leg = st.result.sim.legs[i];
    const fixed = st.fixedIds.has(id);
    const d = daysSince(lastVisit(c));
    return `<div class="pd-row${fixed ? ' fixed' : ''}${isProblem(c, leg) ? ' problem' : ''}">
      <span class="num">${i + 1}</span>
      <span class="name">${c.tier ? `<span class="tier t${c.tier}">${c.tier}</span>` : ''}${esc(c.name)}<small>${esc([titleCase(townOf(c)), `arrive ~${Planning.fmtMin(leg.arrive)}${leg.wait >= 1 ? `, wait ${Math.round(leg.wait)} min` : ''}`].filter(Boolean).join(' · '))}</small></span>
      ${hoursBadge(c, leg.check, dayOpts(st.date).weekday)}
      ${fixed ? '<span class="pill plan">Already planned</span>' : `<span class="pill ${clientStatus(c)}">${d === null ? 'Never' : shortAgo(d)}</span><button class="mini" data-pd-x="${id}" title="Leave this client out (another one is picked)">×</button>`}
    </div>`;
  };
  showModal({
    wide: true,
    title: 'Plan a day',
    desc: 'Picks the clients that most need a visit in one area, puts them in a good driving order and checks they are open when you arrive. Change anything and the plan updates.',
    render: () => {
      const r = st.result, sim = r.sim, opts = dayOpts(st.date);
      const newIds = r.ids.filter(id => !st.fixedIds.has(id));
      const closedN = r.closedThatDay.length;
      return `
      <div class="pd-grid">
        <div class="field"><label>Day</label><input type="date" id="pd-date" value="${st.date}" min="${t}"></div>
        <div class="field"><label>Where</label><select id="pd-area">
          <option value="auto"${st.area === 'auto' ? ' selected' : ''}>Where clients most need a visit (automatic)</option>
          ${state.selection.size || (only && only.length) ? `<option value="selection"${st.area === 'selection' ? ' selected' : ''}>Only the clients selected on the map</option>` : ''}
          ${groups.map(g => `<option value="g:${g.id}"${st.area === 'g:' + g.id ? ' selected' : ''}>Around group ${g.number}. ${esc(g.name)}</option>`).join('')}
        </select></div>
        <div class="field"><label>Visits</label><input type="number" id="pd-max" min="1" max="25" value="${st.maxStops}"></div>
        <div class="field"><label>Within (km)</label><input type="number" id="pd-radius" min="2" max="300" value="${st.radius}"${st.area === 'selection' ? ' disabled' : ''}></div>
      </div>
      ${st.area === 'selection' ? '' : `<div class="pd-inc">Include:
        <label class="check"><input type="checkbox" data-inc="late"${st.inc.late ? ' checked' : ''}> overdue</label>
        <label class="check"><input type="checkbox" data-inc="due"${st.inc.due ? ' checked' : ''}> due</label>
        <label class="check"><input type="checkbox" data-inc="never"${st.inc.never ? ' checked' : ''}> never visited</label>
        <label class="check"><input type="checkbox" data-inc="ok"${st.inc.ok ? ' checked' : ''}> up to date</label>
        <label class="check"><input type="checkbox" id="pd-skip"${st.skipPlanned ? ' checked' : ''}> skip clients already planned</label></div>`}
      <div class="pd-sum">${r.ids.length ? `<b>${esc(fmtDay(st.date))}</b> · ${r.ids.length} visit${r.ids.length > 1 ? 's' : ''} · ${Math.round(sim.km)} km · ~${Planning.fmtDuration(sim.drive)} driving · ${homeOf() ? 'leave' : 'start'} ${esc(S().dayStart)}, ${homeOf() ? 'back' : 'done'} ~${Planning.fmtMin(sim.endMin)}${sim.endMin > opts.endMin ? ` <b class="bad">(after ${esc(S().dayEnd)})</b>` : ''}` : 'No client matches these choices. Include more kinds of clients, widen the distance or pick another area.'}</div>
      ${r.ids.length ? `<div class="pd-list">${r.ids.map(rowHtml).join('')}</div>` : ''}
      <p class="note">${[closedN ? `${closedN} client${closedN > 1 ? 's' : ''} closed on ${WEEKDAYS[opts.weekday]}s left out.` : '', st.excluded.size ? `${st.excluded.size} left out by you (<button class="link" data-pd="reset">put back</button>).` : '', homeOf() ? '' : 'Tip: add your home address in Settings so days start and end at home.', `Times assume ${S().visitMin} min per visit and ${S().speedKmh} km/h on average (Settings).`].filter(Boolean).join(' ')}</p>
      <input type="hidden" id="pd-new" value="${newIds.length}">`;
    },
    buttons: [{ label: 'Cancel', action: 'close' }, { label: 'Plan these visits', primary: true, action: 'ok' }],
    onChange(e, rerender) {
      const tg = e.target;
      if (tg.id === 'pd-date' && tg.value) st.date = tg.value < t ? t : tg.value;
      if (tg.id === 'pd-area') st.area = tg.value;
      if (tg.id === 'pd-max') st.maxStops = Math.max(1, Math.min(25, parseInt(tg.value, 10) || st.maxStops));
      if (tg.id === 'pd-radius') st.radius = Math.max(2, Math.min(300, parseInt(tg.value, 10) || st.radius));
      if (tg.dataset.inc) st.inc[tg.dataset.inc] = tg.checked;
      if (tg.id === 'pd-skip') st.skipPlanned = tg.checked;
      compute(); rerender();
    },
    onClick(e, box, close, rerender) {
      const x = e.target.closest('[data-pd-x]');
      if (x) { st.excluded.add(x.dataset.pdX); compute(); rerender(); }
      if (e.target.closest('[data-pd="reset"]')) { st.excluded.clear(); compute(); rerender(); }
    },
    onOk(close) {
      const r = st.result;
      const newIds = r.ids.filter(id => !st.fixedIds.has(id));
      if (!newIds.length) { close(); return; }
      // Order of the whole day = the order found by the planner.
      const byId = new Map(dayPlan(st.date).stops.map(s => [s.c.id, s.v]));
      r.ids.forEach((id, i) => {
        const v = byId.get(id) || recordVisit(clientById(id), { date: st.date, status: 'planned' });
        v.order = i + 1;
      });
      close();
      state.selection.clear();
      save();
      showDay(st.date);
      toast(`${newIds.length} visit${newIds.length > 1 ? 's' : ''} planned on ${fmtDay(st.date)}.`);
    },
  });
}

function renameGroup(groupId) {
  const g = groupById(groupId);
  const apply = (name, custom) => {
    if (custom) { g.name = name; g.customName = true; } else delete g.customName;
    save(); renderAll();
  };
  showModal({
    title: 'Rename group',
    desc: g.customName ? 'This group has a name you chose.' : 'This name is set automatically from the main towns in the group and updates when its clients change.',
    render: () => `<div class="field"><label>Group name</label><input id="p-val" value="${esc(g.name)}" autofocus></div>`,
    buttons: [
      ...(g.customName ? [{ label: 'Use automatic name', fn: close => { close(); apply('', false); } }] : []),
      { label: 'Cancel', action: 'close' },
      { label: 'Save', primary: true, action: 'ok' },
    ],
    onOk(close, box) {
      const v = box.querySelector('#p-val').value.trim();
      close();
      if (!v) apply('', false); else if (v !== g.name) apply(v, true);
    },
  });
}

// Route through all the clients of a group, in the best order found (from home and back when set).
function openRoute(groupId) {
  const info = state.derived.byGroup.get(groupId);
  const pts = info.members.filter(hasLoc);
  if (!pts.length) return;
  const home = homeOf();
  const opts = { ...dayOpts(todayISO()), weekday: undefined };
  const order = Planning.orderStops(home, pts.map(stopPoint), opts);
  const ordered = order.map(i => pts[i]);
  const sim = Planning.simulate(home, ordered.map(stopPoint), opts);
  openRouteLinks(home, ordered, info.group.name);
  toast(`${ordered.length} stop${ordered.length > 1 ? 's' : ''} · about ${Math.round(sim.km)} km and ${Planning.fmtDuration(sim.drive)} of driving.`);
}

// =====================================================================
// Export, settings, backups
// =====================================================================
// Export for Google Earth / Google My Maps: one folder (layer) per group, pins in the group's colour.
async function exportKmz() {
  const located = state.data.clients.filter(hasLoc);
  if (!located.length) { toast('No client is on the map yet.', { error: true }); return; }
  const x = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const kmlColor = hex => { const h = hex.replace('#', ''); return 'ff' + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2); };
  const statusText = { ok: 'Up to date', due: 'Due', late: 'Overdue', never: 'Never visited' };
  const styles = [], folders = [];
  const placemark = (c, g, styleId) => {
    const lv = lastVisit(c), d = daysSince(lv);
    const addr = [c.address, [c.postcode, c.city].filter(Boolean).join(' '), c.country].filter(Boolean).join(', ');
    // Shown in the info bubble:
    const np = nextPlannedVisit(c);
    const shown = [['Group', g ? `${g.number}. ${g.name}` : ''], ['Address', addr], ['Last visit', lv ? `${fmtDate(lv)} (${fmtAgo(d)})` : 'Never visited'],
      ['Status', statusText[clientStatus(c)]], ['Priority', c.tier || ''], ['Next planned visit', np ? fmtDate(np) : ''],
      ['Visits recorded', (c.visits || []).filter(countsAsVisit).length], ['Opening hours', Hours.weekText(hoursOf(c))],
      ['Phone', c.gbp?.phone || ''], ['Notes', c.notes || ''], ...Object.entries(c.extra || {})];
    const desc = shown.filter(([, v]) => String(v).trim() !== '').map(([k, v]) => `<b>${esc(k)}:</b> ${esc(v).replace(/\n/g, '<br>')}`).join('<br>');
    // Data columns (kept separate so the file can be imported back into the app):
    const fields = [['Street address', c.address], ['Postal code', c.postcode], ['City', c.city], ['Country', c.country],
      ['Last visit', lv || ''], ['Priority', c.tier || ''], ['Group', g ? `${g.number}. ${g.name}` : ''], ['Notes', c.notes || ''], ['Google Maps link', c.gbp?.mapsUrl || ''], ...Object.entries(c.extra || {})]
      .filter(([, v]) => String(v ?? '').trim() !== '');
    return `      <Placemark>
        <name>${x(c.name)}</name>
        <description><![CDATA[${desc.replace(/]]>/g, ']]&gt;')}]]></description>
        <styleUrl>#${styleId}</styleUrl>
        <ExtendedData>
${fields.map(([k, v]) => `          <Data name="${x(k)}"><value>${x(v)}</value></Data>`).join('\n')}
        </ExtendedData>
        <Point><coordinates>${c.lng.toFixed(7)},${c.lat.toFixed(7)},0</coordinates></Point>
      </Placemark>`;
  };
  const addStyle = (id, color) => styles.push(`    <Style id="${id}">
      <IconStyle><color>${kmlColor(color)}</color><scale>1.0</scale><Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle>
      <LabelStyle><scale>0.8</scale></LabelStyle>
    </Style>`);
  for (const info of [...state.derived.byGroup.values()].sort((a, b) => a.group.number - b.group.number)) {
    const members = info.members.filter(hasLoc);
    if (!members.length) continue;
    const id = 'g' + info.group.number;
    addStyle(id, info.group.color);
    folders.push(`    <Folder>
      <name>${x(`${info.group.number}. ${info.group.name} (${members.length})`)}</name>
${members.map(c => placemark(c, info.group, id)).join('\n')}
    </Folder>`);
  }
  const loose = located.filter(c => !c.groupId);
  if (loose.length) {
    addStyle('nogroup', '#6b6d66');
    folders.push(`    <Folder>
      <name>Not in a group (${loose.length})</name>
${loose.map(c => placemark(c, null, 'nogroup')).join('\n')}
    </Folder>`);
  }
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Clients ${x(todayISO())}</name>
    <ExtendedData><Data name="generator"><value>Client Clusters</value></Data></ExtendedData>
${styles.join('\n')}
${folders.join('\n')}
  </Document>
</kml>
`;
  try {
    const p = await window.api.exportKmz({ kml, defaultName: `clients-${todayISO()}.kmz` });
    if (p) {
      const missing = state.data.clients.length - located.length;
      toast(`Exported ${located.length} clients for Google Earth / My Maps.${missing ? ` ${missing} not on the map were left out.` : ''}`);
    }
  } catch (e) { toast('Export failed: ' + e.message, { error: true }); }
}

async function exportExcel() {
  if (!state.data.clients.length) { toast('Nothing to export yet.', { error: true }); return; }
  const extraKeys = [...new Set(state.data.clients.flatMap(c => Object.keys(c.extra || {})))];
  const statusText = { ok: 'Up to date', due: 'Due', late: 'Overdue', never: 'Never visited' };
  const clients = state.data.clients.slice().sort((a, b) => ((groupById(a.groupId)?.number ?? 1e9) - (groupById(b.groupId)?.number ?? 1e9)) || a.name.localeCompare(b.name));
  const rows = [['Group #', 'Group', 'Client', 'Address', 'Postal code', 'City', 'Country', 'Last visit', 'Days since last visit', 'Status', 'Priority', 'Next planned visit', 'Visits done', 'Notes',
    'Opening hours', 'Google page', 'Phone (Google)', 'Latitude', 'Longitude', ...extraKeys]];
  for (const c of clients) {
    const g = groupById(c.groupId), lv = lastVisit(c);
    rows.push([g ? g.number : '', g ? g.name : '', c.name, c.address, c.postcode, c.city, c.country, lv || '', lv ? daysSince(lv) : '', statusText[clientStatus(c)],
      c.tier || '', nextPlannedVisit(c) || '', (c.visits || []).filter(countsAsVisit).length, c.notes || '', Hours.weekText(hoursOf(c)), c.gbp?.mapsUrl || '', c.gbp?.phone || '',
      hasLoc(c) ? +c.lat.toFixed(6) : '', hasLoc(c) ? +c.lng.toFixed(6) : '', ...extraKeys.map(k => c.extra?.[k] ?? '')]);
  }
  // History: what happened (done, didn't happen). Planned visits have their own sheet.
  const t = todayISO();
  const statusName = v => ({ done: 'Done', cancelled: "Didn't happen", planned: v.date < t ? 'Not confirmed' : 'Planned' }[vStatus(v)]);
  const visits = [['Date', 'Client', 'Group #', 'Group', 'Status', 'Type', 'Outcome', 'Note']];
  for (const c of clients) for (const v of (c.visits || []).filter(x => vStatus(x) !== 'planned' || x.date < t).sort((a, b) => b.date.localeCompare(a.date))) {
    const g = groupById(c.groupId);
    visits.push([v.date, c.name, g ? g.number : '', g ? g.name : '', statusName(v), VISIT_TYPES[v.type] || 'Visit', v.outcome ? OUTCOMES[v.outcome] : '', v.note || '']);
  }
  const planned = [['Date', 'Stop #', 'Client', 'Address', 'Postal code', 'City', 'Group', 'Estimated arrival', 'Opening hours that day', 'Note']];
  const days = [...new Set(state.data.clients.flatMap(c => plannedOf(c).filter(v => v.date >= t).map(v => v.date)))].sort();
  for (const day of days) {
    const p = dayPlan(day);
    p.stops.filter(s => vStatus(s.v) === 'planned').forEach(s => {
      const g = groupById(s.c.groupId);
      const line = hoursOf(s.c) ? Hours.weekLines(hoursOf(s.c)).find(l => l.day === p.opts.weekday)?.text || '' : '';
      planned.push([day, p.stops.indexOf(s) + 1, s.c.name, s.c.address, s.c.postcode, s.c.city, g ? `${g.number}. ${g.name}` : '', s.leg ? Planning.fmtMin(s.leg.arrive) : '', line, s.v.note || '']);
    });
  }
  const home = homeOf();
  const groups = [['Group #', 'Group', 'Clients', 'Oldest last visit (days)', 'Never visited', ...(home ? ['Distance from home (km)'] : []), 'Members']];
  for (const info of [...state.derived.byGroup.values()].sort((a, b) => a.group.number - b.group.number)) {
    groups.push([info.group.number, info.group.name, info.members.length, info.oldestDays ?? '', info.neverCount,
      ...(home ? [info.homeKm !== null ? Math.round(info.homeKm * 10) / 10 : ''] : []), info.members.map(c => c.name).join(', ')]);
  }
  try {
    const p = await window.api.exportXlsx({
      defaultName: `clients-${todayISO()}.xlsx`,
      sheets: [
        { name: 'Clients', rows, widths: [8, 18, 28, 30, 11, 18, 10, 12, 10, 14, 8, 14, 9, 30, 34, 30, 15, 11, 11] },
        { name: 'Groups', rows: groups, widths: [8, 20, 8, 12, 10, ...(home ? [12] : []), 80] },
        { name: 'Visits', rows: visits, widths: [12, 28, 8, 18, 14, 11, 18, 40] },
        { name: 'Planned', rows: planned, widths: [12, 7, 28, 30, 11, 18, 22, 10, 24, 30] },
      ],
    });
    if (p) toast('Exported to Excel.');
  } catch (e) { toast('Export failed: ' + e.message, { error: true }); }
}

function settingsDialog({ focus } = {}) {
  const s = { ...S() };
  let home = homeOf() ? { ...S().home } : null; // draft, saved with “Save”
  const keyNow = state.googleKey;
  const homeMsg = () => (home ? `Found: ${esc(home.label || home.address)}` : 'Not set — groups are numbered from north to south.');
  showModal({
    title: 'Settings',
    render: () => `
      <div class="field"><label for="s-home">Home address</label>
        <div class="home-row"><input id="s-home" value="${esc(home?.address || '')}" placeholder="e.g. 12 rue de la Paix, 69003 Lyon"><button class="btn" data-s="find-home">Find</button></div>
        <p class="note" id="s-home-msg">${homeMsg()}</p>
        <p class="note">With a home address, group 1 is the group nearest to home, group 2 the next one, and so on (as the crow flies). Routes in Google Maps start and end at home.</p>
      </div>
      <div class="field"><label>Grouping</label>
        <div class="inline"><span>Up to</span><input type="number" id="s-max" min="2" max="30" value="${s.maxSize}"><span>clients per group,</span></div>
        <div class="inline" style="margin-top:6px"><span>or up to</span><input type="number" id="s-flex" min="2" max="40" value="${s.flexSize}"><span>when they're all in the same town.</span></div>
        <div class="inline" style="margin-top:6px"><span>Clients in a group are never more than</span><input type="number" id="s-span" min="1" max="1000" value="${s.maxSpanKm}"><span>km apart.</span></div>
        <p class="note">Group sizes adapt: a town is kept in one group when possible, and a client with nobody within that distance gets a group of its own. A town with more clients than the second number is split by neighbourhood.</p>
      </div>
      <div class="field"><label>Visit reminders</label>
        <div class="inline"><span>A visit is <b>due</b> after</span><input type="number" id="s-due" min="1" value="${s.dueDays}"><span>days, and <b>overdue</b> after</span><input type="number" id="s-over" min="2" value="${s.overdueDays}"><span>days.</span></div>
        <table class="tier-table">
          <tr><th></th><th>Due after (days)</th><th>Overdue after (days)</th></tr>
          ${Object.keys(DEFAULT_TIERS).map(k => `<tr><td><span class="tier t${k}">${k}</span> ${esc(TIER_NAMES[k].split(' — ')[1])}</td><td><input type="number" id="s-t${k}-due" min="1" value="${s.tiers[k].due}"></td><td><input type="number" id="s-t${k}-over" min="2" value="${s.tiers[k].over}"></td></tr>`).join('')}
        </table>
        <p class="note">The first line applies to clients without a priority. Set a client's priority on its card, in the import file (a “Priority” column with A, B or C), or for several clients at once by selecting them on the map.</p>
      </div>
      <div class="field"><label>Day planning</label>
        <div class="plan-set">
          <label>Day starts at<input type="time" id="s-dstart" value="${esc(s.dayStart)}"></label>
          <label>Day ends at<input type="time" id="s-dend" value="${esc(s.dayEnd)}"></label>
          <label>Minutes per visit<input type="number" id="s-vmin" min="5" max="240" value="${s.visitMin}"></label>
          <label>Visits a day (at most)<input type="number" id="s-maxstops" min="1" max="25" value="${s.maxStops}"></label>
          <label>Look within (km)<input type="number" id="s-pradius" min="2" max="300" value="${s.planRadiusKm}"></label>
          <label>Average speed (km/h)<input type="number" id="s-speed" min="10" max="130" value="${s.speedKmh}"></label>
        </div>
        <p class="note">Used by “Plan a day” and to estimate arrival times, so the app can warn when a client is closed when you get there.</p>
      </div>
      <div class="field"><label for="s-gkey">Opening hours from Google</label>
        <div class="home-row"><input id="s-gkey" type="password" autocomplete="off" spellcheck="false" placeholder="${keyNow.hasKey ? 'Key saved (' + esc(keyNow.masked) + ') — paste a new one to replace it' : 'Paste your Google Maps Platform API key'}">${keyNow.hasKey ? '<button class="btn" data-s="remove-key">Remove key</button>' : ''}</div>
        <div class="inline" style="margin-top:6px"><span>Update hours from Google every</span><input type="number" id="s-hrefresh" min="0" max="365" value="${s.hoursRefreshDays}"><span>days (0 = only when I ask).</span></div>
        <p class="note">The key needs “Places API (New)” enabled in a Google Cloud project with billing. Google gives a free allowance each month (currently about 1,000 opening-hours reads); finding a client's page and reading its hours costs one read, plus one search. The key is stored encrypted on this computer and is not included in backups.</p>
      </div>
      <div class="err" id="s-err"></div>`,
    buttons: [{ label: 'Cancel', action: 'close' }, { label: 'Save', primary: true, action: 'ok' }],
    async onClick(e, box) {
      const b = e.target.closest('[data-s]');
      if (!b) return;
      if (b.dataset.s === 'find-home') {
        const q = box.querySelector('#s-home').value.trim();
        if (!q) { home = null; box.querySelector('#s-home-msg').innerHTML = homeMsg(); return; }
        b.disabled = true; b.textContent = 'Finding…';
        const r = await window.api.geocode({ query: q, postcode: (/\b\d{5}\b/.exec(q) || [])[0] || '', country: '' });
        b.disabled = false; b.textContent = 'Find';
        if (r && Number.isFinite(r.lat)) { home = { address: q, label: r.label, lat: r.lat, lng: r.lng }; box.querySelector('#s-home-msg').innerHTML = homeMsg(); }
        else box.querySelector('#s-home-msg').innerHTML = '<span class="bad">Address not found. Check it, add the postal code and town, then click Find.</span>';
      }
      if (b.dataset.s === 'remove-key') {
        await window.api.googleSetKey('');
        state.googleKey = { hasKey: false, masked: '' };
        b.remove();
        box.querySelector('#s-gkey').placeholder = 'Paste your Google Maps Platform API key';
        toast('Google API key removed. Opening hours already found are kept.');
        renderAll(); renderDetail();
      }
    },
    async onOk(close, box) {
      const v = id => parseInt(box.querySelector(id).value, 10);
      const maxSize = v('#s-max'), flexSize = v('#s-flex'), maxSpanKm = v('#s-span'), due = v('#s-due'), over = v('#s-over'), hRefresh = v('#s-hrefresh');
      const err = m => { box.querySelector('#s-err').textContent = m; };
      if (!(maxSize >= 2 && maxSize <= 30)) return err('Group size must be between 2 and 30.');
      if (!(flexSize >= maxSize && flexSize <= 40)) return err(`The same-town size must be at least ${maxSize}.`);
      if (!(maxSpanKm >= 1 && maxSpanKm <= 1000)) return err('The distance must be between 1 and 1000 km.');
      if (!(due >= 1 && over > due)) return err('“Overdue” must be more days than “due”.');
      if (!(hRefresh >= 0 && hRefresh <= 365)) return err('Hours update: between 0 and 365 days.');
      const tiers = {};
      for (const k of Object.keys(DEFAULT_TIERS)) {
        const td = v(`#s-t${k}-due`), to = v(`#s-t${k}-over`);
        if (!(td >= 1 && to > td)) return err(`Priority ${k}: “overdue” must be more days than “due”.`);
        tiers[k] = { due: td, over: to };
      }
      const dayStart = box.querySelector('#s-dstart').value, dayEnd = box.querySelector('#s-dend').value;
      const ds = Planning.parseHHMM(dayStart), de = Planning.parseHHMM(dayEnd);
      if (ds === null || de === null || de <= ds) return err('The working day must end after it starts.');
      const visitMin = v('#s-vmin'), maxStops = v('#s-maxstops'), planRadiusKm = v('#s-pradius'), speedKmh = v('#s-speed');
      if (!(visitMin >= 5 && visitMin <= 240)) return err('Time per visit: between 5 and 240 minutes.');
      if (!(maxStops >= 1 && maxStops <= 25)) return err('Visits a day: between 1 and 25.');
      if (!(planRadiusKm >= 2 && planRadiusKm <= 300)) return err('Planning distance: between 2 and 300 km.');
      if (!(speedKmh >= 10 && speedKmh <= 130)) return err('Average speed: between 10 and 130 km/h.');
      const planningSettings = { tiers, dayStart, dayEnd, visitMin, maxStops, planRadiusKm, speedKmh };
      const okBtn = box.querySelector('.modal-foot .btn.primary');
      const busy = on => { okBtn.disabled = on; okBtn.textContent = on ? 'Checking…' : 'Save'; };
      // Home address typed but not looked up yet: look it up now.
      const homeText = box.querySelector('#s-home').value.trim();
      if (!homeText) home = null;
      else if (!home || home.address !== homeText) {
        busy(true);
        const r = await window.api.geocode({ query: homeText, postcode: (/\b\d{5}\b/.exec(homeText) || [])[0] || '', country: '' }).catch(() => null);
        busy(false);
        if (!(r && Number.isFinite(r.lat))) return err('The home address was not found. Check it, or leave it empty.');
        home = { address: homeText, label: r.label, lat: r.lat, lng: r.lng };
      }
      // New Google key: check it with Google before saving.
      const key = box.querySelector('#s-gkey').value.trim();
      let keyAdded = false;
      if (key) {
        busy(true);
        const r = await window.api.googleSetKey(key).catch(e => ({ ok: false, error: e.message }));
        busy(false);
        if (!r.ok) return err(r.error);
        keyAdded = !state.googleKey.hasKey;
        state.googleKey = { hasKey: true, masked: r.masked };
      }
      const groupingChanged = maxSize !== S().maxSize || flexSize !== S().flexSize || maxSpanKm !== S().maxSpanKm;
      const old = homeOf();
      const homeChanged = (old?.lat ?? null) !== (home?.lat ?? null) || (old?.lng ?? null) !== (home?.lng ?? null);
      Object.assign(S(), { maxSize, flexSize, maxSpanKm, dueDays: due, overdueDays: over, hoursRefreshDays: hRefresh, home, ...planningSettings });
      delete S().groupsMode; delete S().groupsCount;
      close(); save(); renderAll(); renderDetail();
      if (homeChanged && home && state.data.groups.length) {
        const first = [...state.derived.byGroup.values()].find(i => i.group.number === 1);
        toast(`Groups are now numbered from home${first ? `: group 1 is ${first.group.name}, ${fmtKm(first.homeKm)} away` : ''}.`);
      } else if (homeChanged && !home) toast('Home address removed. Group numbers stay as they are until the next Regroup.');
      if (groupingChanged && state.data.groups.length && (await confirmDialog('Regroup now?', 'The grouping settings changed. Regroup all clients with the new settings? Visit history is kept.', 'Regroup'))) await regroup({ confirm: false });
      if (keyAdded) {
        const todo = state.data.clients.filter(c => notLookedUp(c) && (hasLoc(c) || c.gbp?.mapsUrl));
        if (todo.length && !state.data.demo && (await confirmDialog('Look up opening hours now?', `The key works. Find the Google business page and opening hours of your ${todo.length} client${todo.length > 1 ? 's' : ''} now? Clients that can't be matched for sure are listed for you to check.`, 'Look up now'))) lookupGoogle(todo);
      } else if (key) toast('Google API key updated.');
    },
  });
  if (focus) setTimeout(() => box$(focus)?.focus(), 60);
}
const box$ = sel => $('#modal-box').querySelector(sel);

async function clearAll(demo) {
  if (!demo && !(await confirmDialog('Delete all clients?', `All ${state.data.clients.length} clients, their groups and their visit history will be removed. A daily backup is kept in the data folder.`, 'Delete everything', true))) return;
  state.data.clients = []; state.data.groups = []; state.data.demo = false;
  state.selectedClientId = null; state.selectedGroupId = null; state.clientFilter = null;
  save(); renderAll(); renderDetail();
  map.setView([46.6, 2.4], 6);
  if (demo) openImport();
}

$('#btn-menu').addEventListener('click', e => { e.stopPropagation(); $('#export-menu').hidden = true; $('#menu').hidden = !$('#menu').hidden; });
document.addEventListener('click', () => { $('#menu').hidden = true; });
$('#menu').addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  $('#menu').hidden = true;
  if (act === 'settings') settingsDialog();
  if (act === 'hours') hoursOverview();
  if (act === 'folder') window.api.openDataFolder();
  if (act === 'clear') clearAll(false);
  if (act === 'backup') backupDialog();
  if (act === 'restore') restoreBackup();
});

// =====================================================================
// Backups: move everything to another computer (or keep a copy)
// =====================================================================
function backupDialog() {
  const hasKey = state.googleKey.hasKey;
  const visits = state.data.clients.reduce((n, c) => n + (c.visits || []).length, 0);
  const pros = state.data.prospecting;
  showModal({
    title: 'Save a backup',
    desc: 'One file with everything: clients, visits, groups, opening hours, settings and home address. Copy it to the other computer (USB key, OneDrive, e-mail…) and open it there with <b>… → Restore a backup…</b>',
    render: () => `
      <p style="margin:0 0 10px"><b>${state.data.clients.length}</b> clients · <b>${visits}</b> visits · <b>${state.data.groups.length}</b> groups${S().lastBackupAt ? ` · last backup ${fmtDate(S().lastBackupAt)}` : ''}</p>
      ${pros ? `<label class="check" style="margin-bottom:8px"><input type="checkbox" id="b-pros" checked> Include my prospecting map (${pros.prospects.length} prospect${pros.prospects.length === 1 ? '' : 's'}${pros.areas.length ? `, ${pros.areas.length} area${pros.areas.length === 1 ? '' : 's'}` : ''})</label>` : ''}
      ${hasKey ? `
        <label class="check"><input type="checkbox" id="b-key"> Include my Google API key, protected by a password</label>
        <div id="b-pass" class="field-row field" style="margin-top:8px;grid-template-columns:1fr 1fr" hidden>
          <input type="password" id="b-p1" placeholder="Password" autocomplete="new-password">
          <input type="password" id="b-p2" placeholder="Same password again" autocomplete="new-password">
        </div>
        <p class="note">Without it, paste the key again in Settings on the other computer. The key is never written to the file without a password.</p>` : ''}
      <div class="err" id="b-err"></div>`,
    buttons: [{ label: 'Cancel', action: 'close' }, { label: 'Save backup…', primary: true, action: 'ok' }],
    onChange(e, rerender, box) {
      if (e.target.id === 'b-key') { box.querySelector('#b-pass').hidden = !e.target.checked; if (e.target.checked) box.querySelector('#b-p1').focus(); }
    },
    async onOk(close, box) {
      const err = m => { box.querySelector('#b-err').textContent = m; };
      const withKey = !!box.querySelector('#b-key')?.checked;
      const pw = withKey ? box.querySelector('#b-p1').value : '';
      if (withKey) {
        if (pw.length < 6) return err('Choose a password of at least 6 characters for the key.');
        if (pw !== box.querySelector('#b-p2').value) return err('The two passwords are different.');
      }
      flushSave();
      const data = box.querySelector('#b-pros')?.checked === false ? { ...state.data, prospecting: undefined } : state.data;
      let r;
      try { r = await window.api.saveBackup({ data, includeKey: withKey, password: pw }); } catch (e) { return err('The backup could not be saved: ' + e.message); }
      if (!r) return; // save dialog cancelled
      close();
      S().lastBackupAt = todayISO(); save(); renderAll();
      toast(`Backup saved: ${r.path.split(/[\\/]/).pop()} (${r.size < 1048576 ? Math.max(1, Math.round(r.size / 1024)) + ' KB' : (r.size / 1048576).toFixed(1) + ' MB'}).`);
    },
  });
}

// Put a backup's clients and visits into the current list without removing anything.
function mergeBackup(incoming) {
  const local = state.data;
  const keyOf = c => norm(c.name) + '|' + norm(c.address) + '|' + norm(c.postcode) + '|' + norm(c.city);
  const byId = new Map(local.clients.map(c => [c.id, c]));
  const byKey = new Map(local.clients.map(c => [keyOf(c), c]));
  const groupIds = new Set(local.groups.map(g => g.id));
  const fresh = g => (g?.hours?.updatedAt || g?.checkedAt || '') + (g?.matchedBy === 'user' ? '~' : '');
  const res = { added: 0, updated: 0, visits: 0, newClients: [] };
  for (const raw of incoming.clients || []) {
    const inc = { visits: [], extra: {}, notes: '', address: '', postcode: '', city: '', country: '', ...raw };
    const ex = byId.get(inc.id) || byKey.get(keyOf(inc));
    if (!ex) {
      normalizeVisits(inc);
      if (byId.has(inc.id)) inc.id = uid();
      if (!groupIds.has(inc.groupId)) inc.groupId = null;
      local.clients.push(inc); byId.set(inc.id, inc); byKey.set(keyOf(inc), inc);
      res.added++; res.visits += inc.visits.length; res.newClients.push(inc);
      continue;
    }
    let changed = false;
    normalizeVisits(ex); normalizeVisits(inc);
    const visitKey = v => JSON.stringify([v.date, v.note || '', v.type || 'visit', vStatus(v), v.outcome || '']);
    const same = new Set(ex.visits.map(visitKey));
    for (const v of inc.visits) {
      const mine = ex.visits.find(x => x.id === v.id);
      // Same visit on both computers: a planned visit confirmed (or cancelled) on the other one is taken over.
      if (mine) { if (vStatus(mine) === 'planned' && vStatus(v) !== 'planned') { Object.assign(mine, v); changed = true; } continue; }
      if (same.has(visitKey(v))) continue;
      ex.visits.push(v); same.add(visitKey(v)); res.visits++; changed = true;
    }
    if (!ex.tier && inc.tier) { ex.tier = inc.tier; changed = true; }
    const n = (inc.notes || '').trim();
    if (n && !(ex.notes || '').includes(n)) { ex.notes = ex.notes ? `${ex.notes}\n${n}` : n; changed = true; }
    if (!hasLoc(ex) && hasLoc(inc)) { ex.lat = inc.lat; ex.lng = inc.lng; ex.geo = inc.geo; changed = true; }
    if (inc.gbp && fresh(inc.gbp) > fresh(ex.gbp)) { ex.gbp = inc.gbp; changed = true; }
    for (const [k, v] of Object.entries(inc.extra || {})) if (!(k in (ex.extra || {}))) { ex.extra = { ...(ex.extra || {}), [k]: v }; changed = true; }
    if (changed) res.updated++;
  }
  if (!homeOf() && incoming.settings?.home) S().home = incoming.settings.home;
  local.demo = false;
  return res;
}

async function restoreBackup() {
  let b;
  try { b = await window.api.openBackup(); } catch (e) { toast(e.message, { error: true }); return; }
  if (!b) return;
  const m = b.manifest || {};
  const localCount = state.data.demo ? 0 : state.data.clients.length;
  const st = { mode: localCount ? 'merge' : 'replace', password: '', prospects: !!b.data.prospecting };
  const localPros = state.data.prospecting?.prospects.length || 0;
  const when = m.createdAt ? new Date(m.createdAt) : null;
  const newer = m.appVersion && b.thisAppVersion && m.appVersion.localeCompare(b.thisAppVersion, undefined, { numeric: true }) > 0;
  showModal({
    title: 'Restore a backup',
    desc: `From <b>${esc(b.fileName)}</b>`,
    render: () => `
      <dl class="extra backup-sum">
        <dt>Saved</dt><dd>${when ? esc(when.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })) : '—'}${m.computer ? ` on <b>${esc(m.computer)}</b>` : ''}</dd>
        <dt>Contains</dt><dd>${m.clients} clients · ${m.visits} visits · ${m.groups} groups${m.prospects ? ` · ${m.prospects} prospects` : ''}</dd>
        ${m.format === 0 ? '<dt>Note</dt><dd>Backup from an older version: clients, visits, groups and settings (no Google key).</dd>' : ''}
      </dl>
      ${newer ? `<p class="note bad">This backup comes from a newer version of the app (${esc(m.appVersion)}). Update this computer first if anything looks wrong.</p>` : ''}
      ${localCount ? `
        <div class="field" style="margin-top:12px"><label>This computer already has ${localCount} clients</label>
          <div class="radio-list">
            <label><input type="radio" name="rmode" value="merge"${st.mode === 'merge' ? ' checked' : ''}><span><b>Combine</b> — add the backup's clients and visits to the ones here. Nothing is removed; clients found on both are joined and keep the visits of both.</span></label>
            <label><input type="radio" name="rmode" value="replace"${st.mode === 'replace' ? ' checked' : ''}><span><b>Replace</b> — this computer gets exactly the backup's data (clients, visits, groups and settings). What is here now is removed.</span></label>
          </div></div>` : ''}
      ${b.data.prospecting ? `<label class="check" style="margin-top:12px"><input type="checkbox" id="r-pros"${st.prospects ? ' checked' : ''}> Restore the prospecting map${localPros ? ` (with Combine, joined with the ${localPros} prospects here; with Replace, replaces them)` : ''}</label>` : ''}
      ${b.hasKey ? `
        <div class="field" style="margin-top:12px"><label for="r-pass">The backup includes a Google API key — its password</label>
          <input type="password" id="r-pass" placeholder="Leave empty to skip the key" autocomplete="off"></div>` : ''}
      <p class="note">A copy of the data on this computer is kept in the backups folder (… → Open data folder) before anything changes.</p>
      <div class="err" id="r-err"></div>`,
    buttons: [{ label: 'Cancel', action: 'close' }, { label: 'Restore', primary: true, action: 'ok' }],
    onChange(e) {
      if (e.target.name === 'rmode') st.mode = e.target.value;
      if (e.target.id === 'r-pros') st.prospects = e.target.checked;
    },
    async onOk(close, box) {
      const err = t => { box.querySelector('#r-err').textContent = t; };
      const pw = box.querySelector('#r-pass')?.value || '';
      if (pw) { const k = await window.api.unlockBackupKey(pw); if (!k.ok) return err(k.error + ' Try again, or leave it empty to restore without the key.'); }
      if (st.mode === 'replace' && localCount && !(await confirmDialog('Replace the data on this computer?', `The ${localCount} clients here and their visits will be replaced by the ${m.clients} clients of the backup. A safety copy is kept in the backups folder.`, 'Replace', true))) return;
      flushSave();
      const a = await window.api.applyBackup({ current: state.data.demo ? null : state.data });
      if (!a.ok) return err(a.error || 'The backup could not be restored.');
      close();
      let msg;
      if (st.mode === 'replace') {
        const keepPros = state.data.prospecting;
        loadData(st.prospects ? b.data : { ...b.data, prospecting: keepPros });
        msg = `Backup restored: ${state.data.clients.length} clients and their visits.`;
      } else {
        const r = mergeBackup(b.data);
        if (st.prospects) mergeProspecting(b.data.prospecting);
        if (state.data.groups.length) assignToNearest(r.newClients.filter(c => hasLoc(c) && !c.groupId), { quiet: true });
        else if (state.data.clients.some(hasLoc)) await regroup({ confirm: false });
        state.selectedClientId = null; state.selectedGroupId = null;
        renderAll(); renderDetail();
        msg = `Backup combined: ${r.added} new client${r.added === 1 ? '' : 's'}, ${r.visits} visit${r.visits === 1 ? '' : 's'} added${r.updated ? `, ${r.updated} client${r.updated === 1 ? '' : 's'} updated` : ''}.`;
      }
      if (a.keyMasked) { state.googleKey = { hasKey: true, masked: a.keyMasked }; msg += ' Google API key added.'; }
      else if (a.keyError) msg += ' Google API key not added: ' + a.keyError;
      save(); renderAll(); fitAll();
      toast(msg);
      if (state.derived.pending.length) geocodeClients(state.derived.pending).then(afterLocate);
      else setTimeout(autoLookupGoogle, 800);
    },
  });
}

// =====================================================================
// Demo data (fictional clients around Lyon)
// =====================================================================
function loadDemo() {
  const towns = [
    ['Lyon', '69003', 45.760, 4.850, 9], ['Villeurbanne', '69100', 45.771, 4.890, 5], ['Vénissieux', '69200', 45.697, 4.886, 3],
    ['Bron', '69500', 45.738, 4.913, 3], ['Caluire-et-Cuire', '69300', 45.796, 4.846, 3], ['Écully', '69130', 45.775, 4.776, 2],
    ['Meyzieu', '69330', 45.767, 5.003, 2], ['Saint-Priest', '69800', 45.696, 4.944, 3], ['Vienne', '38200', 45.525, 4.874, 4],
    ['Villefranche-sur-Saône', '69400', 45.989, 4.719, 4], ['Bourgoin-Jallieu', '38300', 45.586, 5.274, 3], ['Givors', '69700', 45.590, 4.769, 2],
  ];
  const kinds = ['Boulangerie', 'Pharmacie', 'Garage', 'Fleuriste', 'Quincaillerie', 'Épicerie', 'Opticien', 'Librairie', 'Cave', 'Salon', 'Atelier', 'Bistrot'];
  const names = ['du Centre', 'des Lilas', 'Martin', 'Bernard', 'de la Gare', 'Petit', 'du Marché', 'Moreau', 'Laurent', 'des Arts', 'Fournier', 'du Parc', 'Girard', 'Bonnet', 'du Pont'];
  const streets = ['rue de la République', 'avenue Jean Jaurès', 'rue Victor Hugo', 'place du Marché', 'rue Pasteur', 'boulevard des Belges', 'rue des Écoles', 'chemin des Vignes'];
  let seed = 3;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const clients = [];
  let k = 0;
  for (const [city, pc, lat, lng, n] of towns) {
    for (let i = 0; i < n; i++, k++) {
      const c = {
        id: uid(), name: `${kinds[k % kinds.length]} ${names[(k * 7) % names.length]}`,
        address: `${1 + Math.floor(rnd() * 120)} ${streets[Math.floor(rnd() * streets.length)]}`, postcode: pc, city, country: '',
        lat: lat + (rnd() - 0.5) * 0.035, lng: lng + (rnd() - 0.5) * 0.05, geo: { status: 'ok', label: 'Demo', score: 1, source: 'file' },
        notes: '', extra: {}, visits: [], groupId: null, createdAt: todayISO(),
      };
      const pattern = [['9-12, 14-19', '9-12, 14-19', '9-12, 14-19', '9-12, 14-19', '9-12, 14-19', '9-12', ''],
        ['7-13, 15-19:30', '7-13, 15-19:30', '', '7-13, 15-19:30', '7-13, 15-19:30', '7-13, 15-19:30', '7-12:30'],
        ['8:30-18', '8:30-18', '8:30-18', '8:30-18', '8:30-18', '', ''], null][k % 4];
      if (pattern) c.gbp = { status: 'manual', hours: { ...Hours.parseWeek(pattern), source: 'manual', updatedAt: todayISO() } };
      const r = rnd();
      if (r > 0.12) {
        const back = Math.floor(rnd() * 110);
        const d = new Date(); d.setDate(d.getDate() - back);
        addVisit(c, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      }
      clients.push(c);
    }
  }
  clients.forEach((c, i) => { c.tier = i % 7 === 0 ? 'A' : i % 5 === 0 ? 'C' : ''; });
  state.data.clients = clients; state.data.groups = []; state.data.demo = true;
  // A few planned visits so the Planned tab has something to show.
  const day = nextWorkday(todayISO());
  clients.filter(c => c.city === 'Villeurbanne' || c.city === 'Caluire-et-Cuire').slice(0, 5).forEach(c => recordVisit(c, { date: day, status: 'planned', order: 1 }));
  optimizeDay(day);
  const prev = clients.find(c => c.city === 'Vienne');
  if (prev) recordVisit(prev, { date: addDaysISO(todayISO(), -2), status: 'planned' });
  regroup({ confirm: false });
}

// =====================================================================
// Modals, toasts, progress
// =====================================================================
let modalCtx = null;
function showModal(opts) {
  const back = $('#modal'), box = $('#modal-box');
  box.className = 'modal' + (opts.wide ? ' wide' : '');
  const close = () => { back.hidden = true; box.innerHTML = ''; modalCtx = null; opts.onClose && opts.onClose(); };
  const rerender = () => { box.querySelector('.modal-body').innerHTML = opts.render(box); };
  box.innerHTML = `
    <div class="modal-head"><h2>${opts.title}</h2>${opts.desc ? `<p>${opts.desc}</p>` : ''}</div>
    <div class="modal-body">${opts.render(box)}</div>
    <div class="modal-foot">${opts.buttons.map((b, i) => `<button class="btn${b.primary ? ' primary' : ''}${b.danger ? ' danger solid' : ''}" data-mb="${i}">${b.label}</button>`).join('')}</div>`;
  back.hidden = false;
  modalCtx = { close, opts };
  box.onclick = e => {
    const b = e.target.closest('[data-mb]');
    if (!b) { if (opts.onClick) opts.onClick(e, box, close, rerender); return; }
    const btn = opts.buttons[+b.dataset.mb];
    if (btn.action === 'close') close();
    else if (btn.action === 'ok') opts.onOk(close, box);
    else if (btn.fn) btn.fn(close, box);
  };
  box.onchange = e => opts.onChange && opts.onChange(e, rerender, box);
  box.oninput = e => opts.onInput && opts.onInput(e, box);
  box.onkeydown = e => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'radio' && opts.onOk) { e.preventDefault(); opts.onOk(close, box); }
  };
  const f = box.querySelector('[autofocus], .modal-body input:not([type=checkbox]):not([type=radio])');
  if (f) setTimeout(() => f.focus(), 30);
  else setTimeout(() => box.querySelector('.btn.primary')?.focus(), 30);
}

function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  return new Promise(resolve => {
    const prev = modalCtx; // confirm can open on top of another dialog
    const prevHtml = prev ? $('#modal-box').innerHTML : null;
    const prevClass = $('#modal-box').className;
    let answered = false;
    const restore = () => {
      if (prev) { $('#modal-box').innerHTML = prevHtml; $('#modal-box').className = prevClass; $('#modal').hidden = false; reattach(prev); }
    };
    showModal({
      title, render: () => `<p style="margin:0">${message}</p>`,
      buttons: [{ label: 'Cancel', action: 'close' }, { label: okLabel, primary: !danger, danger, fn: close => { answered = true; close(); } }],
      onClose: () => { restore(); resolve(answered); },
    });
  });
}
function reattach(ctx) {
  // Re-bind a dialog that was temporarily covered by a confirmation.
  const box = $('#modal-box'), back = $('#modal');
  const opts = ctx.opts;
  const close = () => { back.hidden = true; box.innerHTML = ''; modalCtx = null; opts.onClose && opts.onClose(); };
  const rerender = () => { box.querySelector('.modal-body').innerHTML = opts.render(box); };
  modalCtx = { close, opts };
  box.onclick = e => {
    const b = e.target.closest('[data-mb]');
    if (!b) { if (opts.onClick) opts.onClick(e, box, close, rerender); return; }
    const btn = opts.buttons[+b.dataset.mb];
    if (btn.action === 'close') close(); else if (btn.action === 'ok') opts.onOk(close, box); else if (btn.fn) btn.fn(close, box);
  };
  box.onchange = e => opts.onChange && opts.onChange(e, rerender, box);
  box.oninput = e => opts.onInput && opts.onInput(e, box);
}

function promptDialog(title, label, value = '') {
  return new Promise(resolve => {
    let result = null;
    showModal({
      title, render: () => `<div class="field"><label>${esc(label)}</label><input id="p-val" value="${esc(value)}" autofocus></div>`,
      buttons: [{ label: 'Cancel', action: 'close' }, { label: 'Save', primary: true, action: 'ok' }],
      onOk(close, box) { result = box.querySelector('#p-val').value.trim() || null; close(); },
      onClose: () => resolve(result),
    });
  });
}

function toast(msg, { error, action } = {}) {
  const t = document.createElement('div');
  t.className = 'toast' + (error ? ' err' : '');
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn small'; b.style.marginLeft = '10px'; b.style.background = 'transparent'; b.style.color = '#fff'; b.style.borderColor = 'rgba(255,255,255,.4)';
    b.textContent = action.label;
    b.onclick = () => { action.fn(); t.remove(); };
    t.appendChild(b);
  }
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), action ? 7000 : error ? 6500 : 3800);
}

function showProgress(text, frac) {
  $('#progress').hidden = false;
  $('#progress-text').textContent = text;
  $('.progress-bar').style.display = frac === null ? 'none' : '';
  $('#progress-stop').style.display = state.geocoding || state.gjob ? '' : 'none';
  if (frac !== null) $('#progress-fill').style.width = Math.round(frac * 100) + '%';
}
function hideProgress() { $('#progress').hidden = true; }

// =====================================================================
// Render all & init
// =====================================================================
function renderAll() {
  derive();
  setTimeout(fillMissingTowns, 0);
  renderStats(); renderTabs(); renderBanners(); renderList(); renderMap(); renderLegend(); renderSelectBar();
  $('#empty').hidden = state.data.clients.length > 0 || state.tab === 'prospecting';
  $('#btn-regroup').disabled = !state.data.clients.some(hasLoc);
  $('#btn-export').disabled = !state.data.clients.length;
  const lb = S().lastBackupAt;
  $('#menu [data-act="backup"]').innerHTML = `Save a backup…${lb ? `<small>last: ${esc(fmtAgo(daysSince(lb)).toLowerCase())}</small>` : ''}`;
}

function loadData(data) {
  const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  settings.tiers = Object.fromEntries(Object.entries(DEFAULT_TIERS).map(([k, d]) => [k, { ...d, ...((data.settings?.tiers || {})[k] || {}) }]));
  state.data = {
    version: 1, demo: !!data.demo,
    settings,
    clients: (data.clients || []).map(c => normalizeVisits({ visits: [], extra: {}, notes: '', address: '', postcode: '', city: '', country: '', tier: '', ...c })),
    groups: data.groups || [],
    // prospecting.js loads after this file; keep the data as is if it failed to load.
    prospecting: typeof normalizeProspecting === 'function' ? normalizeProspecting(data.prospecting) : data.prospecting,
  };
  state.selectedClientId = null; state.selectedGroupId = null; state.selectedDay = null; state.selection.clear();
  renderAll(); renderDetail();
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (modalCtx) { modalCtx.close(); return; }
  if (state.placingClientId) { stopPlacing(); return; }
  if (state.selectedClientId) { state.selectedClientId = null; renderAll(); renderDetail(); return; }
  if (state.selection.size) clearSelection();
});

$('#btn-import').addEventListener('click', openImport);
$('#empty-import').addEventListener('click', openImport);
$('#empty-demo').addEventListener('click', loadDemo);
$('#empty-restore').addEventListener('click', restoreBackup);
$('#btn-add').addEventListener('click', addClientDialog);
$('#btn-regroup').addEventListener('click', () => regroup());
$('#btn-export').addEventListener('click', e => { e.stopPropagation(); $('#menu').hidden = true; $('#export-menu').hidden = !$('#export-menu').hidden; });
$('#export-menu').addEventListener('click', e => {
  const act = e.target.closest('[data-exp]')?.dataset.exp;
  $('#export-menu').hidden = true;
  if (act === 'xlsx') exportExcel();
  if (act === 'kmz') exportKmz();
});
document.addEventListener('click', () => { $('#export-menu').hidden = true; });

(async function init() {
  const data = await window.api.loadData();
  if (data && data.__error) toast(data.__error, { error: true });
  try { state.googleKey = await window.api.googleKeyStatus(); } catch { /* keep default */ }
  loadData(data && !data.__error ? data : {});
  fitAll();
  // Resume locating addresses left over from last time, then Google pages not looked up yet.
  if (state.derived.pending.length) geocodeClients(state.derived.pending).then(afterLocate);
  else setTimeout(autoLookupGoogle, 1500);
})();

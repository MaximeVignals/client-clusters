/* Client Clusters — renderer: app state, saving, visits, priority and derived group summaries */
'use strict';

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

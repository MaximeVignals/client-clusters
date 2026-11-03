/* Client Clusters — renderer: map, markers, map selection and legend */
'use strict';

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

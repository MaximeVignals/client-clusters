// Prospecting tab: a separate map of prospects (Excel/CSV, KMZ/KML or GeoJSON), kept apart from clients.
// Points become prospects; shapes (sectors, zones, lines) are drawn as areas on the map.
// Prospects never count as clients and don't affect visits, groups or exports.
// Loaded after app.js and uses its helpers (state, save, renderAll, showModal, geocodeOne, Cluster…).

const PROSPECT_STATUS = {
  todo: { label: 'To contact', color: '#2563eb' },
  visited: { label: 'Visited', color: '#c7811a' },
  converted: { label: 'Converted', color: '#2e8a57' },
  no: { label: 'Not interested', color: '#8b8d86' },
};
const PROSPECT_FIELDS = ['name', 'address', 'postcode', 'city', 'country', 'lat', 'lng', 'notes'];
const AREA_COLOR = '#9333ea';

const P = () => {
  if (!state.data.prospecting) state.data.prospecting = { fileName: '', importedAt: '', prospects: [], areas: [] };
  return state.data.prospecting;
};
const prospectById = id => P().prospects.find(p => p.id === id);
state.prospectFilter = '';          // '' = all statuses
state.selectedProspectId = null;

function normalizeProspecting(d) {
  if (!d) return undefined;
  return {
    fileName: d.fileName || '', importedAt: d.importedAt || '', ...(d.demo ? { demo: true } : {}),
    prospects: (d.prospects || []).map(p => ({ status: 'todo', notes: '', address: '', postcode: '', city: '', country: '', extra: {}, group: null, ...p })),
    areas: d.areas || [],
  };
}

// Backup "Combine": add the backup's prospects and areas; for prospects found on both, the latest status change wins.
function mergeProspecting(incoming) {
  const inc = normalizeProspecting(incoming);
  if (!inc) return;
  const d = P();
  const keyOf = p => norm(p.name) + '|' + norm(p.address) + '|' + norm(p.postcode) + '|' + norm(p.city);
  const byId = new Map(d.prospects.map(p => [p.id, p])), byKey = new Map(d.prospects.map(p => [keyOf(p), p]));
  for (const p of inc.prospects) {
    const ex = byId.get(p.id) || byKey.get(keyOf(p));
    if (!ex) {
      const added = { ...p, group: null };
      d.prospects.push(added); byId.set(added.id, added); byKey.set(keyOf(added), added);
      continue;
    }
    if ((p.statusAt || '') > (ex.statusAt || '')) { ex.status = p.status; ex.statusAt = p.statusAt; }
    if (!hasLoc(ex) && hasLoc(p)) { ex.lat = p.lat; ex.lng = p.lng; ex.geo = p.geo; }
  }
  const areaKey = a => JSON.stringify(a.geometry);
  const have = new Set(d.areas.map(areaKey));
  for (const area of inc.areas) {
    const key = areaKey(area);
    if (!have.has(key)) { d.areas.push(area); have.add(key); }
  }
  if (!d.fileName) d.fileName = inc.fileName;
  if (!d.importedAt) d.importedAt = inc.importedAt;
}

// ---------- Convert to client ----------
async function convertProspect(id) {
  const p = prospectById(id);
  if (!p) return;
  if (P().demo) { toast("Demo prospects are made up, so they can't become clients. Load your own file to use this."); return; }
  const keyOf = c => norm(c.name) + '|' + norm(c.address) + '|' + norm(c.postcode) + '|' + norm(c.city);
  const dup = state.data.clients.find(c => keyOf(c) === keyOf(p));
  if (dup) {
    if (!(await confirmDialog('Already a client', `“${esc(dup.name)}” with the same address is already in your clients. Remove it from the prospects anyway?`, 'Remove prospect'))) return;
  } else {
    if (!(await confirmDialog('Convert to client?', `“${esc(p.name)}” moves to your client list (address, position, notes and other columns). It is removed from the prospecting map.`, 'Convert'))) return;
    const c = normalizeVisits({
      id: uid(), name: p.name, address: p.address || '', postcode: p.postcode || '', city: p.city || '', country: p.country || '',
      notes: p.notes || '', extra: { ...(p.extra || {}), Source: 'Prospecting' + (P().fileName ? ' — ' + P().fileName : '') },
      tier: '', visits: [], groupId: null, createdAt: todayISO(),
      ...(hasLoc(p) ? { lat: p.lat, lng: p.lng, geo: p.geo } : { geo: { status: 'pending' } }),
    });
    if (state.data.demo) { state.data.clients = []; state.data.groups = []; state.data.demo = false; }
    state.data.clients.push(c);
    if (hasLoc(c) && state.data.groups.length) assignToNearest([c], { quiet: true });
  }
  const d = P();
  d.prospects = d.prospects.filter(x => x.id !== id);
  state.selectedProspectId = null;
  save(); renderAll();
  toast(dup ? 'Prospect removed.' : `${p.name} is now a client.`, dup ? {} : { action: { label: 'Show', fn: () => { state.tab = 'clients'; renderAll(); selectClient(state.data.clients[state.data.clients.length - 1].id, { pan: true }); } } });
  const added = !dup && state.data.clients[state.data.clients.length - 1];
  if (added && !hasLoc(added)) geocodeClients([added]).then(afterLocate);
}

// ---------- Reading files ----------
function readKmlProspects(kmlText) {
  const doc = new DOMParser().parseFromString(kmlText.replace(/^﻿/, ''), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('This KML file could not be read.');
  const kid = (el, name) => [...el.children].find(c => c.localName === name);
  const text = (el, name) => (kid(el, name)?.textContent || '').trim();
  const plain = h => (/[<&]/.test(h) ? (new DOMParser().parseFromString(h.replace(/<br\s*\/?>/gi, '\n'), 'text/html').body.textContent || '') : h).trim();
  const coords = el => el.textContent.trim().split(/\s+/).map(t => t.split(',').map(Number)).filter(c => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])).map(c => [c[0], c[1]]);
  const points = [], areas = [];
  for (const pm of doc.getElementsByTagNameNS('*', 'Placemark')) {
    const name = text(pm, 'name'), description = plain(text(pm, 'description'));
    const extra = {};
    for (const d of pm.getElementsByTagNameNS('*', 'Data')) { const k = d.getAttribute('name'); if (k) extra[k] = plain(text(d, 'value')); }
    for (const d of pm.getElementsByTagNameNS('*', 'SimpleData')) { const k = d.getAttribute('name'); if (k) extra[k] = d.textContent.trim(); }
    const geoms = [];
    for (const poly of pm.getElementsByTagNameNS('*', 'Polygon')) {
      const outer = poly.getElementsByTagNameNS('*', 'outerBoundaryIs')[0];
      const c = outer && outer.getElementsByTagNameNS('*', 'coordinates')[0];
      if (c) geoms.push({ type: 'Polygon', coordinates: [coords(c)] });
    }
    for (const ls of pm.getElementsByTagNameNS('*', 'LineString')) {
      const c = ls.getElementsByTagNameNS('*', 'coordinates')[0];
      if (c) geoms.push({ type: 'LineString', coordinates: coords(c) });
    }
    const pt = pm.getElementsByTagNameNS('*', 'Point')[0];
    const pc = pt && pt.getElementsByTagNameNS('*', 'coordinates')[0];
    const ll = pc && coords(pc)[0];
    if (ll) points.push({ name, notes: description, extra, lng: ll[0], lat: ll[1] });
    else if (geoms.length) geoms.forEach(g => areas.push({ type: 'Feature', properties: { name, description }, geometry: g }));
    else { const address = text(pm, 'address'); if (address) points.push({ name: name || address, address, notes: description, extra }); }
  }
  return { points, areas };
}

function readGeoJsonProspects(textIn) {
  let gj;
  try { gj = JSON.parse(textIn.replace(/^﻿/, '')); } catch { throw new Error('This GeoJSON file could not be read.'); }
  const feats = gj.type === 'FeatureCollection' ? gj.features || [] : gj.type === 'Feature' ? [gj] : gj.type ? [{ type: 'Feature', properties: {}, geometry: gj }] : [];
  const pick = (props, re) => { const k = Object.keys(props).find(x => re.test(norm(x))); return k ? String(props[k] ?? '').trim() : ''; };
  const points = [], areas = [];
  for (const f of feats) {
    const g = f && f.geometry, props = (f && f.properties) || {};
    if (!g) continue;
    const name = pick(props, /^(name|nom|title|titre|raison sociale|societe|company|enseigne)$/);
    const base = {
      name, address: pick(props, /(adresse|address|rue|street)/), postcode: pick(props, /(code postal|^cp$|postal|zip|postcode)/),
      city: pick(props, /(ville|city|commune|town)/), notes: pick(props, /(description|note|comment)/),
      extra: Object.fromEntries(Object.entries(props).filter(([, v]) => v !== null && typeof v !== 'object' && String(v).trim()).map(([k, v]) => [k, String(v)])),
    };
    const pts = g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : null;
    if (pts) pts.forEach(c => { if (Number.isFinite(c[0]) && Number.isFinite(c[1])) points.push({ ...base, lng: c[0], lat: c[1] }); });
    else areas.push({ type: 'Feature', properties: { name, description: base.notes }, geometry: g });
  }
  return { points, areas };
}

// Excel / CSV: same column matching as the client import, limited to the fields a prospect has.
function sheetProspectsDialog(file) {
  return new Promise(resolve => {
    const fields = FIELDS.filter(f => PROSPECT_FIELDS.includes(f.key));
    const st = { sheet: 0, header: true, mapping: null };
    const sheetData = () => {
      const rows = file.sheets[st.sheet].rows;
      const width = Math.max(...rows.map(r => r.length));
      const headers = Array.from({ length: width }, (_, i) => (st.header && String(rows[0][i] ?? '').trim()) || `Column ${colLetter(i)}`);
      return { headers, data: st.header ? rows.slice(1) : rows };
    };
    st.mapping = guessMapping(sheetData().headers);
    let done = false;
    showModal({
      wide: true,
      title: 'Import prospects',
      desc: `From <b>${esc(file.fileName)}</b>. Tell the app which column holds what — it guessed from your column titles.`,
      render() {
        const { headers, data } = sheetData();
        const opt = key => `<option value="-1">— none —</option>` + headers.map((h, i) => `<option value="${i}"${st.mapping[key] === i ? ' selected' : ''}>${esc(h)}</option>`).join('');
        return `
          ${file.sheets.length > 1 ? `<div class="field" style="max-width:300px"><label>Sheet</label><select data-imp="sheet">${file.sheets.map((s, i) => `<option value="${i}"${i === st.sheet ? ' selected' : ''}>${esc(s.name)} (${s.rows.length} rows)</option>`).join('')}</select></div>` : ''}
          <label class="check" style="margin-bottom:12px"><input type="checkbox" data-imp="header"${st.header ? ' checked' : ''}> The first row contains column titles</label>
          <div class="map-grid">${fields.map(f => `<div class="field"><label>${f.label.replace('Client', 'Prospect')}${f.required ? ' <b>*</b>' : ''}</label><select data-map="${f.key}">${opt(f.key)}</select></div>`).join('')}</div>
          <p class="note">${data.length} rows in this sheet. Other columns are kept and shown on each prospect.</p>
          <div class="err" id="imp-err"></div>`;
      },
      buttons: [{ label: 'Cancel', action: 'close' }, { label: 'Next', primary: true, action: 'ok' }],
      onChange(e, rerender) {
        const t = e.target;
        if (t.dataset.imp === 'sheet') { st.sheet = +t.value; st.mapping = guessMapping(sheetData().headers); }
        else if (t.dataset.imp === 'header') { st.header = t.checked; st.mapping = guessMapping(sheetData().headers); }
        else if (t.dataset.map) st.mapping[t.dataset.map] = +t.value;
        rerender();
      },
      onOk(close, box) {
        const m = st.mapping;
        const err = msg => { box.querySelector('#imp-err').textContent = msg; };
        if (m.name < 0) return err('Choose the column with the prospect name.');
        if (m.address < 0 && m.city < 0 && m.postcode < 0 && !(m.lat >= 0 && m.lng >= 0)) return err('Choose at least an address, postal code or city column (or latitude and longitude).');
        const { headers, data } = sheetData();
        const used = new Set(Object.values(m).filter(i => i >= 0));
        const get = (r, k) => (m[k] >= 0 ? String(r[m[k]] ?? '').trim() : '');
        const points = data.map(r => {
          const extra = {};
          headers.forEach((h, i) => { if (!used.has(i) && String(r[i] ?? '').trim()) extra[h] = String(r[i]).trim(); });
          const lat = parseCoord(get(r, 'lat'), 90), lng = parseCoord(get(r, 'lng'), 180);
          return { name: get(r, 'name'), address: get(r, 'address'), postcode: get(r, 'postcode'), city: get(r, 'city'), country: get(r, 'country'), notes: get(r, 'notes'), extra,
            ...(lat !== null && lng !== null && !(lat === 0 && lng === 0) ? { lat, lng } : {}) };
        });
        done = true; close(); resolve({ points, areas: [] });
      },
      onClose() { if (!done) resolve(null); },
    });
  });
}

function askReplaceOrAdd(nPoints, nAreas) {
  const cur = P();
  if (cur.demo || (!cur.prospects.length && !cur.areas.length)) return Promise.resolve('replace');
  return new Promise(resolve => {
    let answer = null;
    showModal({
      title: 'Prospecting map already loaded',
      desc: `The new file has ${nPoints} prospect${nPoints === 1 ? '' : 's'}${nAreas ? ` and ${nAreas} area${nAreas === 1 ? '' : 's'}` : ''}. You currently have ${cur.prospects.length} prospect${cur.prospects.length === 1 ? '' : 's'}${cur.fileName ? ` from <b>${esc(cur.fileName)}</b>` : ''}.`,
      render: () => '<p class="note">“Add” keeps the statuses of prospects already there (same name and address). “Replace” starts over with the new file.</p>',
      buttons: [
        { label: 'Cancel', action: 'close' },
        { label: 'Replace', danger: true, fn: close => { answer = 'replace'; close(); } },
        { label: 'Add to it', primary: true, fn: close => { answer = 'merge'; close(); } },
      ],
      onClose() { resolve(answer); },
    });
  });
}

async function importProspects() {
  let file;
  try { file = await window.api.openProspectFile(); } catch (e) { toast('Could not read this file: ' + e.message, { error: true }); return; }
  if (!file) return;
  let res;
  try {
    if (file.geojson !== undefined) res = readGeoJsonProspects(file.geojson);
    else if (file.kml !== undefined) res = readKmlProspects(file.kml);
    else if (file.sheets?.length) res = await sheetProspectsDialog(file);
    else { toast('This file looks empty.', { error: true }); return; }
  } catch (e) { toast(e.message, { error: true }); return; }
  if (!res) return;
  res.points = res.points.filter(p => p.name || p.address).map(p => ({ ...p, name: p.name || p.address }));
  if (!res.points.length && !res.areas.length) { toast('No prospects or areas found in this file.', { error: true }); return; }
  const mode = await askReplaceOrAdd(res.points.length, res.areas.length);
  if (!mode) return;
  applyProspects(res, file.fileName, mode);
}

function applyProspects({ points, areas }, fileName, mode) {
  const d = P();
  if (mode === 'replace') { d.prospects = []; d.areas = []; }
  delete d.demo;
  const keyOf = p => norm(p.name) + '|' + norm(p.address) + '|' + norm(p.postcode) + '|' + norm(p.city);
  const index = new Map(d.prospects.map(p => [keyOf(p), p]));
  let added = 0, updated = 0;
  for (const rec of points) {
    if (/^\d{4}$/.test(rec.postcode || '') && (!rec.country || /^fr/i.test(rec.country))) rec.postcode = '0' + rec.postcode;
    const existing = index.get(keyOf(rec));
    const p = existing || { id: uid(), status: 'todo', group: null, createdAt: todayISO() };
    Object.assign(p, { name: rec.name, address: rec.address || '', postcode: rec.postcode || '', city: rec.city || '', country: rec.country || '', notes: rec.notes || p.notes || '', extra: { ...(p.extra || {}), ...(rec.extra || {}) } });
    if (Number.isFinite(rec.lat) && Number.isFinite(rec.lng)) { p.lat = rec.lat; p.lng = rec.lng; p.geo = { status: 'ok', label: 'From your file', score: 1, source: 'file' }; }
    else if (!existing || !hasLoc(p)) { delete p.lat; delete p.lng; p.geo = { status: 'pending' }; }
    if (existing) updated++; else { d.prospects.push(p); index.set(keyOf(p), p); added++; }
  }
  d.areas = d.areas.concat(areas);
  d.fileName = mode === 'merge' && d.fileName ? `${d.fileName} + ${fileName}` : fileName;
  d.importedAt = todayISO();
  d.prospects.forEach(p => { p.group = null; });
  state.tab = 'prospecting'; state.selectedProspectId = null;
  save(); renderAll(); renderDetail();
  toast(`${added} prospect${added === 1 ? '' : 's'} added${updated ? `, ${updated} updated` : ''}${areas.length ? `, ${areas.length} area${areas.length === 1 ? '' : 's'}` : ''}.`);
  const pending = d.prospects.filter(p => !hasLoc(p) && p.geo?.status === 'pending');
  if (pending.length) geocodeProspects(pending).then(fitProspects); else fitProspects();
}

// ---------- Geocoding (same services and caches as clients) ----------
async function geocodeProspects(list) {
  if (!list.length || state.geocoding) return;
  const job = state.geocoding = { total: list.length, done: 0, stop: false };
  showProgress(`Locating prospects… 0 / ${job.total}`, 0);
  const res = { ok: 0, failed: 0, network: 0 };
  let next = 0, lastRender = Date.now();
  const worker = async () => {
    while (!job.stop && next < list.length) {
      const p = list[next++];
      let r;
      try { r = await geocodeOne(p); } catch { r = null; }
      if (r === true) res.ok++; else if (r === false) res.failed++; else res.network++;
      job.done++;
      showProgress(`Locating prospects… ${job.done} / ${job.total}`, job.done / job.total);
      if (res.network >= 6 && res.ok === 0) job.stop = true;
      if (Date.now() - lastRender > 1200) { lastRender = Date.now(); save(); renderAll(); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  state.geocoding = null;
  hideProgress(); save(); renderAll();
  if (res.network && !res.ok) toast("Couldn't reach the address service. Check the internet connection, then use “Locate”.", { error: true });
  else toast(`${res.ok} prospect${res.ok === 1 ? '' : 's'} placed on the map${res.failed ? `, ${res.failed} not found` : ''}.`);
}

// ---------- Grouping by proximity, numbered from home ----------
function groupProspects() {
  const d = P();
  const located = d.prospects.filter(hasLoc);
  if (!located.length) { toast('No prospect is on the map yet, so there is nothing to group.', { error: true }); return; }
  const res = Cluster.groupByTownAndDistance(located.map(p => ({ lat: p.lat, lng: p.lng, town: titleCase(p.city || p.geo?.city || '') })),
    { maxSize: S().maxSize, flexSize: S().flexSize, maxSpanKm: S().maxSpanKm });
  const centres = Array.from({ length: res.groups }, (_, i) => {
    const m = located.filter((_, j) => res.labels[j] === i);
    return { i, lat: m.reduce((a, p) => a + p.lat, 0) / m.length, lng: m.reduce((a, p) => a + p.lng, 0) / m.length };
  });
  const home = homeOf();
  if (home) centres.sort((a, b) => Cluster.distanceKm(home, a) - Cluster.distanceKm(home, b));
  const numberOf = new Map(centres.map((c, n) => [c.i, n + 1]));
  d.prospects.forEach(p => { p.group = null; });
  located.forEach((p, j) => { p.group = numberOf.get(res.labels[j]); });
  save(); renderAll();
  toast(`${res.groups} prospecting group${res.groups === 1 ? '' : 's'}, each within ${S().maxSpanKm} km.${home ? ' Group 1 is the nearest to home.' : ''}`);
}
const prospectGroupColor = n => PALETTE[(n - 1) % PALETTE.length];

// ---------- Sidebar ----------
function prospectMatches(p) {
  if (state.prospectFilter && p.status !== state.prospectFilter) return false;
  if (!state.search) return true;
  const q = norm(state.search);
  return [p.name, p.address, p.city, p.postcode, p.notes].some(x => norm(x).includes(q));
}

function prospectRow(p) {
  const st = PROSPECT_STATUS[p.status] || PROSPECT_STATUS.todo;
  const where = [p.address, [p.postcode, titleCase(p.city || '')].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return `<div class="member prospect${p.id === state.selectedProspectId ? ' sel' : ''}" data-prospect="${p.id}">
    <span class="dot" style="background:${st.color}"></span>
    <span class="name" title="${esc(where)}">${esc(p.name)}<small>${esc(titleCase(p.city || p.geo?.city || ''))}</small></span>
    ${hasLoc(p) ? '' : `<span class="pill warn">${p.geo?.status === 'pending' ? 'To locate' : 'Not found'}</span>`}
    <select class="pstatus" data-pstatus="${p.id}" title="Status">${Object.entries(PROSPECT_STATUS).map(([k, v]) => `<option value="${k}"${k === p.status ? ' selected' : ''}>${v.label}</option>`).join('')}</select>
  </div>${p.id === state.selectedProspectId ? prospectDetail(p, where) : ''}`;
}

function prospectDetail(p, where) {
  const extra = Object.entries(p.extra || {}).filter(([, v]) => String(v).trim()).slice(0, 8);
  return `<div class="p-detail">
    ${where ? `<div>${esc(where)}</div>` : ''}
    ${p.notes ? `<div class="p-notes">${esc(p.notes)}</div>` : ''}
    ${extra.length ? `<dl class="extra">${extra.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
    <div class="p-acts">
      <button class="btn small primary" data-pa="convert" data-id="${p.id}">Convert to client</button>
      ${hasLoc(p) ? `<button class="btn small" data-pa="maps" data-id="${p.id}">Open in Google Maps</button>` : ''}
    </div>
  </div>`;
}

function renderProspectingList() {
  const d = P();
  if (!d.prospects.length && !d.areas.length) {
    return `<div class="none">No prospecting map yet.<br><br>Load a list or map of places to prospect: Excel or CSV with addresses, KMZ/KML from Google Earth or My Maps, or GeoJSON. Areas drawn in the file (sectors, zones) are shown on the map.<br><br><button class="btn primary" data-pa="import">Load a prospecting file</button> <button class="btn" data-pa="demo">Try with demo data</button></div>`;
  }
  const counts = Object.fromEntries(Object.keys(PROSPECT_STATUS).map(k => [k, d.prospects.filter(p => p.status === k).length]));
  const pending = d.prospects.filter(p => !hasLoc(p) && p.geo?.status === 'pending').length;
  const grouped = d.prospects.some(p => p.group);
  let html = (d.demo ? `<div class="banner info" style="margin:0 0 8px">These are made-up demo prospects around Lyon. Loading your own file replaces them.<div class="acts"><button class="btn small" data-pa="import">Load my file</button><button class="btn small ghost" data-pa="demo-clear">Remove demo</button></div></div>` : '') + `<div class="p-head">
      <div class="p-file" title="${esc(d.fileName)}"><b>${esc(d.fileName || 'Prospecting map')}</b><span>${d.prospects.length} prospect${d.prospects.length === 1 ? '' : 's'}${d.areas.length ? ` · ${d.areas.length} area${d.areas.length === 1 ? '' : 's'}` : ''}${d.importedAt ? ` · loaded ${esc(fmtDate(d.importedAt))}` : ''}</span></div>
      <div class="p-acts">
        <button class="btn small" data-pa="import">Load file…</button>
        <button class="btn small" data-pa="group"${d.prospects.some(hasLoc) ? '' : ' disabled'}>${grouped ? 'Regroup' : 'Group by proximity'}</button>
        ${pending && !state.geocoding ? `<button class="btn small" data-pa="locate">Locate ${pending}</button>` : ''}
        <button class="btn small ghost danger" data-pa="clear">Remove</button>
      </div>
      <div class="p-filter">
        <button class="mini${state.prospectFilter ? '' : ' on'}" data-pf="">All ${d.prospects.length}</button>
        ${Object.entries(PROSPECT_STATUS).map(([k, v]) => `<button class="mini${state.prospectFilter === k ? ' on' : ''}" data-pf="${k}"><i style="background:${v.color}"></i>${v.label} ${counts[k]}</button>`).join('')}
      </div>
    </div>`;
  const list = d.prospects.filter(prospectMatches).sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) return html + `<div class="none">${d.prospects.length ? 'No prospect matches.' : 'This file only has areas.'}</div>`;
  if (!grouped) return html + list.map(prospectRow).join('');
  const byGroup = new Map();
  for (const p of list) { const k = p.group || 0; if (!byGroup.has(k)) byGroup.set(k, []); byGroup.get(k).push(p); }
  const home = homeOf();
  html += [...byGroup.keys()].sort((a, b) => (a || 1e9) - (b || 1e9)).map(n => {
    const members = byGroup.get(n);
    const loc = members.filter(hasLoc);
    const centre = loc.length ? { lat: loc.reduce((a, p) => a + p.lat, 0) / loc.length, lng: loc.reduce((a, p) => a + p.lng, 0) / loc.length } : null;
    const towns = [...new Set(members.map(p => titleCase(p.city || p.geo?.city || '')).filter(Boolean))];
    return `<div class="p-group">
      <div class="p-group-head">
        ${n ? `<span class="swatch" style="background:${prospectGroupColor(n)}">${n}</span>` : '<span class="swatch" style="background:#8b8d86">–</span>'}
        <span class="main"><div class="title">${n ? esc(towns.slice(0, 3).join(', ') || 'Group ' + n) : 'Not in a group'}</div><div class="sub">${members.length} prospect${members.length === 1 ? '' : 's'}${home && centre ? ` · ${fmtKm(Cluster.distanceKm(home, centre))} from home` : ''}</div></span>
        ${n && loc.length ? `<button class="btn small" data-pa="route" data-n="${n}">Route</button>` : ''}
      </div>
      ${members.map(prospectRow).join('')}
    </div>`;
  }).join('');
  return html;
}

$('#list').addEventListener('click', async e => {
  if (state.tab !== 'prospecting') return;
  const a = e.target.closest('[data-pa]');
  if (a) {
    const act = a.dataset.pa;
    if (act === 'import') importProspects();
    if (act === 'group') groupProspects();
    if (act === 'convert') convertProspect(a.dataset.id);
    if (act === 'demo') loadProspectDemo();
    if (act === 'demo-clear') { delete state.data.prospecting; state.selectedProspectId = null; save(); renderAll(); }
    if (act === 'maps') { const p = prospectById(a.dataset.id); if (p) window.api.openExternal(`https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`); }
    if (act === 'locate') geocodeProspects(P().prospects.filter(p => !hasLoc(p) && p.geo?.status === 'pending')).then(fitProspects);
    if (act === 'route') {
      const n = +a.dataset.n;
      const members = P().prospects.filter(p => p.group === n && hasLoc(p) && prospectMatches(p));
      openRouteLinks(homeOf(), members, `Prospecting group ${n}`);
    }
    if (act === 'clear' && await confirmDialog('Remove the prospecting map?', 'All prospects, their statuses and the areas are removed. Your clients are not affected.', 'Remove', true)) {
      delete state.data.prospecting; state.selectedProspectId = null; save(); renderAll();
    }
    return;
  }
  const f = e.target.closest('[data-pf]');
  if (f) { state.prospectFilter = f.dataset.pf; renderList(); renderMap(); return; }
  if (e.target.closest('select')) return;
  const r = e.target.closest('[data-prospect]');
  if (r) selectProspect(r.dataset.prospect, { pan: true });
});
$('#list').addEventListener('change', e => {
  const s = e.target.closest('[data-pstatus]');
  if (!s) return;
  const p = prospectById(s.dataset.pstatus);
  if (!p) return;
  p.status = s.value; p.statusAt = new Date().toISOString(); save(); renderList(); renderMap();
  if (p.status === 'converted') toast(`Add ${p.name} to your clients too?`, { action: { label: 'Convert to client', fn: () => convertProspect(p.id) } });
});

function selectProspect(id, { pan } = {}) {
  state.selectedProspectId = state.selectedProspectId === id ? null : id;
  const p = prospectById(id);
  if (pan && p && hasLoc(p) && state.selectedProspectId) map.panTo([p.lat, p.lng]);
  renderList(); renderMap();
}

// ---------- Map ----------
const areaLayer = L.layerGroup().addTo(map);
const prospectLayer = L.layerGroup().addTo(map);

function renderProspectLayer() {
  areaLayer.clearLayers(); prospectLayer.clearLayers();
  if (state.tab !== 'prospecting' || !state.data.prospecting) return;
  const d = P();
  if (d.areas.length) {
    L.geoJSON(d.areas, {
      style: () => ({ color: AREA_COLOR, weight: 2, opacity: 0.8, fillColor: AREA_COLOR, fillOpacity: 0.07 }),
      onEachFeature(f, layer) {
        const n = f.properties?.name, desc = f.properties?.description;
        if (n || desc) layer.bindTooltip(`<b>${esc(n || 'Area')}</b>${desc ? `<span>${esc(desc).slice(0, 300)}</span>` : ''}`, { className: 'tip', sticky: true });
      },
    }).addTo(areaLayer);
  }
  for (const p of d.prospects) {
    if (!hasLoc(p)) continue;
    const st = PROSPECT_STATUS[p.status] || PROSPECT_STATUS.todo;
    const dim = !prospectMatches(p);
    const sel = p.id === state.selectedProspectId;
    const html = `<div class="pin ppin${dim ? ' dim' : ''}${sel ? ' sel' : ''}" style="background:${st.color}${p.group ? `;border-color:${prospectGroupColor(p.group)}` : ''}">${p.group || ''}</div>`;
    const m = L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: '', html, iconSize: [20, 20], iconAnchor: [10, 10] }),
      zIndexOffset: sel ? 2500 : dim ? -400 : 1000, keyboard: false,
    });
    m.bindTooltip(`<b>${esc(p.name)}</b><span>${esc(st.label)}${p.group ? ` · Group ${p.group}` : ''}${p.city ? ` · ${esc(titleCase(p.city))}` : ''}</span>`, { className: 'tip', direction: 'top', offset: [0, -11] });
    m.on('click', e => { L.DomEvent.stopPropagation(e); selectProspect(p.id); });
    m.addTo(prospectLayer);
  }
}

function prospectLegend() {
  return `<div class="keys">
    ${Object.values(PROSPECT_STATUS).map(v => `<div class="key"><i style="background:${v.color}"></i>${v.label}</div>`).join('')}
    ${P().areas.length ? `<div class="key"><i style="background:${AREA_COLOR};opacity:.5;border-radius:2px"></i>Area from your file</div>` : ''}
    <div class="key sub">Faded pins are your clients</div></div>`;
}

function fitProspects() {
  const pts = P().prospects.filter(hasLoc).map(p => [p.lat, p.lng]);
  for (const a of P().areas) { try { const b = L.geoJSON(a).getBounds(); if (b.isValid()) pts.push(b.getNorthWest(), b.getSouthEast()); } catch { /* skip bad shape */ } }
  if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 13 });
}

// ---------- Demo data (fictional prospects and two sectors around Lyon) ----------
function loadProspectDemo() {
  const towns = [
    ['Lyon', '69007', 45.745, 4.845, 5], ['Villeurbanne', '69100', 45.771, 4.890, 3], ['Rillieux-la-Pape', '69140', 45.820, 4.898, 3],
    ['Décines-Charpieu', '69150', 45.769, 4.959, 3], ['Oullins', '69600', 45.714, 4.807, 3], ['Tassin-la-Demi-Lune', '69160', 45.764, 4.780, 2],
    ['Neuville-sur-Saône', '69250', 45.876, 4.841, 2], ['Mions', '69780', 45.663, 4.955, 2], ['Brignais', '69530', 45.674, 4.754, 2],
  ];
  const kinds = ['Boucherie', 'Pressing', 'Coiffeur', 'Cordonnerie', 'Pâtisserie', 'Bar-tabac', 'Brasserie', 'Primeur', 'Toilettage', 'Imprimerie'];
  const names = ['Duval', 'du Lac', 'Roux', 'des Tilleuls', 'Lefèvre', 'de l’Église', 'Chevalier', 'du Midi', 'Garnier', 'des Pins', 'Faure', 'Mercier'];
  const streets = ['rue Garibaldi', 'avenue des Frères Lumière', 'rue Paul Bert', 'grande rue', 'rue de la Mairie', 'cours Émile Zola', 'route de Vienne'];
  const statuses = ['todo', 'todo', 'todo', 'visited', 'todo', 'no', 'todo', 'converted', 'visited'];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const prospects = [];
  let k = 0;
  for (const [city, pc, lat, lng, n] of towns) {
    for (let i = 0; i < n; i++, k++) {
      prospects.push({
        id: uid(), name: `${kinds[k % kinds.length]} ${names[(k * 5) % names.length]}`,
        address: `${1 + Math.floor(rnd() * 90)} ${streets[Math.floor(rnd() * streets.length)]}`, postcode: pc, city, country: '',
        lat: lat + (rnd() - 0.5) * 0.03, lng: lng + (rnd() - 0.5) * 0.045, geo: { status: 'ok', label: 'Demo', score: 1, source: 'file' },
        status: statuses[k % statuses.length], notes: k % 4 === 0 ? 'Demo note: ask for the manager.' : '', extra: {}, group: null, createdAt: todayISO(),
      });
    }
  }
  const box = (name, w, s, e, n) => ({ type: 'Feature', properties: { name, description: 'Demo sector' }, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } });
  state.data.prospecting = {
    demo: true, fileName: 'Demo prospects', importedAt: todayISO(), prospects,
    areas: [box('Secteur Nord', 4.80, 45.79, 4.93, 45.90), box('Secteur Sud', 4.72, 45.64, 4.98, 45.73)],
  };
  state.tab = 'prospecting'; state.selectedProspectId = null; state.prospectFilter = '';
  save(); renderAll(); fitProspects();
}

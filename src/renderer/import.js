/* Client Clusters — renderer: importing client lists and adding clients by hand */
'use strict';

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
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0); // not Math.max(...): it fails on very long sheets
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
      save(); // before the address search, which can take a while
      const ok = await geocodeOne(c);
      if (ok && state.data.groups.length) assignToNearest([c], { quiet: true });
      save();
      selectClient(c.id, { pan: true });
      if (ok === true) toast(`${c.name} added${c.groupId ? ` to group ${groupById(c.groupId).number}` : ''}.`);
      else toast(`${c.name} added, but the address wasn't found. Place it on the map by hand from its card.`, { error: true });
    },
  });
}

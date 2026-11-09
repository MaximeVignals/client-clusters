/* Client Clusters — renderer: client detail panel and clients not on the map */
'use strict';

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
    } else toast(hasLoc(c) ? "Couldn't find this address. The pin stays where it is." : "Couldn't find this address. You can place the client on the map by hand.", { error: true });
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

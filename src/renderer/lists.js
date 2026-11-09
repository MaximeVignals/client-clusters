/* Client Clusters — renderer: sidebar: stats, tabs, banners, lists and selection */
'use strict';

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
  window.DesktopUI?.decorateTabs();
}

function renderBanners() {
  const d = state.derived, out = [];
  if (state.recovery) out.push(`<div class="banner">Your data could not be read. Nothing is saved until you choose what to do.<div class="acts"><button class="btn small primary" data-b="recover">Recover…</button></div></div>`);
  if (state.tab === 'prospecting') { $('#banners').innerHTML = out.join(''); return; }
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
  if (act === 'recover') recoveryDialog();
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
        <span class="side"><span class="size${info.members.length > S().flexSize || (info.members.length > max && towns.length > 1) ? ' over' : ''}" title="${info.members.length > max ? (towns.length === 1 && info.members.length <= S().flexSize ? 'A bit over the usual size to keep ' + esc(towns[0]) + ' in one group' : 'More clients than the group size limit') : ''}">${info.members.length} client${info.members.length === 1 ? '' : 's'}</span>${info.homeKm !== null && info.homeKm !== undefined ? `<span class="homekm" title="From home to the middle of the group, as the crow flies">${fmtKm(info.homeKm)} from home</span>` : ''}${groupLabel(info)}${info.plannedCount ? `<span class="homekm plan-note" title="Clients of this group with a visit planned">${info.plannedCount} planned · next ${esc(fmtShort(info.nextPlanned))}</span>` : ''}</span>
      </button>`;
    if (!sel) return `<div class="group">${head}</div>`;
    const members = info.members.slice().sort((a, b) => urgencyOf(b) - urgencyOf(a) || a.name.localeCompare(b.name));
    const rows = members.map(c => memberRow(c)).join('');
    const withHours = info.members.filter(hoursOf).length;
    const openNow = info.members.filter(c => hoursOf(c) && Hours.status(hoursOf(c)).open).length;
    const spread = [towns.length > 1 ? `${towns.length} towns: ${towns.join(', ')}` : '', info.spreadKm >= 0.1 ? `all within about ${info.spreadKm < 10 ? info.spreadKm.toFixed(1) : Math.round(info.spreadKm)} km` : '',
      withHours ? `${openNow} of ${withHours} with known hours open now` : ''].filter(Boolean).join(' · ').replace(/^a/, 'A');
    return `<div class="group selected">${head}
      ${spread ? `<div class="group-meta">${esc(spread)}</div>` : ''}
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
  window.DesktopUI?.revealDetail();
  if (pan && hasLoc(c)) {
    const z = Math.max(map.getZoom(), 12);
    const overlayWidth = innerWidth < 1500 ? $('#detail').offsetWidth : 0;
    const p = map.project([c.lat, c.lng], z).add([Math.min(overlayWidth / 2, map.getSize().x / 4), 0]);
    map.setView(map.unproject(p, z), z);
  }
  const row = document.querySelector(`[data-client="${id}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

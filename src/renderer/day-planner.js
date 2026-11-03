/* Client Clusters — renderer: Planned tab: visits day by day, routes and opening hours */
'use strict';

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

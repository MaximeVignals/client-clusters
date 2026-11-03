/* Client Clusters — renderer: visit, plan-a-day, rename and route dialogs */
'use strict';

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

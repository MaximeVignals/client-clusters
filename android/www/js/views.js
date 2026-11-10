// HTML for each screen. Pure functions of App.proj / App.ui; events are handled in app.js through data-act attributes.
'use strict';

const Views = (() => {
  const { esc } = U;
  const PROSPECT_STATUS = {
    todo: { label: 'To contact', color: '#2563eb' },
    visited: { label: 'Visited', color: '#c7811a' },
    converted: { label: 'Converted', color: '#2e8a57' },
    no: { label: 'Not interested', color: '#8b8d86' },
  };
  const clients = () => Object.values(App.proj.clients);
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'fr');
  const groupColor = c => (App.proj.groups[c.groupId] && App.proj.groups[c.groupId].color) || '';
  const town = e => [e.postcode, e.city].filter(Boolean).join(' ');
  const visitList = c => Object.values(c.visits || {});

  function plannedItems() {
    const t = U.todayISO(), today = [], past = [];
    for (const c of clients()) for (const v of visitList(c)) {
      if (Visits.vStatus(v, t) !== 'planned') continue;
      if (v.date === t) today.push({ c, v }); else if (v.date < t) past.push({ c, v });
    }
    const ord = x => (Number.isFinite(x.v.order) ? x.v.order : 1e9);
    today.sort((a, b) => ord(a) - ord(b) || byName(a.c, b.c));
    past.sort((a, b) => (a.v.date < b.v.date ? 1 : a.v.date > b.v.date ? -1 : byName(a.c, b.c)));
    return { today, past };
  }

  function hoursTag(c) {
    const h = c.gbp && c.gbp.hours;
    const s = h && Hours.short(h);
    return s ? `<span class="tag ${esc(s.cls)}">${esc(s.text)}</span>` : '';
  }

  function visitRow({ c, v }, withDate, num) {
    const color = groupColor(c);
    return `<button class="row" data-act="open-client" data-id="${esc(c.id)}">
      ${num ? `<span class="num">${num}</span>` : `<span class="dot" style="background:${esc(color || '#888')}"></span>`}
      <span class="grow"><div class="name">${esc(c.name)}</div>
      <div class="sub">${withDate ? esc(U.fmtDate(v.date)) + ' · ' : ''}${esc(c.city || town(c) || c.address || '')}${v.type === 'call' ? ' · call' : ''}</div></span>
      ${hoursTag(c)}</button>`;
  }

  function today() {
    const { today: list, past } = plannedItems();
    let h = `<h2>Today · ${esc(U.fmtDate(U.todayISO()))}</h2>`;
    h += list.length ? list.map((it, i) => visitRow(it, false, Number.isFinite(it.v.order) ? it.v.order : i + 1)).join('')
      : '<div class="card muted">Nothing planned for today.</div>';
    if (past.length) h += `<h2>Unconfirmed (${past.length})</h2><p class="muted small" style="margin:0 4px 8px">Planned visits in the past. Open one to mark it done or not.</p>` + past.map(it => visitRow(it, true)).join('');
    return h;
  }

  function hoursBlock(c) {
    const hours = c.gbp && c.gbp.hours;
    if (!hours || !Hours.weekLines) return '';
    const st = Hours.status(hours);
    if (!st) return '';
    return `<h2>Opening hours</h2><div class="card"><strong class="${st.open ? '' : 'muted'}" style="color:var(--${st.open ? 'ok' : 'danger'})">${esc(st.text)}</strong>
      <div class="hours">${Hours.weekLines(hours).map(l => `<span class="muted">${esc(l.name.slice(0, 3))}</span><span>${esc(l.text)}</span>`).join('')}</div></div>`;
  }

  const STATUS_LABEL = { planned: 'Planned', done: 'Done', cancelled: "Didn't happen" };

  function visitHtml(c, v) {
    const t = U.todayISO(), st = Visits.vStatus(v, t);
    const label = st === 'planned' && v.date < t ? 'Not confirmed' : STATUS_LABEL[st] || st;
    const kind = (Visits.VISIT_TYPES[v.type || 'visit'] || 'Visit') + (v.outcome ? ' · ' + (Visits.OUTCOMES[v.outcome] || v.outcome) : '');
    let acts = '';
    if (st === 'planned') acts = `<div class="btns"><button class="btn small" data-act="visit-done" data-id="${esc(c.id)}" data-vid="${esc(v.id)}">Done</button>
      <button class="btn small sec" data-act="visit-cancel" data-id="${esc(c.id)}" data-vid="${esc(v.id)}">Didn't happen</button></div>`;
    else if (st === 'done') acts = `<div class="btns"><button class="btn small sec" data-act="visit-undo" data-id="${esc(c.id)}" data-vid="${esc(v.id)}">${v.confirmedFrom === 'planned' ? 'Undo' : 'Remove'}</button></div>`;
    else if (st === 'cancelled') acts = `<div class="btns"><button class="btn small sec" data-act="visit-replan" data-id="${esc(c.id)}" data-vid="${esc(v.id)}">Undo</button></div>`;
    return `<div class="visit" data-visit="${esc(v.id)}"><div class="head"><span>${esc(U.fmtDate(v.date))}</span><span class="tag">${esc(label)}</span></div>
      <div class="muted small">${esc(kind)}</div>${v.note ? `<div>${esc(v.note)}</div>` : ''}${acts}</div>`;
  }

  function logForm(c) {
    const opts = Object.entries(Visits.OUTCOMES).map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('');
    if (!App.ui.logOpen) return `<button class="btn sec full" data-act="log-open">Log a visit</button>`;
    return `<div class="card" id="logform"><label class="field"><span>Date</span><input type="date" id="lv-date" value="${U.todayISO()}"></label>
      <label class="field"><span>Type</span><select id="lv-type"><option value="visit">Visit</option><option value="call">Phone call</option></select></label>
      <label class="field"><span>Outcome</span><select id="lv-outcome">${opts}</select></label>
      <label class="field"><span>Note</span><textarea id="lv-note" placeholder="What happened?"></textarea></label>
      <div class="btns"><button class="btn" data-act="log-save" data-id="${esc(c.id)}">Save visit</button><button class="btn sec" data-act="log-cancel">Cancel</button></div></div>`;
  }

  function client(id) {
    const c = App.proj.clients[id];
    if (!c) return '<div class="card muted">This client no longer exists.</div>';
    const g = App.proj.groups[c.groupId];
    const phones = U.phonesOf(c);
    const visits = visitList(c).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const last = Visits.lastVisit({ visits: visitList(c) }, U.todayISO());
    return `<div class="card"><div style="font-size:1.2rem;font-weight:700">${esc(c.name)}</div>
      <div>${esc(U.addressLine(c))}</div>
      <div class="muted small">${g ? `Group ${esc(g.number)}${g.name ? ' · ' + esc(g.name) : ''}` : 'No group'}${c.tier ? ' · ' + esc(c.tier) : ''}${last ? ' · last visit ' + esc(U.fmtDate(last)) : ''}</div>
      <div class="btns">${phones.map(p => `<button class="btn sec" data-act="call" data-url="tel:${esc(p.tel)}">&#9742; ${esc(p.text)}</button>`).join('')}
      <button class="btn" data-act="navigate" data-url="${esc(U.navUrl(c))}">Navigate</button></div></div>
      ${hoursBlock(c)}
      <h2>Notes</h2><textarea id="notes" data-id="${esc(c.id)}" placeholder="Notes about this client">${esc(c.notes || '')}</textarea>
      <h2>Visits</h2>${logForm(c)}
      <div class="card" id="history">${visits.length ? visits.map(v => visitHtml(c, v)).join('') : '<span class="muted">No visits yet.</span>'}</div>`;
  }

  function prospectRows(q) {
    const list = Object.values(App.proj.prospects);
    const needle = (q || '').trim().toLowerCase();
    const match = p => !needle || [p.name, p.city, p.address, p.postcode].some(x => String(x || '').toLowerCase().includes(needle));
    let h = '';
    for (const [key, meta] of Object.entries(PROSPECT_STATUS)) {
      const items = list.filter(p => (p.status || 'todo') === key && match(p)).sort(byName);
      if (!items.length) continue;
      h += `<h2>${esc(meta.label)} (${items.length})</h2>` + items.map(p => `<button class="row" data-act="open-prospect" data-id="${esc(p.id)}">
        <span class="dot" style="background:${esc(meta.color)}"></span><span class="grow"><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.city || town(p) || p.address || '')}</div></span></button>`).join('');
    }
    return h || '<div class="card muted">No prospects.</div>';
  }

  function prospects() {
    return `<input type="search" id="psearch" placeholder="Search prospects" value="${esc(App.ui.pq || '')}" aria-label="Search prospects"><div id="plist">${prospectRows(App.ui.pq)}</div>`;
  }

  function prospect(id) {
    const p = App.proj.prospects[id];
    if (!p) return '<div class="card muted">This prospect no longer exists.</div>';
    const phones = U.phonesOf(p), cur = p.status || 'todo';
    return `<div class="card"><div style="font-size:1.2rem;font-weight:700">${esc(p.name)}</div><div>${esc(U.addressLine(p))}</div>
      <div class="btns">${phones.map(x => `<button class="btn sec" data-act="call" data-url="tel:${esc(x.tel)}">&#9742; ${esc(x.text)}</button>`).join('')}<button class="btn" data-act="navigate" data-url="${esc(U.navUrl(p))}">Navigate</button></div></div>
      <h2>Status</h2><div class="seg">${Object.entries(PROSPECT_STATUS).map(([k, m]) => `<button data-act="pstatus" data-id="${esc(p.id)}" data-status="${k}" class="${k === cur ? 'on' : ''}">${esc(m.label)}</button>`).join('')}</div>
      <h2>Notes</h2><textarea id="pnotes" data-id="${esc(p.id)}" placeholder="Notes about this prospect">${esc(p.notes || '')}</textarea>`;
  }

  function settings() {
    const st = Sync.status(), p = App.pairing;
    let host = '';
    try { host = new URL(p.url).host; } catch (e) { host = p.url || ''; }
    const ap = App.appearance;
    return `<h2>Sync</h2><div class="card"><div>Paired with <strong>${esc(p.name || 'your PC')}</strong></div><div class="muted small">${esc(host)}</div>
      <div style="margin-top:8px">Status: <strong>${esc(st.text || 'Synced')}</strong></div><div class="muted small">Last sync: ${esc(U.fmtTime(Sync.lastSyncAt()))}</div>
      <div class="btns"><button class="btn" data-act="sync-now">Sync now</button></div></div>
      <h2>Pairing</h2><div class="card"><p class="muted small" style="margin-top:0">To use another PC, scan its code or paste it here. This replaces the current pairing.</p>${pairControls()}</div>
      <h2>Appearance</h2><div class="seg" id="appearance">${['system', 'light', 'dark'].map(k => `<button data-act="appearance" data-v="${k}" class="${ap === k ? 'on' : ''}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
      <h2>This phone</h2><button class="btn danger full" data-act="disconnect">Disconnect this phone</button>
      <p class="muted small">Deletes the data stored on this phone. Your data on the PC is not affected.</p>
      <p class="muted small">Client Clusters Android 1.0.0</p>`;
  }

  function pairControls(label) {
    return `<div class="btns"><button class="btn" data-act="scan">Scan QR code</button></div>
      <label class="field"><span>Or paste the pairing code</span><textarea id="paste" rows="3" placeholder="CCSYNC1...."></textarea></label>
      <button class="btn sec full" data-act="paste-pair">${label || 'Pair with this code'}</button>`;
  }

  function welcome() {
    return `<div class="welcome"><div style="font-size:3rem">&#128205;</div><h1>Client Clusters</h1>
      <p>Your visits and clients in the field, kept in sync with the Windows app.</p>
      <ol><li>On your PC, open Client Clusters.</li><li>Go to <strong>Settings &rarr; Sync &rarr; Add a phone</strong>.</li><li>Scan the QR code here, or paste the pairing code below.</li></ol>
      <div class="card" style="text-align:left">${pairControls()}</div></div>`;
  }

  function disconnected() {
    return `<div class="welcome"><div style="font-size:3rem">&#9888;</div><h1>This phone was disconnected from the PC</h1>
      <p>The PC removed this phone from sync. Your data and any changes not yet sent are still on this phone. To keep them, create a new pairing code on the PC (Settings &rarr; Sync &rarr; Add a phone) and pair again.</p>
      <div class="card" style="text-align:left">${pairControls('Pair again with this code')}</div>
      <p class="muted small">If you do not need the data on this phone any more:</p>
      <div class="btns"><button class="btn danger" data-act="disconnect">Remove data from this phone</button></div></div>`;
  }

  return { PROSPECT_STATUS, today, client, prospects, prospectRows, prospect, settings, welcome, disconnected, groupColor };
})();

// HTML for each screen (compact layout). Pure functions of App.proj / App.ui / App.pairing / Sync.status();
// events are handled in app.js through data-act attributes. All user-visible text is French (see i18n.js).
'use strict';

const Views = (() => {
  const { esc } = U;
  const ic = Icon.svg, NB = T.NB;
  const PROSPECT_STATUS = {
    todo: { label: T.status.todo, glyph: 's-todo', mark: '○', cls: 'st-todo', color: 'var(--st-todo)' },
    visited: { label: T.status.visited, glyph: 's-visited', mark: '✓', cls: 'st-visited', color: 'var(--st-visited)' },
    converted: { label: T.status.converted, glyph: 's-converted', mark: '★', cls: 'st-converted', color: 'var(--st-converted)' },
    no: { label: T.status.no, glyph: 's-no', mark: '×', cls: 'st-no', color: 'var(--st-lost)' },
  };
  const statusKey = p => (PROSPECT_STATUS[p.status] ? p.status : 'todo');
  const clients = () => Object.values(App.proj.clients);
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'fr');
  const groupColor = c => (App.proj.groups[c.groupId] && App.proj.groups[c.groupId].color) || '';
  const town = e => [e.postcode, e.city].filter(Boolean).join(' ');
  const visitList = c => Object.values(c.visits || {});
  // Text typed but not yet saved lives in App.ui.drafts and wins over the stored value (it survives redraws and fold/unfold).
  const draft = (key, stored) => App.draftOr(key, stored);
  const isSel = (kind, id) => { const s = App.ui.sel; return !!s && s.kind === kind && s.id === id; };
  const isEmptyProject = () => !App.proj || (!Object.keys(App.proj.clients || {}).length && !Object.keys(App.proj.prospects || {}).length);
  const hasClients = () => !!App.proj && Object.keys(App.proj.clients || {}).length > 0;
  const seeOnMap = (kind, e) => (U.hasLoc(e) ? `<p class="hd-map"><button type="button" class="btn tonal" data-act="show-on-map" data-kind="${kind}" data-id="${esc(e.id)}">${ic('i-map')}${esc(T.map.see)}</button></p>` : '');
  const syncBtn = `<button type="button" class="btn" data-act="sync-now">${ic('i-sync')}${esc(T.empty.syncNow)}</button>`;
  const empty = (title, text, extra = '') => `<div class="empty"><p class="empty-t">${esc(title)}</p>${text ? `<p class="muted">${esc(text)}</p>` : ''}${extra}</div>`;

  // Prospect status: diamond (glyph + colour); the status name is always written next to it.
  const diamond = (key, cls = '') => `<span class="dia ${PROSPECT_STATUS[key].cls} ${cls}" aria-hidden="true">${ic(PROSPECT_STATUS[key].glyph)}</span>`;

  // ---------- top bar ----------
  const SYNC_ICON = { off: 'i-cloud-off', ok: 'i-check', busy: 'i-spinner', offline: 'i-cloud-off', error: 'i-alert', disconnected: 'i-alert' };
  const syncPill = state => `<span class="pill-in">${ic(SYNC_ICON[state] || 'i-check', state === 'busy' ? 'spin' : '')}<span>${esc(T.sync[state] || '')}</span></span>`;

  // ---------- Aujourd’hui ----------
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

  const TAG_CLS = { open: 'ok', soon: 'warn', later: 'warn', closed: 'danger' };
  function hoursTag(c) {
    const h = c.gbp && c.gbp.hours;
    const s = h && Hours.short(h);
    return s ? `<span class="tag ${TAG_CLS[s.cls] || ''}">${esc(T.hoursShort(s.text))}</span>` : '';
  }

  function visitRow({ c, v }, past, num) {
    const ids = `data-id="${esc(c.id)}" data-vid="${esc(v.id)}"`;
    const lead = past
      ? `<span class="datechip"><b>${esc(T.dayNum(v.date))}</b><span>${esc(T.monthShort(v.date))}</span></span>`
      : `<span class="mark"><span class="sr">Visite </span>${esc(num)}</span>`;
    const where = c.city || town(c) || c.address || '';
    const on = isSel('client', c.id);
    const main = `<button type="button" class="row-main" data-key="rm:${esc(c.id)}:${esc(v.id)}"${on ? ' aria-current="true"' : ''}>${lead}<span class="grow"><span class="name">${esc(c.name)}</span>`
      + `${where ? `<span class="sub">${esc(where)}</span>` : ''}${v.type === 'call' ? `<span class="sub">${esc(T.types.call)}</span>` : ''}${hoursTag(c)}</span></button>`;
    const done = `<button type="button" class="btn tonal" data-act="visit-done" ${ids} aria-label="Fait${NB}: ${esc(c.name)}">Fait</button>`;
    const cancel = `<button type="button" class="btn sec" data-act="visit-cancel" ${ids} aria-label="Pas eu lieu${NB}: ${esc(c.name)}">Pas eu lieu</button>`;
    return `<div class="row ${past ? 'row-past' : 'row-today'}${on ? ' sel' : ''}" data-act="open-client" data-id="${esc(c.id)}">${main}<div class="row-actions">${past ? done + cancel : done}</div></div>`;
  }

  // Paired but nothing synced yet (shared by Aujourd’hui and the Carte overlay).
  const emptyClients = () => empty(T.empty.clients, T.empty.clientsHint, syncBtn);

  function today() {
    if (isEmptyProject()) return emptyClients();
    const { today: list, past } = plannedItems();
    let h = `<div class="dayhead"><p class="date">${esc(T.fmtDay())}</p><p class="summary">${esc(T.todaySummary(list.length, past.length))}</p></div>`;
    h += `<section aria-labelledby="h-planned"><h2 id="h-planned">Prévues aujourd’hui</h2>`;
    h += list.length ? list.map((it, i) => visitRow(it, false, Number.isFinite(it.v.order) ? it.v.order : i + 1)).join('')
      : empty('Rien de prévu aujourd’hui.', `Touchez ${T.q('Noter une visite')} pour consigner une visite ou un appel.`);
    h += '</section>';
    if (past.length) {
      h += `<section aria-labelledby="h-unconfirmed"><h2 id="h-unconfirmed">À confirmer (${past.length})</h2><p class="muted small intro">Visites prévues dans le passé. Marquez-les faites ou non.</p>`
        + past.map(it => visitRow(it, true)).join('') + '</section>';
    }
    return h;
  }

  // ---------- Client ----------
  function hoursBlock(c) {
    const hours = c.gbp && c.gbp.hours;
    if (!hours || !Hours.weekLines) return '';
    const st = Hours.status(hours);
    if (!st) return '';
    const todayDow = new Date().getDay();
    return `<details class="fold" id="hours-d"${App.ui.hoursOpen ? ' open' : ''}><summary>Horaires${ic('i-chev', 'chev')}</summary>
      <p class="hstatus ${st.open ? 'ok' : 'danger'}">${esc(T.hoursStatus(st.text))}</p>
      <dl class="hours">${Hours.weekLines(hours).map(l => `<dt class="${l.day === todayDow ? 'now' : ''}">${esc(T.dayName(l.day))}</dt><dd class="${l.day === todayDow ? 'now' : ''}">${esc(T.hoursLine(l.text))}</dd>`).join('')}</dl></details>`;
  }

  function prioBadge(tier) {
    const t = String(tier || '').toUpperCase();
    if (!t) return '';
    const g = { A: 'p-a', B: 'p-b', C: 'p-c' }[t];
    return `<span class="badge">${g ? ic(g) : ''}<span>Priorité ${esc(t)}</span></span>`;
  }

  // « Groupe 3, Nord », « Groupe 3 », « Nord » or « Groupe » (never a trailing space)
  function groupLabel(g) {
    const n = g.number != null && String(g.number).trim() !== '' ? 'Groupe ' + String(g.number).trim() : '';
    const name = g.name ? String(g.name).trim() : '';
    return n && name ? n + ', ' + name : n || name || 'Groupe';
  }
  function groupChip(c) {
    const g = App.proj.groups[c.groupId];
    if (!g) return `<span class="badge"><span class="gdot none" aria-hidden="true"></span><span>Sans groupe</span></span>`;
    return `<span class="badge"><span class="gdot" style="background:${esc(g.color || '#888')}" aria-hidden="true"></span><span>${esc(groupLabel(g))}</span></span>`;
  }

  function visitHtml(c, v) {
    const t = U.todayISO(), st = Visits.vStatus(v, t);
    const label = st === 'planned' && v.date < t ? T.visitStatus.unconfirmed : T.visitStatus[st] || st;
    const cls = st === 'planned' ? 'plan' : st === 'done' ? 'ok' : '';
    const kind = [T.types[v.type || 'visit'] || T.types.visit, v.outcome ? T.outcomes[v.outcome] || v.outcome : ''].filter(Boolean).join(', ');
    const ids = `data-id="${esc(c.id)}" data-vid="${esc(v.id)}"`;
    let acts = '';
    if (st === 'planned') acts = `<div class="btns btns-sm"><button type="button" class="btn tonal sm" data-act="visit-done" ${ids}>Fait</button><button type="button" class="btn text sm" data-act="visit-cancel" ${ids}>Pas eu lieu</button></div>`;
    else if (st === 'done') acts = `<div class="btns btns-sm"><button type="button" class="btn text sm" data-act="visit-undo" ${ids}>${v.confirmedFrom === 'planned' ? 'Annuler' : 'Retirer'}</button></div>`;
    else if (st === 'cancelled') acts = `<div class="btns btns-sm"><button type="button" class="btn tonal sm" data-act="visit-replan" ${ids}>Replanifier</button></div>`;
    return `<div class="visit" data-visit="${esc(v.id)}"><div class="vhead"><span class="vdate">${esc(T.fmtDate(v.date))}</span><span class="tag ${cls}">${esc(label)}</span></div>
      <div class="muted small">${esc(kind)}</div>${v.note ? `<div class="vnote">${esc(v.note)}</div>` : ''}${acts}</div>`;
  }

  // The planned visit the bar offers to confirm: today's, else the most recent one in the past.
  function pendingVisit(c) {
    const t = U.todayISO();
    return visitList(c).filter(v => Visits.vStatus(v, t) === 'planned' && v.date <= t).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0] || null;
  }

  // Notes field. The text is the unsaved draft if there is one; a notice appears when the PC changed the note meanwhile.
  function notesBlock(kind, e) {
    const tid = kind === 'client' ? 'notes' : 'pnotes', label = 'Notes sur ce ' + (kind === 'client' ? 'client' : 'prospect');
    const v = App.noteView(kind, e.id, e.notes || '');
    const conflict = v.conflict
      ? `<div class="note-conflict" role="group" aria-labelledby="note-conflict-msg"><p id="note-conflict-msg">Cette note a été modifiée sur le PC. Votre texte n’est pas encore enregistré.</p>
        <div class="btns"><button type="button" class="btn" data-act="notes-keep" data-kind="${kind}" data-id="${esc(e.id)}">Garder mon texte</button><button type="button" class="btn sec" data-act="notes-discard" data-kind="${kind}" data-id="${esc(e.id)}">Reprendre celle du PC</button></div></div>`
      : '';
    return `<section class="sec"><h2 id="h-notes" tabindex="-1">Notes</h2><textarea id="${tid}" data-id="${esc(e.id)}" aria-label="${label}" placeholder="${label}">${esc(v.text)}</textarea>${conflict}
      <p id="notes-status" class="saved" role="status">${App.ui.notesSaved === e.id ? ic('i-check') + 'Enregistré' : ''}</p></section>`;
  }

  function client(id) {
    const c = App.proj.clients[id];
    if (!c) return empty('Ce client n’existe plus.', '');
    const visits = visitList(c).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const last = Visits.lastVisit({ visits: visitList(c) }, U.todayISO());
    const tag = hoursTag(c);
    const logBtn = pendingVisit(c) ? `<button type="button" class="btn tonal" data-act="log-open" data-id="${esc(c.id)}">${ic('i-plus')}Noter une visite</button>` : '';
    return `<div class="hd"><h2 id="detail-title" class="hd-name" tabindex="-1">${esc(c.name)}</h2>
      <div class="badges">${prioBadge(c.tier)}${groupChip(c)}</div>
      <p class="addr">${c.address ? `<span>${esc(c.address)}</span>` : ''}${town(c) ? `<span>${esc(town(c))}</span>` : ''}</p>
      ${seeOnMap('client', c)}
      ${last ? `<p class="muted small">Dernière visite${NB}: ${esc(T.fmtDate(last))}</p>` : ''}${tag ? `<p>${tag}</p>` : ''}</div>
      ${hoursBlock(c)}
      ${notesBlock('client', c)}
      <section class="sec"><div class="sec-head"><h2 id="h-history" tabindex="-1">Historique</h2>${logBtn}</div>
      <div id="history">${visits.length ? visits.map(v => visitHtml(c, v)).join('') : `<p class="muted">Aucune visite pour l’instant. Touchez ${T.q('Noter une visite')} pour en ajouter une.</p>`}</div></section>`;
  }

  // Nothing to navigate to without coordinates or an address.
  const canNavigate = e => U.hasLoc(e) || !!U.addressLine(e);
  const navBtn = (e, label) => !canNavigate(e) ? '' : `<button type="button" class="btn icon" data-act="navigate" data-url="${esc(U.navUrl(e))}" aria-label="${label}" title="${label}">${ic('i-nav')}</button>`;
  function callBtn(e, coll, label, withText) {
    const phones = U.phonesOf(e);
    if (!phones.length) return '';
    const text = withText ? `${ic('i-phone')}<span>${label}</span>` : ic('i-phone');
    const cls = withText ? 'btn tonal' : 'btn icon';
    if (phones.length === 1) return `<button type="button" class="${cls}" data-act="call" data-url="tel:${esc(phones[0].tel)}" aria-label="${label}" title="${label}">${text}</button>`;
    return `<button type="button" class="${cls}" data-act="call-choose" data-coll="${coll}" data-id="${esc(e.id)}" aria-label="${label}" title="${label}">${text}</button>`;
  }

  function clientBar(id) {
    const c = App.proj.clients[id];
    if (!c) return '';
    const pend = pendingVisit(c);
    const main = pend
      ? `<button type="button" class="btn grow" data-act="visit-done" data-id="${esc(c.id)}" data-vid="${esc(pend.id)}">Fait</button>`
        + `<button type="button" class="btn sec grow" data-act="visit-cancel" data-id="${esc(c.id)}" data-vid="${esc(pend.id)}">Pas eu lieu</button>`
      : `<button type="button" class="btn grow" data-act="log-open" data-id="${esc(c.id)}">${ic('i-plus')}Noter une visite</button>`;
    return main + callBtn(c, 'clients', 'Appeler', false) + navBtn(c, 'Itinéraire');
  }

  // ---------- Prospects ----------
  const pq = () => draft('search:prospects', '');
  const prospectMatcher = q => {
    const needle = (q || '').trim().toLowerCase();
    return p => !needle || [p.name, p.city, p.address, p.postcode].some(x => String(x || '').toLowerCase().includes(needle));
  };

  function prospectChips() {
    const list = Object.values(App.proj.prospects).filter(prospectMatcher(pq()));
    const f = App.ui.pfilter || 'all';
    const chip = (key, label, n, glyph) => `<button type="button" class="fchip" data-act="pfilter" data-v="${key}" aria-pressed="${f === key}">${glyph || ''}<span>${esc(label)}</span><span class="cnt">${n}</span></button>`;
    return chip('all', 'Tous', list.length, '')
      + Object.entries(PROSPECT_STATUS).map(([k, m]) => chip(k, m.label, list.filter(p => statusKey(p) === k).length, `<span class="gl ${m.cls}" aria-hidden="true">${ic(m.glyph)}</span>`)).join('');
  }

  // Sort switch under the search field: "Nom" (grouped by status) or "Distance" (one flat list from the phone position).
  const sortMode = () => (App.ui.psort === 'dist' && Geo.last() ? 'dist' : 'name');
  function prospectSort() {
    const m = sortMode(), busy = !!App.ui.pbusy, pos = Geo.last();
    const btn = (v, label) => `<button type="button" data-act="psort" data-v="${v}" aria-pressed="${m === v}" class="${m === v ? 'on' : ''}">${esc(label)}</button>`;
    let line = '';
    if (busy) line = `<p class="geo-line">${ic('i-spinner', 'spin')}<span>${esc(T.geo.locating)}</span></p>`;
    else if (m === 'dist' && pos) line = `<p class="geo-line">${ic('i-locate')}<span>${esc(T.geo.takenAt(T.fmtTime(pos.at)))}</span><button type="button" class="btn sm sec" data-act="prefresh">${esc(T.geo.refresh)}</button></p>`;
    else if (App.ui.pgeoErr) line = `<p class="geo-line err">${ic('i-alert')}<span>${esc(App.ui.pgeoErr)}</span></p>`;
    return `<div class="seg psort" role="group" aria-label="${esc(T.geo.sortBy)}">${btn('name', T.geo.byName)}${btn('dist', T.geo.byDistance)}</div>${line}`;
  }

  const prospectRow = (p, key, meta, dist) => `<button type="button" class="row row-p${isSel('prospect', p.id) ? ' sel' : ''}" data-act="open-prospect" data-id="${esc(p.id)}"${isSel('prospect', p.id) ? ' aria-current="true"' : ''}>${diamond(key)}<span class="grow"><span class="name">${esc(p.name)}</span>`
    + `<span class="sub">${esc(p.city || town(p) || p.address || '')}</span><span class="sub stext ${meta.cls}">${esc(meta.label)}</span></span>${dist ? `<span class="dist tnum">${esc(dist)}</span>` : ''}</button>`;

  function prospectRows(q) {
    const all = Object.values(App.proj.prospects);
    if (!all.length) return empty(T.empty.prospects, T.empty.prospectsHint, syncBtn);
    const match = prospectMatcher(q), f = App.ui.pfilter || 'all';
    let h = '';
    if (sortMode() === 'dist') {
      const here = Geo.last(), shown = all.filter(p => (f === 'all' || statusKey(p) === f) && match(p));
      const withPos = shown.filter(U.hasLoc).map(p => ({ p, d: Geo.distance(here, { lat: p.lat, lng: p.lng }) })).sort((a, b) => a.d - b.d || byName(a.p, b.p));
      const without = shown.filter(p => !U.hasLoc(p)).sort(byName);
      h += withPos.map(({ p, d }) => prospectRow(p, statusKey(p), PROSPECT_STATUS[statusKey(p)], Geo.fmt(d))).join('');
      if (without.length) h += `<h2>${esc(T.geo.noPos(without.length))}</h2>` + without.map(p => prospectRow(p, statusKey(p), PROSPECT_STATUS[statusKey(p)], '')).join('');
    } else {
      for (const [key, meta] of Object.entries(PROSPECT_STATUS)) {
        if (f !== 'all' && f !== key) continue;
        const items = all.filter(p => statusKey(p) === key && match(p)).sort(byName);
        if (!items.length) continue;
        if (f === 'all') h += `<h2>${esc(meta.label)} (${items.length})</h2>`;
        h += items.map(p => prospectRow(p, key, meta, '')).join('');
      }
    }
    if (h) return h;
    if ((q || '').trim()) return empty(`Aucun prospect ne correspond à ${T.q(q.trim())}.`, '', `<button type="button" class="btn sec" data-act="clear-search">Effacer la recherche</button>`);
    return empty('Aucun prospect avec ce statut.', '', `<button type="button" class="btn sec" data-act="pfilter" data-v="all">Tout afficher</button>`);
  }

  function prospects() {
    if (!Object.keys(App.proj.prospects).length) return prospectRows('');   // nothing to search or filter
    return `<div class="sticky" id="pbar"><label class="sr" for="psearch">Rechercher un prospect</label>
      <input type="search" id="psearch" placeholder="Rechercher un prospect" autocomplete="off" value="${esc(pq())}">
      <div id="psortbar">${prospectSort()}</div><p id="pgeo-live" class="sr" role="status" aria-live="polite"></p>
      <div class="chips" id="pchips" role="group" aria-label="Filtrer par statut">${prospectChips()}</div></div><div id="plist">${prospectRows(pq())}</div>`;
  }

  function prospect(id) {
    const p = App.proj.prospects[id];
    if (!p) return empty('Ce prospect n’existe plus.', '');
    const cur = statusKey(p);
    return `<div class="hd"><h2 id="detail-title" class="hd-name" tabindex="-1">${esc(p.name)}</h2>
      <p class="addr">${p.address ? `<span>${esc(p.address)}</span>` : ''}${town(p) ? `<span>${esc(town(p))}</span>` : ''}</p>
      ${seeOnMap('prospect', p)}</div>
      <section class="sec"><h2 id="h-status">Statut</h2><div class="choices" role="group" aria-labelledby="h-status">${Object.entries(PROSPECT_STATUS).map(([k, m]) =>
        `<button type="button" aria-pressed="${k === cur}" class="choice ${m.cls}${k === cur ? ' on' : ''}" data-act="pstatus" data-id="${esc(p.id)}" data-status="${k}">${ic(m.glyph)}<span>${esc(m.label)}</span></button>`).join('')}</div></section>
      ${notesBlock('prospect', p)}`;
  }

  function prospectBar(id) {
    const p = App.proj.prospects[id];
    if (!p) return '';
    return callBtn(p, 'prospects', 'Appeler', true) + (canNavigate(p) ? `<button type="button" class="btn grow" data-act="navigate" data-url="${esc(U.navUrl(p))}">${ic('i-nav')}<span>Itinéraire</span></button>` : '');
  }

  // ---------- Réglages ----------
  function pairField() {
    return `<label class="field"><span>Ou collez le code d’appairage</span><textarea id="paste" rows="3" placeholder="CCSYNC1...." autocapitalize="off" autocomplete="off" spellcheck="false"></textarea></label>`;
  }
  function pairControls(label) {
    return `<div class="btns"><button type="button" class="btn grow" data-act="scan">Scanner le code QR</button></div>${pairField()}
      <button type="button" class="btn sec full" data-act="paste-pair">${label || 'Appairer avec ce code'}</button>`;
  }

  function settings() {
    const st = Sync.status(), p = App.pairing;
    let host = '';
    try { host = new URL(p.url).host; } catch (e) { host = p.url || ''; }
    const ap = App.appearance;
    const state = T.sync[st.state] ? st.state : 'off';
    const raw = [st.state === 'error' ? st.text : '', App.lastActionError || ''].filter(Boolean).join(' / ');
    const detail = (st.state === 'error' && st.text ? `<p class="muted small">${esc(T.syncError(st.text))}</p>` : '')
      + (raw ? `<details class="fold"><summary>Détails${ic('i-chev', 'chev')}</summary><p class="muted small">${esc(raw)}</p></details>` : '');
    return `<section class="group" aria-labelledby="h-sync"><h2 id="h-sync">Synchronisation</h2>
      <p class="statusline ${state}">${ic(SYNC_ICON[state], state === 'busy' ? 'spin' : '')}<span>${esc(T.sync[state])}</span></p>${detail}
      <p class="muted">Dernière synchro${NB}: ${esc(T.fmtRelative(Sync.lastSyncAt()))}</p>
      <button type="button" class="btn tonal full" data-act="sync-now">${ic('i-sync')}${esc(st.state === 'error' ? T.empty.retry : T.empty.syncNow)}</button></section>
      <section class="group" aria-labelledby="h-look"><h2 id="h-look">Apparence</h2>
      <div class="seg" id="appearance" role="group" aria-labelledby="h-look">${[['light', 'Clair'], ['dark', 'Sombre'], ['system', 'Système']].map(([k, l]) =>
        `<button type="button" aria-pressed="${ap === k}" data-act="appearance" data-v="${k}" class="${ap === k ? 'on' : ''}">${l}</button>`).join('')}</div></section>
      <section class="group" aria-labelledby="h-phone"><h2 id="h-phone">Ce téléphone</h2>
      <p>Appairé avec <strong>${esc(p.name || 'votre PC')}</strong></p><p class="muted small">${esc(host)}</p>
      <details class="fold" id="pair-d"${App.ui.pairOpen ? ' open' : ''}><summary>Appairer avec un autre PC${ic('i-chev', 'chev')}</summary>
        <p class="muted small">Scannez le code d’un autre PC ou collez-le ici. Cela remplace l’appairage actuel.</p>${pairControls()}</details>
      <button type="button" class="btn danger-text full" data-act="disconnect">Déconnecter ce téléphone</button>
      <p class="muted small">Supprime les données stockées sur ce téléphone, y compris les changements pas encore envoyés au PC. Vos données sur le PC ne sont pas touchées.</p></section>
      <section class="group" aria-labelledby="h-about"><h2 id="h-about">À propos</h2><p class="muted">Client Clusters Android 1.2.0</p></section>`;
  }

  // ---------- Accueil / Déconnecté ----------
  function welcome() {
    return `<div class="welcome">${ic('i-pin', 'big')}<h2 class="wtitle">Client Clusters</h2>
      <p>Vos visites et vos clients sur le terrain, synchronisés avec l’application Windows.</p>
      <ol><li>Sur votre PC, ouvrez Client Clusters.</li><li>Allez dans ${T.q('Settings')}, puis ${T.q('Sync')}, puis ${T.q('Add a phone…')}.</li><li>Scannez le code QR ici, ou collez le code d’appairage ci-dessous.</li></ol>
      ${pairField()}</div>`;
  }

  // The phone's data could not be read at start: plain words and the one action that exists (delete the data, pair again).
  function fatal(detail) {
    return `<div class="welcome">${ic('i-alert', 'big')}<h2 class="wtitle">Les données de ce téléphone n’ont pas pu être lues.</h2>
      <p>Fermez puis rouvrez l’application. Si ce message revient, supprimez les données de ce téléphone puis appairez-le à nouveau${NB}: elles reviendront du PC à la prochaine synchronisation. Les changements pas encore envoyés au PC seront aussi supprimés.</p>
      <button type="button" class="btn danger-text full" data-act="disconnect">Supprimer les données de ce téléphone</button>
      ${detail ? `<details class="fold"><summary>Détails techniques${ic('i-chev', 'chev')}</summary><p class="muted small">${esc(detail)}</p></details>` : ''}</div>`;
  }

  function disconnected() {
    return `<div class="welcome">${ic('i-alert', 'big')}<h2 class="wtitle">Ce téléphone a été déconnecté du PC</h2>
      <p>Le PC a retiré ce téléphone de la synchro. Vos données et les changements non envoyés sont toujours sur ce téléphone. Pour les garder, créez un nouveau code d’appairage sur le PC (${T.q('Settings')}, ${T.q('Sync')}, ${T.q('Add a phone…')}) puis appairez à nouveau.</p>
      ${pairField()}
      <p class="muted small">Si vous n’avez plus besoin des données de ce téléphone${NB}:</p>
      <button type="button" class="btn danger-text full" data-act="disconnect">Supprimer les données de ce téléphone</button></div>`;
  }

  // ---------- bottom action bar ----------
  // Detail actions (and pairing buttons). The primary list action ("Noter une visite") is fab() below.
  function bar({ mode, sel }) {
    if (mode === 'welcome' || mode === 'disconnected') {
      return `<button type="button" class="btn grow" data-act="scan">Scanner le code QR</button><button type="button" class="btn tonal grow" data-act="paste-pair">${mode === 'welcome' ? 'Appairer avec ce code' : 'Appairer à nouveau'}</button>`;
    }
    if (mode !== 'app') return '';
    if (sel && sel.kind === 'client') return clientBar(sel.id);
    if (sel && sel.kind === 'prospect') return prospectBar(sel.id);
    return '';
  }
  // Aujourd’hui's primary action: a bar in the compact dock, an extended FAB in the list pane on wider windows.
  const fab = () => `<button type="button" class="btn grow" data-act="picker-open">${ic('i-plus')}<span>Noter une visite</span></button>`;

  // ---------- panes without a selection ----------
  const detailEmpty = () => `<div class="placeholder"><p>${esc('Choisissez un client ou un prospect.')}</p></div>`;
  // The "Sur la carte" list: an empty host that map.js fills (and keeps up to date) with what is on screen.
  const mapList = () => '<div id="os-pane" class="os-pane"></div>';
  const plannedToday = () => plannedItems().today;

  // ---------- bottom sheets ----------
  const sheetHead = (title, sub) => `<div class="sheet-head"><div><h2 id="sheet-title">${esc(title)}</h2>${sub ? `<p class="muted small">${esc(sub)}</p>` : ''}</div>
    <button type="button" class="icon-btn" data-act="sheet-close" aria-label="Fermer">${ic('i-x')}</button></div>`;
  const wrapSheet = (inner, cls = '', id = '') => `<div class="scrim" data-act="sheet-close"></div><div class="sheet ${cls}"${id ? ` id="${id}"` : ''} role="dialog" aria-modal="true" aria-labelledby="sheet-title">${inner}</div>`;

  function logSheet(id) {
    const c = App.proj.clients[id];
    if (!c) return '';
    const f = k => 'log:' + id + ':' + k;
    const d = { date: draft(f('date'), U.todayISO()), type: draft(f('type'), 'visit'), outcome: draft(f('outcome'), ''), note: draft(f('note'), '') };
    const sel = (a, b) => (a === b ? ' selected' : '');
    const outcomes = Object.keys(Visits.OUTCOMES).map(k => `<option value="${esc(k)}"${sel(k, d.outcome)}>${esc(T.outcomes[k] || Visits.OUTCOMES[k])}</option>`).join('');
    return wrapSheet(`${sheetHead('Noter une visite', c.name)}
      <div class="sheet-body" id="logform-fields">
      <label class="field"><span>Date</span><input type="date" id="lv-date" value="${esc(d.date)}"></label>
      <p class="muted small hint">Une date à venir crée une visite prévue.</p>
      <label class="field"><span>Type</span><select id="lv-type"><option value="visit"${sel('visit', d.type)}>${T.types.visit}</option><option value="call"${sel('call', d.type)}>${T.types.call}</option></select></label>
      <label class="field"><span>Résultat</span><select id="lv-outcome">${outcomes}</select></label>
      <label class="field"><span>Note</span><textarea id="lv-note" placeholder="Que s’est-il passé${NB}?">${esc(d.note)}</textarea></label></div>
      <div class="sheet-foot"><button type="button" class="btn full" data-act="log-save" data-id="${esc(c.id)}">Enregistrer la visite</button></div>`, 'sheet-log', 'logform');
  }

  function pickerRows(q) {
    const needle = (q || '').trim().toLowerCase();
    const list = clients().filter(c => !needle || [c.name, c.city, c.address, c.postcode].some(x => String(x || '').toLowerCase().includes(needle))).sort(byName);
    if (!list.length) {
      return needle ? empty(`Aucun client ne correspond à ${T.q(q.trim())}.`, '') : empty('Aucun client sur ce téléphone.', '');
    }
    return list.map(c => `<button type="button" class="row row-p" data-act="pick-client" data-id="${esc(c.id)}"><span class="grow"><span class="name">${esc(c.name)}</span><span class="sub">${esc(c.city || town(c) || c.address || '')}</span></span></button>`).join('');
  }

  function pickerSheet(q) {
    return wrapSheet(`${sheetHead('Noter une visite', 'Choisissez un client')}
      <div class="sheet-body sheet-scroll"><label class="sr" for="cpick-q">Rechercher un client</label>
      <input type="search" id="cpick-q" data-autofocus placeholder="Rechercher un client" autocomplete="off" value="${esc(q || '')}">
      <div id="cpick-list">${pickerRows(q)}</div></div>`);
  }

  function callSheet(coll, id) {
    const e = App.proj[coll] && App.proj[coll][id];
    if (!e) return '';
    return wrapSheet(`${sheetHead('Appeler', e.name)}<div class="sheet-body">${U.phonesOf(e).map(p => `<button type="button" class="btn tonal full" data-act="call" data-url="tel:${esc(p.tel)}">${ic('i-phone')}<span>${esc(p.text)}</span></button>`).join('')}</div>`);
  }

  // Overlap pick-list: several items at (almost) the same spot; an accessible alternative to spiderfy.
  function pickSheet(s) {
    const items = (s.items || []).map(i => [i.kind, (i.kind === 'client' ? App.proj.clients : App.proj.prospects)[i.id]]).filter(x => x[1]);
    if (!items.length) return '';
    const orders = MapKit.todayOrders(), n = items.length;
    return wrapSheet(`${sheetHead(`${n} ${n > 1 ? 'éléments' : 'élément'} à cet endroit`)}<div class="sheet-body">${items.map(([k, e]) => MapKit.row(k, e, k === 'client' ? orders.get(e.id) : 0, isSel(k, e.id))).join('')}</div>
      <div class="sheet-foot"><button type="button" class="btn sec full" data-act="pick-spiderfy">Les écarter sur la carte</button></div>`);
  }

  function sheet(ui) {
    const s = ui.sheet;
    if (!s) return '';
    if (s.kind === 'log') return logSheet(s.id);
    if (s.kind === 'picker') return pickerSheet(s.q);
    if (s.kind === 'call') return callSheet(s.coll, s.id);
    if (s.kind === 'pick') return pickSheet(s);
    return '';
  }

  return { PROSPECT_STATUS, statusKey, diamond, syncPill, today, client, prospects, prospectChips, prospectRows, prospectSort, prospect, settings, welcome, disconnected, fatal, isEmptyProject, hasClients, emptyClients, bar, fab, detailEmpty, mapList, plannedToday, sheet, pickerRows, pendingVisit, groupColor, empty };
})();

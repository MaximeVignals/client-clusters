/* Client Clusters — renderer: opening hours from Google business pages */
'use strict';

// =====================================================================
// Opening hours from Google business pages
//  c.gbp = { status: 'linked' | 'review' | 'notfound' | 'none' | 'manual' | 'pending',
//            placeId, name, address, mapsUrl, phone, website, businessStatus, matchedBy: 'auto'|'user'|'file',
//            candidates: [...], checkedAt, hours: { periods, source: 'google'|'manual', updatedAt } }
// =====================================================================
const BLOCKING = ['KEY', 'QUOTA', 'NOKEY'];
function googleErrorText(r) {
  if (r.code === 'NOKEY') return 'Add a Google API key in Settings first.';
  if (r.code === 'QUOTA') return 'Google refused: too many requests or the daily quota is used up. Try again later.';
  if (r.code === 'KEY') return 'Google refused the API key: ' + r.error;
  if (r.code === 'NETWORK') return "Couldn't reach Google. Check the internet connection.";
  return r.error || 'Something went wrong with Google.';
}
const keepManualHours = c => (c.gbp?.hours?.source === 'manual' ? { hours: c.gbp.hours } : {});
const preciseLoc = c => hasLoc(c) && !(c.geo && c.geo.source !== 'manual' && c.geo.source !== 'file' && (c.geo.score < 0.5 || c.geo.precision === 'municipality'));
const slimCandidate = p => ({ id: p.id, name: p.name, address: p.address, lat: p.lat, lng: p.lng, mapsUrl: p.mapsUrl, type: p.type, status: p.status, sim: p.sim, dist: p.dist });

// Fetch the page's details (hours, phone, website) and link the client to it.
async function linkPlace(c, placeId, by, candidates) {
  const r = await window.api.googleDetails(placeId);
  if (r.error) return r;
  const p = r.place;
  const manual = c.gbp?.hours?.source === 'manual' ? c.gbp.hours : null;
  c.gbp = {
    status: 'linked', placeId: p.id, name: p.name, address: p.address, mapsUrl: p.mapsUrl, phone: p.phone, website: p.website,
    businessStatus: p.status, matchedBy: by, checkedAt: todayISO(),
    candidates: candidates && candidates.length > 1 ? candidates : undefined,
    // Google's hours win, except over hours the user typed in when Google has none.
    hours: p.hours && p.hours.periods.length ? { periods: p.hours.periods, source: 'google', updatedAt: todayISO() } : manual,
  };
  return { result: 'linked' };
}

async function refreshHours(c, { force } = {}) {
  const g = c.gbp;
  if (!g?.placeId) return { result: 'skipped' };
  if (g.hours?.source === 'manual' && !force) return { result: 'skipped' }; // don't overwrite hours typed by hand
  const r = await window.api.googleDetails(g.placeId);
  if (r.error) {
    if (r.code === 'NOTFOUND') { c.gbp = { ...g, status: 'notfound', placeId: null, checkedAt: todayISO() }; return { result: 'notfound' }; }
    return r;
  }
  const p = r.place;
  Object.assign(g, { name: p.name, address: p.address, mapsUrl: p.mapsUrl || g.mapsUrl, phone: p.phone, website: p.website, businessStatus: p.status, checkedAt: todayISO() });
  if (p.hours && p.hours.periods.length) g.hours = { periods: p.hours.periods, source: 'google', updatedAt: todayISO() };
  else if (g.hours?.source === 'google') g.hours = null;
  return { result: 'refreshed' };
}

// A Google Maps link (pasted, or from the imported file) → the business it points to.
async function linkFromUrl(c, url, by = 'user') {
  const r = await window.api.googleResolveLink(url);
  if (r.error) return { error: r.error, code: 'LINK' };
  if (r.placeId) {
    const x = await linkPlace(c, r.placeId, by);
    if (!x.error || BLOCKING.includes(x.code) || x.code === 'NETWORK') return x;
  }
  const lat = Number.isFinite(r.lat) ? r.lat : c.lat, lng = Number.isFinite(r.lat) ? r.lng : c.lng;
  if (!r.name && !Number.isFinite(r.lat)) return { error: "This link doesn't point to a business. Open the business in Google Maps, then Share → Copy link.", code: 'LINK' };
  const s = await window.api.googleSearch({ query: r.name || c.name, lat, lng, radius: 300 });
  if (s.error) return s;
  let best = null;
  for (const p of s.places) {
    const sim = Hours.nameSimilarity(r.name || c.name, p.name);
    const d = Number.isFinite(r.lat) && Number.isFinite(p.lat) ? Cluster.distanceKm(r, p) : 0;
    if ((r.name ? sim >= 0.5 : d < 0.05) && (!best || sim - d > best.score)) best = { p, score: sim - d };
  }
  if (!best) return { error: "Couldn't find the business from this link. Try searching with its name instead.", code: 'LINK' };
  return linkPlace(c, best.p.id, by);
}

// Search Google for the client; link it when one result is a sure match, otherwise keep the results for review.
async function findGooglePage(c, { force } = {}) {
  if (c.gbp?.status === 'pending' && c.gbp.mapsUrl) {
    const r = await linkFromUrl(c, c.gbp.mapsUrl, 'file');
    if (!r.error || BLOCKING.includes(r.code) || r.code === 'NETWORK') return r;
  }
  if (!force && (c.gbp?.matchedBy === 'user' || c.gbp?.status === 'none')) return { result: 'skipped' };
  const who = { name: c.name, postcode: postcodeOf(c), address: c.address, lat: c.lat, lng: c.lng, preciseLocation: preciseLoc(c) };
  const bias = hasLoc(c) ? { lat: c.lat, lng: c.lng, radius: who.preciseLocation ? 1000 : 5000 } : {};
  const town = [postcodeOf(c), townOf(c)].filter(Boolean).join(' ');
  const queries = [...new Set([[c.name, geoQuery(c)].filter(Boolean).join(', '), town ? `${c.name} ${town}` : ''])].filter(Boolean);
  const found = new Map();
  let verdict = { match: null, candidates: [] };
  for (const q of queries) {
    const r = await window.api.googleSearch({ query: q, ...bias });
    if (r.error) return r;
    for (const p of r.places) if (!found.has(p.id)) found.set(p.id, p);
    verdict = Hours.judge(who, [...found.values()]);
    if (verdict.match || verdict.candidates.some(x => x.sim >= 0.5)) break; // good enough, save a second search
  }
  const cands = verdict.candidates.slice(0, 5).map(slimCandidate);
  if (verdict.match) return linkPlace(c, verdict.match.id, 'auto', cands);
  c.gbp = { ...keepManualHours(c), status: cands.length ? 'review' : 'notfound', candidates: cands, checkedAt: todayISO(), mapsUrl: c.gbp?.mapsUrl };
  return { result: cands.length ? 'review' : 'notfound' };
}

async function lookupGoogle(list, { refresh = false, auto = false } = {}) {
  if (!list.length) return null;
  if (state.gjob || state.geocoding) { if (!auto) toast('Please wait until the current search is finished.'); return null; }
  if (!state.googleKey.hasKey) { if (!auto) toast('Add a Google API key in Settings first.', { error: true, action: { label: 'Settings', fn: () => settingsDialog({ focus: '#s-gkey' }) } }); return null; }
  const job = state.gjob = { total: list.length, done: 0, stop: false };
  const label = refresh ? 'Updating opening hours' : 'Finding Google business pages';
  showProgress(`${label}… 0 / ${job.total}`, 0);
  const res = { linked: 0, review: 0, notfound: 0, refreshed: 0, skipped: 0 };
  let next = 0, last = Date.now(), netErrors = 0, failure = null;
  const worker = async () => {
    while (!job.stop && next < list.length) {
      const c = list[next++];
      let r;
      try { r = refresh ? await refreshHours(c) : await findGooglePage(c); } catch (e) { r = { error: e.message, code: 'ERROR' }; }
      if (r.error) {
        if (BLOCKING.includes(r.code) || (r.code === 'NETWORK' && ++netErrors >= 3)) { job.stop = true; failure = r; }
      } else res[r.result] = (res[r.result] || 0) + 1;
      job.done++;
      showProgress(`${label}… ${job.done} / ${job.total}`, job.done / job.total);
      if (Date.now() - last > 1500) { last = Date.now(); save(); renderAll(); }
    }
  };
  try { await Promise.all([worker(), worker()]); } finally { state.gjob = null; hideProgress(); }
  save(); renderAll();
  if (state.selectedClientId && !$('#detail').contains(document.activeElement)) renderDetail();
  if (failure) toast(googleErrorText(failure), { error: true });
  else if (refresh) toast(`Opening hours updated for ${res.refreshed} client${res.refreshed === 1 ? '' : 's'}${res.notfound ? `; ${res.notfound} Google page${res.notfound > 1 ? 's' : ''} no longer exist${res.notfound > 1 ? '' : 's'}` : ''}.`);
  else {
    const toCheck = res.review + res.notfound;
    toast(`${res.linked} client${res.linked === 1 ? '' : 's'} linked to their Google page${toCheck ? `, ${toCheck} to check by you` : ''}${job.done < job.total ? ' (stopped)' : ''}.`,
      toCheck ? { action: { label: 'Review', fn: () => reviewGoogle() } } : {});
  }
  return res;
}

// Runs by itself: clients never looked up (new imports), then hours that are getting old.
function autoLookupGoogle() {
  if (!state.googleKey.hasKey || state.gjob || state.geocoding || state.data.demo) return;
  const todo = state.data.clients.filter(c => notLookedUp(c) && (hasLoc(c) || c.gbp?.mapsUrl));
  const days = S().hoursRefreshDays;
  const stale = days > 0 ? state.data.clients.filter(c => c.gbp?.status === 'linked' && c.gbp.placeId && c.gbp.hours?.source !== 'manual'
    && daysSince(c.gbp.hours?.updatedAt || c.gbp.checkedAt) >= days) : [];
  (async () => {
    if (todo.length) await lookupGoogle(todo, { auto: true });
    if (stale.length && !state.gjob) await lookupGoogle(stale, { refresh: true, auto: true });
  })();
}

// ---------- Review: choose the right Google page, search again, paste a link, or type hours ----------
function reviewGoogle(ids) {
  const single = !!ids;
  const notes = {}, typed = {};
  const list = () => (single ? ids.map(clientById).filter(Boolean) : state.data.clients.filter(needsGoogleCheck).sort((a, b) => a.name.localeCompare(b.name)));
  const distTxt = d => (d === null || d === undefined ? '' : d < 1 ? `${Math.round(d * 1000 / 10) * 10} m from the client's address` : `${fmtKm(d)} from the client's address`);
  const hasKey = state.googleKey.hasKey;
  showModal({
    wide: true,
    title: single ? `Google business page — ${esc(clientById(ids[0])?.name || '')}` : 'Choose the Google business pages',
    desc: hasKey
      ? (single ? 'Pick the right business, search Google with other words, paste the link of its Google Maps page, or type the hours yourself.'
        : 'These clients couldn\'t be matched for sure. Pick the right business, search with other words, paste the link of its Google Maps page, or type the hours yourself.')
      : 'Without a Google API key the app can\'t read Google pages. You can still save the link of the Google Maps page and type the hours yourself — or add a key in Settings.',
    render: () => {
      const items = list();
      if (!items.length) return '<p style="margin:6px 0 10px">Nothing left to check. 🎉</p>';
      return items.map(c => {
        const g = c.gbp || {}, t = typed[c.id] || {}, n = notes[c.id];
        const cands = (g.candidates || []).filter(p => p.id !== g.placeId);
        const current = g.placeId ? `<div class="cand current"><div class="cand-main"><span class="pill ok">Linked now</span> <b>${esc(g.name)}</b><div class="cand-addr">${esc(g.address || '')}</div></div><div class="cand-acts"><button class="btn small ghost" data-g="view" data-url="${esc(g.mapsUrl || '')}">View on Google</button></div></div>` : '';
        const candHtml = cands.map(p => `<div class="cand">
            <div class="cand-main"><b>${esc(p.name)}</b>${p.type ? ` <span class="cand-type">${esc(p.type)}</span>` : ''}
              <div class="cand-addr">${esc(p.address)}</div>
              <div class="cand-meta">${esc(distTxt(p.dist))}${p.status === 'CLOSED_PERMANENTLY' ? ' · <b class="bad">Permanently closed</b>' : p.status === 'CLOSED_TEMPORARILY' ? ' · Temporarily closed' : ''}</div></div>
            <div class="cand-acts"><button class="btn small primary" data-g="pick" data-pid="${esc(p.id)}">This is it</button>${p.mapsUrl ? `<button class="btn small ghost" data-g="view" data-url="${esc(p.mapsUrl)}">View on Google</button>` : ''}</div>
          </div>`).join('');
        const none = !cands.length && !g.placeId && g.status !== 'pending' && g.status ? `<div class="fix-msg">${g.status === 'none' ? 'Marked as having no Google page.' : 'Google found no business with this name and address.'}</div>` : '';
        return `<div class="fix-row" data-id="${c.id}">
          <div class="fix-head"><b>${esc(c.name)}</b><span class="fix-q">${esc(geoQuery(c) || 'No address')}</span></div>
          ${current}${candHtml}${none}
          <div class="gtools">
            ${hasKey ? `<input data-k="q" value="${esc(t.q ?? [c.name, townOf(c)].filter(Boolean).join(' '))}" placeholder="Name and town to search on Google"><button class="btn small" data-g="search">Search Google</button>` : ''}
            <input data-k="url" value="${esc(t.url ?? '')}" placeholder="…or paste the link of its Google Maps page (Share → Copy link)"><button class="btn small" data-g="link">Use this link</button>
          </div>
          ${n ? `<div class="fix-msg ${n.ok ? 'ok' : 'bad'}">${esc(n.text)}</div>` : ''}
          <div class="fix-acts">
            <button class="btn small ghost" data-g="maps">Look it up in Google Maps</button>
            <button class="btn small ghost" data-g="hours">${hoursOf(c) ? 'Edit hours by hand' : 'Enter hours by hand'}</button>
            ${g.status !== 'none' ? '<button class="btn small ghost" data-g="none">It has no Google page</button>' : ''}
            ${single ? '' : '<button class="btn small ghost" data-g="open">Open client card</button>'}
          </div>
        </div>`;
      }).join('');
    },
    buttons: [{ label: 'Close', action: 'close' }],
    onInput(e) {
      const row = e.target.closest('.fix-row'), k = e.target.dataset.k;
      if (row && k) (typed[row.dataset.id] = typed[row.dataset.id] || {})[k] = e.target.value;
    },
    onClose: () => { save(); renderAll(); renderDetail(); },
    async onClick(e, box, close, rerender) {
      const b = e.target.closest('[data-g]');
      if (!b) return;
      const row = b.closest('.fix-row');
      const c = row && clientById(row.dataset.id);
      if (!c) return;
      const act = b.dataset.g;
      const busy = txt => { b.disabled = true; b.textContent = txt; };
      const done = (r, okText) => {
        if (r.error) notes[c.id] = { ok: false, text: googleErrorText(r) };
        else if (r.result === 'linked') {
          delete notes[c.id];
          toast(`${c.name} → ${c.gbp.name}${okText || ''}${hoursOf(c) ? '' : ' (Google has no opening hours for it)'}.`);
          if (single) { close(); return; }
        }
        save(); renderAll(); rerender();
      };
      if (act === 'view' && b.dataset.url) window.api.openExternal(b.dataset.url);
      if (act === 'maps') window.api.openExternal('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([c.name, geoQuery(c)].filter(Boolean).join(', ')));
      if (act === 'open') { close(); state.tab = 'clients'; selectClient(c.id, { pan: true }); }
      if (act === 'pick') { busy('Linking…'); done(await linkPlace(c, b.dataset.pid, 'user', c.gbp?.candidates)); }
      if (act === 'search') {
        const q = (typed[c.id]?.q ?? row.querySelector('[data-k="q"]').value).trim();
        if (!q) return;
        busy('Searching…');
        const r = await window.api.googleSearch({ query: q, lat: c.lat, lng: c.lng, radius: preciseLoc(c) ? 2000 : 8000 });
        if (r.error) { done(r); return; }
        const v = Hours.judge({ name: c.name, postcode: postcodeOf(c), address: c.address, lat: c.lat, lng: c.lng, preciseLocation: preciseLoc(c) }, r.places);
        c.gbp = { ...(c.gbp || {}), status: c.gbp?.placeId ? 'linked' : v.candidates.length ? 'review' : 'notfound', candidates: v.candidates.slice(0, 5).map(slimCandidate), checkedAt: todayISO() };
        notes[c.id] = v.candidates.length ? { ok: true, text: `${v.candidates.length} result${v.candidates.length > 1 ? 's' : ''} for “${q}”.` } : { ok: false, text: `Nothing found for “${q}”.` };
        save(); rerender();
      }
      if (act === 'link') {
        const url = (typed[c.id]?.url ?? row.querySelector('[data-k="url"]').value).trim();
        if (!/^https?:\/\//i.test(url)) { notes[c.id] = { ok: false, text: 'Paste a link that starts with https:// (in Google Maps: Share → Copy link).' }; rerender(); return; }
        if (!hasKey) {
          c.gbp = { ...keepManualHours(c), status: 'manual', mapsUrl: url, matchedBy: 'user', checkedAt: todayISO() };
          toast(`Link saved for ${c.name}. Type its hours so they show in the app.`);
          close(); editHours(c, single ? null : () => reviewGoogle());
          return;
        }
        busy('Reading link…');
        done(await linkFromUrl(c, url, 'user'));
      }
      if (act === 'hours') { close(); editHours(c, single ? null : () => reviewGoogle()); }
      if (act === 'none') {
        c.gbp = { ...keepManualHours(c), status: hoursOf(c) ? 'manual' : 'none', mapsUrl: undefined, checkedAt: todayISO() };
        toast(`${c.name}: marked as having no Google page.`);
        if (single) { close(); return; }
        save(); renderAll(); rerender();
      }
    },
  });
}

// ---------- Typing opening hours by hand ----------
function editHours(c, after) {
  const lines = Hours.toLines(hoursOf(c));
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  let errDay = -1;
  const apply = hours => {
    c.gbp = { ...(c.gbp || {}), hours };
    if (c.gbp.status !== 'linked') c.gbp.status = hours ? 'manual' : (c.gbp.mapsUrl ? 'manual' : 'none');
    delete c.gbp.candidates;
    save(); renderAll(); renderDetail();
  };
  showModal({
    title: `Opening hours — ${esc(c.name)}`,
    desc: 'For each day, type the opening times, e.g. <b>9:00–12:00, 14:00–18:30</b> or <b>9h-12h 14h-18h30</b>. Leave a day empty when it is closed.',
    render: () => `
      <div class="hours-edit">${DAYS.map((d, i) => `<label for="h-${i}">${d}</label><input id="h-${i}" data-day="${i}" value="${esc(lines[i] === 'Closed' ? '' : lines[i])}" placeholder="Closed"${i === errDay ? ' class="bad"' : ''}>`).join('')}</div>
      <div style="margin-top:8px"><button class="btn small ghost" data-h="copy">Copy Monday to Tuesday–Friday</button></div>
      ${c.gbp?.hours?.source === 'google' ? '<p class="note">These hours come from Google. If you change them, the app will keep your version until you click “Refresh from Google”.</p>' : ''}
      <div class="err" id="h-err"></div>`,
    buttons: [
      ...(hoursOf(c) ? [{ label: 'Remove hours', fn: close => { close(); apply(null); toast(`Opening hours removed for ${c.name}.`); } }] : []),
      { label: 'Cancel', action: 'close' },
      { label: 'Save', primary: true, action: 'ok' },
    ],
    onInput(e) {
      if (e.target.dataset.day === undefined) return;
      lines[+e.target.dataset.day] = e.target.value;
      if (+e.target.dataset.day === errDay) { errDay = -1; e.target.classList.remove('bad'); }
    },
    onClick(e, box, close, rerender) {
      if (e.target.closest('[data-h="copy"]')) { for (let i = 1; i <= 4; i++) lines[i] = lines[0]; rerender(); }
    },
    onOk(close, box) {
      let parsed;
      try { parsed = Hours.parseWeek(lines); } catch (err) {
        errDay = err.day ?? -1;
        box.querySelectorAll('.hours-edit input').forEach((inp, i) => inp.classList.toggle('bad', i === errDay));
        box.querySelector('#h-err').textContent = `${DAYS[errDay] || ''}: ${err.message}`;
        return;
      }
      if (!parsed.periods.length) { box.querySelector('#h-err').textContent = 'Type at least one opening, or use “Remove hours”.'; return; }
      close();
      apply({ periods: parsed.periods, source: 'manual', updatedAt: todayISO() });
      toast(`Opening hours saved for ${c.name}.`);
    },
    onClose: () => { if (after) setTimeout(after, 0); },
  });
}

// ---------- Overview (… menu → Opening hours) ----------
function hoursOverview() {
  const cl = state.data.clients;
  const count = f => cl.filter(f).length;
  const nGoogle = count(c => hoursOf(c)?.source === 'google'), nHand = count(c => hoursOf(c)?.source === 'manual');
  const nNoHours = count(c => c.gbp?.status === 'linked' && !hoursOf(c));
  const nReview = count(needsGoogleCheck), nNone = count(c => c.gbp?.status === 'none');
  const todo = cl.filter(c => notLookedUp(c) && (hasLoc(c) || c.gbp?.mapsUrl));
  const linked = cl.filter(c => c.gbp?.placeId && c.gbp.status === 'linked');
  const hasKey = state.googleKey.hasKey;
  showModal({
    title: 'Opening hours',
    desc: hasKey ? `Google API key saved (${esc(state.googleKey.masked)}).` : 'No Google API key yet — hours can only be typed by hand.',
    render: () => `
      <dl class="extra hours-stats">
        <dt>Hours from Google</dt><dd>${nGoogle}</dd>
        <dt>Hours typed by hand</dt><dd>${nHand}</dd>
        <dt>Google page without hours</dt><dd>${nNoHours}</dd>
        <dt>To check (no sure match)</dt><dd>${nReview}</dd>
        <dt>No Google page</dt><dd>${nNone}</dd>
        <dt>Not looked up yet</dt><dd>${todo.length}</dd>
      </dl>
      <div class="fix-acts" style="margin-top:14px">
        ${hasKey && todo.length ? `<button class="btn small primary" data-o="lookup">Look up ${todo.length} client${todo.length > 1 ? 's' : ''} on Google</button>` : ''}
        ${nReview ? `<button class="btn small${hasKey && todo.length ? '' : ' primary'}" data-o="review">Review ${nReview}…</button>` : ''}
        ${hasKey && linked.length ? `<button class="btn small" data-o="refresh">Update hours of ${linked.length} linked client${linked.length > 1 ? 's' : ''}</button>` : ''}
        <button class="btn small ghost" data-o="settings">${hasKey ? 'Google settings' : 'Add a Google API key'}</button>
      </div>
      ${hasKey ? `<p class="note">Hours are updated automatically every ${S().hoursRefreshDays || '—'} days${S().hoursRefreshDays ? '' : ' (off)'}. Each update reads one Google page per client; Google bills this beyond its monthly free allowance.</p>` : ''}`,
    buttons: [{ label: 'Close', action: 'close' }],
    onClick(e, box, close) {
      const o = e.target.closest('[data-o]')?.dataset.o;
      if (!o) return;
      close();
      if (o === 'lookup') lookupGoogle(todo);
      if (o === 'review') reviewGoogle();
      if (o === 'refresh') lookupGoogle(linked, { refresh: true });
      if (o === 'settings') settingsDialog({ focus: '#s-gkey' });
    },
  });
}

// Hours change with the clock: refresh "Open till…" labels every minute.
setInterval(() => {
  if (document.hidden || !state.data.clients.some(hoursOf)) return;
  renderList();
  if (state.selectedClientId && !$('#detail').contains(document.activeElement)) renderDetail();
}, 60000);

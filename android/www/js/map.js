// Leaflet map: clients and prospects in one cluster group, filter chips, the "Sur la carte" list, overlap handling.
// Same tiles as the desktop app. Markers are created once and updated by id (never clearLayers() after the first build).
'use strict';

const PhoneMap = (() => {
  let map = null, group = null, homeLayer = null, homeSig = '', fitted = false, shown = false;
  // The first view is fitted to the data by code ("auto"), once the container has a real size. It is refitted only when the
  // container changes size (never on a data change), until the user pans or zooms or a selection moves the map; only from
  // then on is the view remembered as the user's (App.ui.mapView).
  let auto = false, programmatic = false, fitPts = [], fitSize = '';
  const recs = new Map();        // 'client:id' | 'prospect:id' -> { key, kind, id, e, marker, sig, order, shown }
  let selKey = '';               // highlighted marker
  let reveal = null;             // { key, mode: 'pan' | 'zoom' }: a selection not made on the map asks to be brought into view
  let listTimer = 0, liveTimer = 0, liveText = '', spoken = '', lastLive = 0, pickCluster = null, dragged = false;
  const MAX_ROWS = 80;
  const visible = () => !!map && map.getContainer().clientWidth > 0 && map.getContainer().clientHeight > 0;
  const rmq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(rmq && rmq.matches);
  const keyOf = (kind, id) => kind + ':' + id;
  const STATUSES = Object.keys(Views.PROSPECT_STATUS), PRIOS = ['A', 'B', 'C'];

  // ---------- filters (App.ui.mapFilters, saved in localStorage 'mapFilters') ----------
  function defaultFilters() {
    let sp = false;   // prospects are shown only when the saved "showProspects" switch is '1'
    try { sp = localStorage.getItem('showProspects') === '1'; } catch (e) { /* ignore */ }
    return { clients: true, prospects: sp, noprio: true, status: Object.fromEntries(STATUSES.map(k => [k, true])), prio: Object.fromEntries(PRIOS.map(k => [k, true])), today: false };
  }
  function loadFilters() {
    const f = defaultFilters();
    try {
      const s = JSON.parse(localStorage.getItem('mapFilters') || 'null');
      if (s && typeof s === 'object') {
        for (const k of ['clients', 'noprio', 'today']) if (typeof s[k] === 'boolean') f[k] = s[k];   // prospects: showProspects only
        for (const k of STATUSES) if (s.status && typeof s.status[k] === 'boolean') f.status[k] = s.status[k];
        for (const k of PRIOS) if (s.prio && typeof s.prio[k] === 'boolean') f.prio[k] = s.prio[k];
      }
    } catch (e) { /* ignore */ }
    return f;
  }
  const filters = () => App.ui.mapFilters || (App.ui.mapFilters = loadFilters());
  function saveFilters() {
    try {
      localStorage.setItem('mapFilters', JSON.stringify(filters()));
      localStorage.setItem('showProspects', filters().prospects ? '1' : '0');
    } catch (e) { /* ignore */ }
  }
  const narrowed = () => {
    const f = filters();   // prospects are hidden by default, so their switch is not counted
    return (f.clients ? 0 : 1) + (f.noprio ? 0 : 1) + (f.today ? 1 : 0) + STATUSES.filter(k => !f.status[k]).length + PRIOS.filter(k => !f.prio[k]).length;
  };
  // A/B/C chips only affect their own tier; clients without a tier have their own "Sans priorité" chip.
  function passes(r) {
    const f = filters();
    if (r.kind === 'client') {
      if (!f.clients || (f.today && !r.order)) return false;
      const t = MapKit.tierOf(r.e);
      return PRIOS.includes(t) ? f.prio[t] : f.noprio;
    }
    return f.prospects && !f.today && !!f.status[Views.statusKey(r.e)];
  }

  // ---------- icons ----------
  // One icon class for markers and clusters: role, aria-label and the selected class are (re)applied every time Leaflet
  // builds or reuses the element, so they survive a marker being re-added by the cluster group or refreshed.
  const MarkerIcon = L.DivIcon.extend({
    createIcon(old) {
      const el = L.DivIcon.prototype.createIcon.call(this, old), o = this.options;
      el.setAttribute('role', 'button');
      if (o.label) el.setAttribute('aria-label', o.label);
      el.classList.toggle('is-selected', !!o.key && o.key === selKey);
      return el;
    },
  });
  function iconOpts(r) {
    return { className: 'mk-wrap mk-wrap-' + r.kind, html: MapKit.glyph(r.kind, r.e, r.order), iconSize: [48, 48], label: MapKit.label(r.kind, r.e, r.order), key: r.key };
  }
  function clusterIcon(cluster) {
    let c = 0;
    const kids = cluster.getAllChildMarkers();
    for (const m of kids) if (m.options.kind === 'client') c++;
    const n = kids.length, p = n - c;
    const size = Math.round(40 + 16 * Math.min(1, Math.log(Math.max(n, 2)) / Math.log(250)));   // 40-56px, log scale on the count
    const pct = Math.round((c / n) * 100);
    const s = Math.max(48, size);
    return new MarkerIcon({ className: 'mc-wrap', html: `<div class="mc" style="--sz:${size}px;--pc:${pct}%"><span class="mc-n">${n}</span></div>`, iconSize: [s, s], label: T.map.cluster(n, c, p, !!map && tooTight(cluster, cluster._zoom)) });
  }

  function makeMarker(r) {
    const m = L.marker([r.e.lat, r.e.lng], { icon: new MarkerIcon(iconOpts(r)), kind: r.kind, eid: r.id, keyboard: true });
    const open = () => (r.kind === 'client' ? App.openClient(r.id, { fromMap: true }) : App.openProspect(r.id, { fromMap: true }));
    m.on('click', open);
    // Keyboard and TalkBack: Enter arrives as Leaflet's 'keypress'; Space is handled for every marker and cluster in init().
    m.on('keypress', e => { const k = e.originalEvent; if (k && (k.keyCode === 13 || k.key === 'Enter')) open(); });
    return m;
  }

  // ---------- data -> markers, by id ----------
  // Adds new, removes deleted, refreshes only the icons whose markup changed, moves what moved; filters add/remove the difference.
  function sync() {
    if (!map || !App.proj) return;
    const orders = MapKit.todayOrders();
    const toAdd = [], toRemove = [], changed = [], seen = new Set(), pts = [];
    const visit = (kind, e) => {
      if (!U.hasLoc(e)) return;
      const key = keyOf(kind, e.id);
      seen.add(key);
      let r = recs.get(key);
      const order = kind === 'client' ? orders.get(e.id) || 0 : 0;
      if (!r) {
        r = { key, kind, id: e.id, e, order, marker: null, sig: '', shown: false };
        r.marker = makeMarker(r);
        r.sig = r.marker.options.icon.options.html + '|' + r.marker.options.icon.options.label;
        recs.set(key, r);
      } else {
        r.e = e; r.order = order;
        const ll = r.marker.getLatLng();
        if (ll.lat !== e.lat || ll.lng !== e.lng) r.marker.setLatLng([e.lat, e.lng]);
        const o = iconOpts(r), sig = o.html + '|' + o.label;
        if (sig !== r.sig) { r.sig = sig; r.marker.refreshIconOptions(o); if (r.shown) changed.push(r.marker); }
      }
      const pass = passes(r);
      if (pass && !r.shown) toAdd.push(r.marker); else if (!pass && r.shown) toRemove.push(r.marker);
      r.shown = pass;
      if (pass) pts.push([e.lat, e.lng]);
    };
    for (const c of Object.values(App.proj.clients)) visit('client', c);
    for (const p of Object.values(App.proj.prospects)) visit('prospect', p);
    for (const [key, r] of recs) {
      if (seen.has(key)) continue;
      if (r.shown) toRemove.push(r.marker);
      recs.delete(key);
      if (reveal && key === reveal.key) reveal = null;
    }
    if (toRemove.length) group.removeLayers(toRemove);
    if (toAdd.length) group.addLayers(toAdd);
    if (changed.length) group.refreshClusters(changed);

    const home = App.proj.settings && App.proj.settings.home;
    const hasHome = home && Number.isFinite(home.lat) && Number.isFinite(home.lng);
    const hs = hasHome ? home.lat + ',' + home.lng : '';
    if (hs !== homeSig) {
      homeSig = hs; homeLayer.clearLayers();   // the single home marker, not part of the clusters
      if (hasHome) homeLayer.addLayer(L.marker([home.lat, home.lng], { keyboard: false, interactive: false, icon: L.divIcon({ className: '', html: `<div class="hm" role="img" aria-label="Domicile">${Icon.svg('i-home')}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }));
    }
    if (hasHome) pts.push([home.lat, home.lng]);

    // Data and filter changes never move the view; only the very first fit (once the container has a size) uses them.
    fitPts = pts;
    firstFit();
    updateEmpty();
    applyReveal();
    markParent();
    scheduleList(0);
  }

  // ---------- selection ----------
  function setSel(key, on) {
    const r = key && recs.get(key);
    if (!r) return;
    const el = r.marker.getElement();
    if (el) el.classList.toggle('is-selected', on);   // an element inside a cluster does not exist yet: createIcon() applies it later
    r.marker.setZIndexOffset(on ? 1000 : 0);
  }
  // A list tap (or any selection not made on the map) asks to bring the marker into view; consumed by the next select().
  // mode 'pan': only move the map if the marker is off screen (a marker inside a cluster gets its cluster highlighted);
  // mode 'zoom': zoom just enough to get the marker out of its cluster.
  function wantReveal(sel, mode) { reveal = sel ? { key: keyOf(sel.kind, sel.id), mode: mode === 'zoom' ? 'zoom' : 'pan' } : null; }

  function applyReveal() {
    if (!reveal || !map || !group || !visible()) return;
    const r = recs.get(reveal.key);
    if (!r) return;   // not built yet: sync() calls this again
    const mode = reveal.mode;
    reveal = null;
    const ll = r.marker.getLatLng();
    if (mode === 'zoom' && r.shown && group.hasLayer(r.marker)) {
      auto = false;   // the selection moves the view: a later size change must not undo it
      run(() => group.zoomToShowLayer(r.marker, () => { if (!map.getBounds().contains(ll)) run(() => map.panTo(ll, { animate: !reduced() })); markParent(); }));
    } else if (!map.getBounds().contains(ll)) { auto = false; run(() => map.panTo(ll, { animate: !reduced() })); }
    markParent();
  }
  // The selected marker may sit inside a cluster: ring that cluster instead of zooming into it.
  function markParent() {
    if (!map || !group) return;
    map.getContainer().querySelectorAll('.is-selected-parent').forEach(n => n.classList.remove('is-selected-parent'));
    const r = selKey && recs.get(selKey);
    if (!r || !r.shown || !group.hasLayer(r.marker)) return;
    const p = group.getVisibleParent(r.marker);
    const el = p && p !== r.marker && p.getElement && p.getElement();
    if (el) el.classList.add('is-selected-parent');
  }

  // Select (or clear with no argument) the marker for a list row, a marker tap or the detail.
  function select(kind, id) {
    const prev = selKey;
    selKey = kind && id ? keyOf(kind, id) : '';
    if (!selKey || (reveal && reveal.key !== selKey)) reveal = null;
    if (!map) return;
    if (prev !== selKey) { setSel(prev, false); setSel(selKey, true); }
    markRows();
    if (selKey) { if (!reveal) reveal = { key: selKey, mode: 'pan' }; applyReveal(); } else markParent();
    scrollRowIntoView();
  }
  // "Voir sur la carte": select the item and zoom to it (also when it is already the selected one).
  function focus(kind, id) {
    if (!map) return;
    reveal = { key: keyOf(kind, id), mode: 'zoom' };
    if (selKey !== reveal.key) select(kind, id); else applyReveal();
  }

  // ---------- "Sur la carte" list ----------
  function listMode() {
    if (!visible()) return 'none';
    if (App.tab === 'map' && !$('#view').hidden && $('#os-pane')) return 'pane';   // medium/expanded: fills the list pane
    if (Layout.size() === 'compact' || document.body.dataset.lay === 'map') return 'sheet';
    return 'none';
  }
  const scroller = () => (listMode() === 'sheet' ? $('#os-list') : $('#view'));
  function scheduleList(ms) {
    clearTimeout(listTimer);
    listTimer = setTimeout(renderList, ms == null ? 150 : ms);
  }
  function setHtml(el, html) {
    if (el._h === html) return;
    el._h = html;
    const sc = el.closest('#os-list') || $('#view'), top = sc ? sc.scrollTop : 0;
    const a = document.activeElement, fk = a && el.contains(a) ? a.dataset.key : '';
    el.innerHTML = html;
    if (sc) sc.scrollTop = top;
    if (fk) { const n = el.querySelector(`[data-key="${CSS.escape(fk)}"]`); if (n) n.focus({ preventScroll: true }); }
  }
  // What the list says when it has no rows: empty project, nothing matches the filters, or the view is just empty.
  function emptyHtml() {
    if (Views.isEmptyProject()) return `<p class="muted">${U.esc(T.empty.clients)}</p>`;
    if (narrowed()) return `<p class="muted">${U.esc(T.map.emptyFilters)}</p><button type="button" class="btn sec" data-act="map-reset">${U.esc(T.map.showAll)}</button>`;
    return `<p class="muted">${U.esc(T.map.emptyView)}</p>`;
  }
  function renderList() {
    clearTimeout(listTimer); listTimer = 0;
    if (!map) return;
    const mode = listMode(), mv = $('#mapview');
    mv.dataset.os = mode;
    if (mode === 'none') return;
    const b = map.getBounds(), c = map.getCenter(), items = [];
    for (const r of recs.values()) {
      if (!r.shown) continue;
      const ll = r.marker.getLatLng();
      if (b.contains(ll)) items.push({ r, d: c.distanceTo(ll) });
    }
    const title = T.map.onMap(items.length);
    announce(title);
    if (mode === 'sheet') {
      $('#os-count').textContent = title;
      if ($('#msheet').dataset.state !== 'open') return;   // peeking: only the count; rows are built when the sheet opens
    }
    items.sort((a, z) => a.d - z.d);
    const rows = items.slice(0, MAX_ROWS).map(({ r }) => MapKit.row(r.kind, r.e, r.order, r.key === selKey)).join('')
      + (items.length > MAX_ROWS ? `<p class="muted os-more">${U.esc(T.map.more(items.length - MAX_ROWS))}</p>` : '');
    if (mode === 'sheet') setHtml($('#os-list'), rows || emptyHtml());
    else setHtml($('#os-pane'), `<h2 class="os-h">${U.esc(title)}</h2><div class="os-rows">${rows || emptyHtml()}</div>`);
  }
  // Screen readers: the count is announced politely, at most once every 2 s, and only after the map has been still for a moment.
  function announce(title) {
    liveText = title;
    clearTimeout(liveTimer); liveTimer = 0;
    if (title === spoken) return;
    liveTimer = setTimeout(() => {
      liveTimer = 0;
      const l = $('#os-live');
      if (!l || listMode() === 'none') return;
      spoken = liveText; lastLive = Date.now(); l.textContent = liveText;
    }, Math.max(700, lastLive + 2000 - Date.now()));
  }
  function markRows() {
    document.querySelectorAll('.row-os[data-key]').forEach(b => {
      const on = b.dataset.key === 'os:' + selKey;
      b.classList.toggle('sel', on);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    });
  }
  function scrollRowIntoView() {
    const mode = listMode();
    if (mode === 'none' || (mode === 'sheet' && $('#msheet').dataset.state !== 'open')) return;
    const sc = scroller(), row = selKey && sc && sc.querySelector(`[data-key="${CSS.escape('os:' + selKey)}"]`);
    if (!row) return;
    const cr = sc.getBoundingClientRect(), rr = row.getBoundingClientRect();
    let top = null;
    if (rr.top < cr.top) top = sc.scrollTop + rr.top - cr.top - 8;
    else if (rr.bottom > cr.bottom) top = sc.scrollTop + rr.bottom - cr.bottom + 8;
    if (top !== null) sc.scrollTo({ top: Math.max(0, top), behavior: reduced() ? 'auto' : 'smooth' });
  }

  // Bottom sheet (compact and medium Carte): peek = handle + count, open = about 55% with the scrollable list.
  function setSheetState(s) {
    const sh = $('#msheet');
    App.ui.mapSheet = s;
    sh.dataset.state = s;
    $('#msheet-handle').setAttribute('aria-expanded', String(s === 'open'));
    $('#os-list').inert = s !== 'open';
    if (s === 'open') { if (map) renderList(); scrollRowIntoView(); }
  }
  function initSheet() {
    const sh = $('#msheet'), hd = $('#msheet-handle');
    setSheetState(App.ui.mapSheet === 'open' ? 'open' : 'peek');
    let drag = null;
    hd.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      dragged = false;
      drag = { y: e.clientY, h: sh.offsetHeight, peek: hd.offsetHeight, max: Math.round(sh.parentElement.clientHeight * 0.55), id: e.pointerId, moved: false };
      try { hd.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    hd.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dy) < 6) return;
      drag.moved = true; sh.classList.add('dragging');
      sh.style.height = Math.max(drag.peek, Math.min(drag.max, drag.h - dy)) + 'px';
    });
    const end = e => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null;
      sh.classList.remove('dragging');
      if (!d.moved) return;
      dragged = true;   // the click that follows a drag is swallowed
      const cur = sh.offsetHeight, dy = e.clientY - d.y;
      sh.style.height = '';
      setSheetState(dy < -30 ? 'open' : dy > 30 ? 'peek' : cur > (d.peek + d.max) / 2 ? 'open' : 'peek');
    };
    hd.addEventListener('pointerup', end); hd.addEventListener('pointercancel', end);
    hd.addEventListener('click', e => { if (dragged) { dragged = false; e.stopPropagation(); e.preventDefault(); } });
    sh.addEventListener('keydown', e => { if (e.key === 'Escape' && sh.dataset.state === 'open') { setSheetState('peek'); hd.focus({ preventScroll: true }); e.stopPropagation(); } });
  }
  function toggleSheet() { setSheetState($('#msheet').dataset.state === 'open' ? 'peek' : 'open'); }

  // ---------- filter chips (built once; updated in place so focus and scroll stay put) ----------
  function buildChips() {
    $('#mf-help').textContent = T.map.todayOnly; $('#mapchip').textContent = T.map.tilesOff;
    const chip = (f, inner, aria) => `<button type="button" class="fchip mf" data-act="map-filter" data-f="${f}" aria-pressed="true"${aria ? ` aria-label="${U.esc(aria)}"` : ''}>${inner}</button>`;
    const sep = '<span class="mf-sep" aria-hidden="true"></span>';
    $('#maptools').innerHTML = `<span class="mf-badge" id="mf-badge" hidden></span><button type="button" class="fchip mf mf-reset" id="mf-reset" data-act="map-reset" hidden>${U.esc(T.map.showAll)}</button>`
      + chip('clients', U.esc(T.map.clients)) + chip('prospects', U.esc(T.map.prospects)) + sep
      + Object.entries(Views.PROSPECT_STATUS).map(([k, m]) => chip('st:' + k, `<span class="gl ${m.cls}" aria-hidden="true">${Icon.svg(m.glyph)}</span><span>${U.esc(m.label)}</span>`)).join('') + sep
      + PRIOS.map(p => chip('pr:' + p, p, 'Priorité ' + p)).join('') + chip('noprio', U.esc(T.map.noPrio)) + sep
      + chip('today', U.esc(T.map.today));
  }
  const flag = f => { const F = filters(); return f.startsWith('st:') ? F.status[f.slice(3)] : f.startsWith('pr:') ? F.prio[f.slice(3)] : F[f]; };
  // Prospects and their statuses mean nothing while "Prévues aujourd’hui" is on (only planned clients show); the statuses
  // also mean nothing while Prospects is off. Such chips stay focusable (aria-disabled) but do not react.
  function locked(f) {
    const F = filters();
    if (f === 'prospects') return F.today;
    return f.startsWith('st:') && (F.today || !F.prospects);
  }
  function updateChips() {
    const F = filters(), n = narrowed();
    document.querySelectorAll('#maptools .mf[data-f]').forEach(b => {
      b.setAttribute('aria-pressed', String(!!flag(b.dataset.f)));
      if (locked(b.dataset.f)) { b.setAttribute('aria-disabled', 'true'); if (F.today) b.setAttribute('aria-describedby', 'mf-help'); else b.removeAttribute('aria-describedby'); }
      else { b.removeAttribute('aria-disabled'); b.removeAttribute('aria-describedby'); }
    });
    $('#mf-help').hidden = !F.today;
    const badge = $('#mf-badge'), reset = $('#mf-reset');
    badge.hidden = reset.hidden = !n;
    badge.innerHTML = `${U.esc(T.map.filters)} <b class="tnum">${n}</b>`;
  }
  function toggle(f) {
    const F = filters();
    if (locked(f)) return;
    if (f.startsWith('st:')) F.status[f.slice(3)] = !F.status[f.slice(3)];
    else if (f.startsWith('pr:')) F.prio[f.slice(3)] = !F.prio[f.slice(3)];
    else if (f in F && typeof F[f] === 'boolean') F[f] = !F[f]; else return;
    afterFilter();
  }
  function reset() { App.ui.mapFilters = defaultAll(); afterFilter(); }
  const defaultAll = () => Object.assign(defaultFilters(), { prospects: true });   // "Tout afficher": everything on, prospects included; afterFilter() saves it
  function afterFilter() {
    saveFilters(); updateChips(); sync();
  }

  // ---------- overlap ----------
  // A cluster that cannot be separated by zooming (max zoom, or all children within ~30 m) opens a pick-list instead.
  // The library's own click handler is wrapped (before the group joins the map) so its zoom/spiderfy is skipped in that case.
  function tooTight(cl, z) {
    if ((Number.isFinite(z) ? z : map.getZoom()) >= map.getMaxZoom()) return true;
    const b = cl.getBounds();
    return b.getSouthWest().distanceTo(b.getNorthEast()) < 30;
  }
  function openPick(cl) {
    const nameOf = it => { const r = recs.get(keyOf(it.kind, it.id)); return String((r && r.e.name) || ''); };
    const items = cl.getAllChildMarkers().map(m => ({ kind: m.options.kind, id: m.options.eid })).sort((a, z) => nameOf(a).localeCompare(nameOf(z), 'fr'));
    pickCluster = cl;
    App.openPick(items);
  }
  function spiderfyPicked() {
    const cl = pickCluster; pickCluster = null;
    if (!cl || !map || !map.hasLayer(cl)) return;   // the cluster was rebuilt (zoom, data) while the list was open
    try { cl.spiderfy(); } catch (e) { try { cl.zoomToBounds(); } catch (err) { /* ignore */ } }
  }

  // ---------- map ----------
  function init() {
    if (map) return;
    const rm = reduced();
    App.ui.mapFilters = loadFilters();   // first, so nothing below can leave the filters unset
    map = L.map('map', { minZoom: 3, maxZoom: 19, zoomControl: false, attributionControl: true, zoomAnimation: !rm, fadeAnimation: !rm, markerZoomAnimation: !rm }).setView([46.6, 2.4], 6);
    const base = {
      'Plan IGN (France)': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png', {
        maxZoom: 19, attribution: '&copy; <a href="https://www.ign.fr/">IGN</a> Géoplateforme',
      }),
      'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }),
    };
    let name = 'Plan IGN (France)';
    try { const s = localStorage.getItem('basemap'); if (base[s]) name = s; } catch (e) { /* ignore */ }
    const tilesOff = !!(window.__DEMO__ && window.__DEMO__.tiles === 'off');   // demo only: no background, to see the offline state
    if (tilesOff) tileChip(true); else base[name].addTo(map);
    const layersCtl = L.control.layers(base, null, { position: 'topright' }).addTo(map);
    const toggleEl = layersCtl.getContainer().querySelector('.leaflet-control-layers-toggle');
    if (toggleEl) { toggleEl.setAttribute('aria-label', T.map.layers); toggleEl.title = T.map.layers; }
    map.on('baselayerchange', e => { try { localStorage.setItem('basemap', e.name); } catch (err) { /* ignore */ } });
    // If the chosen background keeps failing (offline or service down), switch to the other one once.
    // Offline there is nothing to switch to: a small chip over the map says so (the markers stay on a neutral background).
    let errors = 0, switched = false;
    const offline = () => navigator.onLine === false || Sync.status().state === 'offline';
    Object.entries(base).forEach(([n, layer]) => {
      layer.on('tileload', () => { if (!offline()) tileChip(false); });
      layer.on('tileerror', () => {
        if (!map.hasLayer(layer)) return;
        if (offline()) { tileChip(true); return; }
        if (switched || ++errors < 8) return;
        switched = true;
        const other = Object.keys(base).find(k => k !== n);
        map.removeLayer(layer); base[other].addTo(map);
        App.toast(`Le fond de carte ${T.q(n)} ne s’est pas chargé, passage à ${T.q(other)}.`);
      });
    });
    window.addEventListener('online', () => { if (!tilesOff) tileChip(false); });
    // The view (centre and zoom) lives in App.ui.mapView so it survives fold/unfold and tab changes.
    map.on('dragstart zoomstart', () => { if (!programmatic) auto = false; });
    map.on('movestart', () => { clearTimeout(liveTimer); liveTimer = 0; });   // no count announcement while the map is moving
    map.on('zoomend', markParent);
    map.on('moveend', () => {
      if (fitted && visible() && !auto) {   // before the first fit the view is meaningless; an automatic fit is not the user's view
        const c = map.getCenter();
        App.ui.mapView = { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
      }
      scheduleList();
    });
    // The container is created once and never moved or destroyed; when its size changes (fold, rotation, pane
    // layout) Leaflet re-measures and keeps the same centre and zoom (no new fitBounds).
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (!visible()) return;
        if (!fitted) { firstFit(); if (!fitted) map.invalidateSize({ pan: false }); applyReveal(); return; }   // first real size: fit now
        if (reveal) { map.invalidateSize({ pan: false }); applyReveal(); return; }   // a pending reveal (« Voir sur la carte ») wins over the refit/restore
        if (auto) { refit(); return; }
        const v = App.ui.mapView;
        map.invalidateSize({ pan: false });
        if (v) run(() => map.setView([v.lat, v.lng], v.zoom, { animate: false }));
      }).observe(map.getContainer());
    }

    group = L.markerClusterGroup({
      chunkedLoading: true, maxClusterRadius: 56, showCoverageOnHover: false, spiderfyOnMaxZoom: true, zoomToBoundsOnClick: true,
      animate: !reduced(), iconCreateFunction: clusterIcon,
      chunkProgress: (done, total) => { if (done >= total) markParent(); },   // chunked adding: ring the selected cluster once it exists
    });
    const zoomOrSpiderfy = group._zoomOrSpiderfy;
    group._zoomOrSpiderfy = function (e) {   // 'clusterclick' and 'clusterkeypress' (Enter)
      if (e.type === 'clusterclick' || (e.originalEvent && e.originalEvent.keyCode === 13)) {
        if (tooTight(e.layer)) { openPick(e.layer); return undefined; }
      }
      return zoomOrSpiderfy.call(this, e);
    };
    group.on('animationend', markParent);
    group.addTo(map);
    homeLayer = L.layerGroup().addTo(map);
    // Space activates a marker or cluster like a tap (Enter is handled by the marker and by the cluster group).
    map.getContainer().addEventListener('keydown', ev => {
      const el = ev.target;
      if ((ev.key !== ' ' && ev.key !== 'Spacebar') || !el || !el.classList || !el.classList.contains('leaflet-marker-icon') || el.getAttribute('role') !== 'button') return;
      ev.preventDefault(); el.click();
    });
    // Reduced motion can change while the app runs: Leaflet caches some of these flags at creation.
    const canZoomAnim = !!(L.DomUtil.TRANSITION && L.Browser.any3d && !L.Browser.mobileOpera), canFade = !!L.Browser.any3d;
    const applyMotion = () => {
      const on = !reduced();
      map.options.zoomAnimation = map.options.fadeAnimation = map.options.markerZoomAnimation = on;
      map._zoomAnimated = on && canZoomAnim; map._fadeAnimated = on && canFade;
      map.getContainer().classList.toggle('leaflet-fade-anim', on && canFade);
      group.options.animate = on;
    };
    if (rmq) { if (rmq.addEventListener) rmq.addEventListener('change', applyMotion); else if (rmq.addListener) rmq.addListener(applyMotion); }

    buildChips(); updateChips(); initSheet();
  }

  // Programmatic moves must not count as the user moving the map.
  function run(fn) { programmatic = true; try { fn(); } finally { programmatic = false; } }
  const sizeKey = () => { const c = map.getContainer(); return c.clientWidth + 'x' + c.clientHeight; };
  function fitAll() {
    if (!fitPts.length) return;
    run(() => { map.invalidateSize({ pan: false }); map.fitBounds(L.latLngBounds(fitPts), { padding: [32, 32], maxZoom: 13, animate: false }); });
    fitSize = sizeKey();
  }
  // The first view, done once and only when the container has a real size (> 0 x 0): a saved view if there is one, else all
  // visible markers and the home. The size is re-measured right before.
  function firstFit() {
    if (fitted || !visible()) return;
    const v = App.ui.mapView;
    if (v) { run(() => { map.invalidateSize({ pan: false }); map.setView([v.lat, v.lng], v.zoom, { animate: false }); }); auto = false; fitted = true; }
    else if (fitPts.length) { auto = true; fitAll(); fitted = true; }
  }
  // Container size changed (fold, rotation, pane layout) and the view is still the automatic one: fit again to the same data.
  function refit() {
    if (!auto || !fitted || !fitPts.length || !visible() || sizeKey() === fitSize) return;
    fitAll();
  }
  // Offline: a small chip says the background is unavailable. Not a live region (the offline state is announced by the sync pill).
  function tileChip(on) { const c = $('#mapchip'); if (c) c.hidden = !on; }
  // Empty project: an explanation and the sync button over the base map; nothing to filter.
  function updateEmpty() {
    const empty = Views.isEmptyProject(), box = $('#mapempty');
    // Expanded has the list pane, which already says it: the card only appears where there is no list pane.
    const card = empty && document.body.dataset.lay !== 'x';
    if (card && !box._h) { box._h = 1; box.innerHTML = Views.emptyClients(); }
    box.hidden = !card; $('#maptools').hidden = empty;
    $('#mf-help').hidden = empty || !filters().today;
  }

  // Data changed (commit, sync): update markers by id.
  function refresh() { sync(); }

  // Called at the end of every app render: which list (pane, sheet or none) applies may have changed.
  function afterRender() {
    if (!map) return;
    updateEmpty();
    $('#mapview').dataset.os = listMode();
    const host = $('#os-pane');
    if (host && host._h === undefined) renderList(); else scheduleList();
  }

  // Create the map on first use; later calls do nothing (data changes arrive through refresh()).
  function show() {
    init();
    updateEmpty();
    if (!shown) { shown = true; setTimeout(refresh, 0); }
    else if (!fitted) firstFit();
    else refit();   // shown again (tab, fold): fit again if the container size differs from the last fit
    requestAnimationFrame(() => { if (map && !fitted) firstFit(); });
  }
  // The pick-list sheet closed: the cluster it was about is no longer needed.
  function clearPick() { pickCluster = null; }

  return {
    show, refresh, select, focus, wantReveal, afterRender, toggle, reset, toggleSheet, spiderfyPicked, clearPick,
    get ready() { return !!map; }, get map() { return map; },
  };
})();

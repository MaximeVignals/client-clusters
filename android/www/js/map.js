// Leaflet map: clients coloured by group, prospects as an optional layer, home marker. Same tiles as the desktop app.
'use strict';

const PhoneMap = (() => {
  let map = null, clientLayer = null, prospectLayer = null, homeLayer = null, fitted = false;

  function init() {
    if (map) return;
    map = L.map('map', { zoomControl: false, attributionControl: true }).setView([46.6, 2.4], 6);
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
    base[name].addTo(map);
    L.control.layers(base, null, { position: 'topright' }).addTo(map);
    map.on('baselayerchange', e => { try { localStorage.setItem('basemap', e.name); } catch (err) { /* ignore */ } });
    // If the chosen background keeps failing (offline or service down), switch to the other one once.
    let errors = 0, switched = false;
    Object.entries(base).forEach(([n, layer]) => layer.on('tileerror', () => {
      if (switched || !map.hasLayer(layer) || ++errors < 8) return;
      switched = true;
      const other = Object.keys(base).find(k => k !== n);
      map.removeLayer(layer); base[other].addTo(map);
      App.toast(`The "${n}" map didn't load, switched to "${other}".`);
    }));
    clientLayer = L.layerGroup().addTo(map);
    prospectLayer = L.layerGroup();
    homeLayer = L.layerGroup().addTo(map);
    const box = $('#show-prospects');
    try { box.checked = localStorage.getItem('showProspects') === '1'; } catch (e) { /* ignore */ }
    box.addEventListener('change', () => { try { localStorage.setItem('showProspects', box.checked ? '1' : '0'); } catch (e) { /* ignore */ } refresh(); });
  }

  function refresh() {
    if (!map) return;
    clientLayer.clearLayers(); prospectLayer.clearLayers(); homeLayer.clearLayers();
    const pts = [];
    for (const c of Object.values(App.proj.clients)) {
      if (!U.hasLoc(c)) continue;
      const m = L.circleMarker([c.lat, c.lng], { radius: 11, weight: 2, color: '#fff', fillColor: Views.groupColor(c) || '#888', fillOpacity: 0.95 });
      m.on('click', () => App.openClient(c.id));
      m.bindTooltip(c.name || '');
      clientLayer.addLayer(m); pts.push([c.lat, c.lng]);
    }
    const show = $('#show-prospects').checked;
    if (show) prospectLayer.addTo(map); else map.removeLayer(prospectLayer);
    for (const p of Object.values(App.proj.prospects)) {
      if (!U.hasLoc(p)) continue;
      const meta = Views.PROSPECT_STATUS[p.status || 'todo'] || Views.PROSPECT_STATUS.todo;
      const m = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: `<div class="pm" style="background:${meta.color}"></div>`, iconSize: [20, 20], iconAnchor: [10, 10] }) });
      m.on('click', () => App.openProspect(p.id));
      prospectLayer.addLayer(m);
      if (show) pts.push([p.lat, p.lng]);
    }
    const home = App.proj.settings && App.proj.settings.home;
    if (home && Number.isFinite(home.lat) && Number.isFinite(home.lng)) {
      homeLayer.addLayer(L.marker([home.lat, home.lng], { icon: L.divIcon({ className: '', html: '<div class="hm">&#8962;</div>', iconSize: [26, 26], iconAnchor: [13, 13] }) }));
      pts.push([home.lat, home.lng]);
    }
    if (!fitted && pts.length) { map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 14 }); fitted = true; }
  }

  function show() { init(); setTimeout(() => { map.invalidateSize(); refresh(); }, 0); }

  return { show, refresh, get ready() { return !!map; } };
})();

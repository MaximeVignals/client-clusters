// Client Clusters — main process
// Handles windows, files on disk (data, import, export) and address geocoding.
const { app, BrowserWindow, ipcMain, dialog, shell, net, Menu, session, safeStorage } = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const XLSX = require('xlsx');
const JSZip = require('jszip');

const APP_UA = 'ClientClusters/1.0 (desktop app; client visit planner)';

let win = null;

// ---------- Paths ----------
function dataDir() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const dataFile = () => path.join(dataDir(), 'clients.json');
const cacheFile = () => path.join(dataDir(), 'geocode-cache.json');
const backupDir = () => {
  const d = path.join(dataDir(), 'backups');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// One backup per day, keep the 14 most recent.
function dailyBackup() {
  try {
    if (!fs.existsSync(dataFile())) return;
    const day = new Date().toISOString().slice(0, 10);
    const target = path.join(backupDir(), `clients-${day}.json`);
    if (!fs.existsSync(target)) fs.copyFileSync(dataFile(), target);
    const files = fs.readdirSync(backupDir()).filter(f => /^clients-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (files.length > 14) fs.unlinkSync(path.join(backupDir(), files.shift()));
  } catch (e) { console.error('Backup failed', e); }
}

// ---------- Window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 980,
    minHeight: 620,
    title: 'Client Clusters',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#f6f5f2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged, // developer tools only when running from source
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Open external links in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    // Map tile servers ask apps to identify themselves (OpenStreetMap tile usage policy).
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: ['https://tile.openstreetmap.org/*', 'https://data.geopf.fr/*'] },
      (details, cb) => { details.requestHeaders['User-Agent'] = APP_UA; cb({ requestHeaders: details.requestHeaders }); });
    dailyBackup();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

// ---------- Data ----------
ipcMain.handle('data:load', () => {
  try {
    if (!fs.existsSync(dataFile())) return null;
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
  } catch (e) {
    return { __error: 'Could not read the data file: ' + e.message };
  }
});

ipcMain.handle('data:save', (_e, data) => {
  writeAtomic(dataFile(), JSON.stringify(data, null, 1));
  return true;
});

ipcMain.handle('data:openFolder', () => shell.openPath(dataDir()));

// ---------- Import (Excel / CSV) ----------
function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.slice(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Excel on French Windows saves CSV in Windows-1252
    return new TextDecoder('windows-1252').decode(buf);
  }
}

function parseCsv(text) {
  const firstLine = text.split(/\r?\n/).find(l => l.trim()) || '';
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  const sep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function cellToString(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    if (isNaN(v)) return '';
    // SheetJS returns dates at local midnight; shift by 12h to avoid timezone day slips
    const d = new Date(v.getTime() + 12 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

async function openTableOrMap(title, filter) {
  const r = await dialog.showOpenDialog(win, {
    title,
    filters: [filter, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return readTableOrMap(r.filePaths[0]);
}

ipcMain.handle('import:open', () => openTableOrMap('Choose your client list',
  { name: 'Excel, CSV or Google Earth (KMZ/KML)', extensions: ['xlsx', 'xlsm', 'xls', 'ods', 'csv', 'txt', 'kmz', 'kml'] }));

// Prospecting map: same formats, plus GeoJSON (parsed in the window).
ipcMain.handle('prospect:open', () => openTableOrMap('Choose your prospecting file',
  { name: 'Excel, CSV, KMZ/KML or GeoJSON', extensions: ['xlsx', 'xlsm', 'xls', 'ods', 'csv', 'txt', 'kmz', 'kml', 'geojson', 'json'] }));

async function readTableOrMap(file) {
  const ext = path.extname(file).toLowerCase();
  const buf = fs.readFileSync(file);
  if (ext === '.geojson' || ext === '.json') return { fileName: path.basename(file), geojson: decodeText(buf) };
  // KMZ = zipped KML. The KML (XML) is parsed in the window, which has an XML parser.
  if (ext === '.kml') return { fileName: path.basename(file), kml: decodeText(buf) };
  if (ext === '.kmz' || (buf[0] === 0x50 && buf[1] === 0x4b && !/\.(xlsx|xlsm|ods)$/.test(ext))) {
    const zip = await JSZip.loadAsync(buf);
    const kmls = Object.values(zip.files).filter(f => !f.dir && /\.kml$/i.test(f.name));
    const main = kmls.find(f => /(^|\/)doc\.kml$/i.test(f.name)) || kmls[0];
    if (!main) throw new Error('No KML found inside this KMZ file.');
    return { fileName: path.basename(file), kml: await main.async('string') };
  }
  let sheets = [];
  if (ext === '.csv' || ext === '.txt') {
    sheets = [{ name: path.basename(file), rows: parseCsv(decodeText(buf)) }];
  } else {
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    sheets = wb.SheetNames.map(name => ({
      name,
      rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' })
        .map(row => row.map(cellToString)),
    }));
  }
  sheets = sheets
    .map(s => ({ name: s.name, rows: s.rows.filter(row => row.some(c => String(c).trim() !== '')) }))
    .filter(s => s.rows.length > 0);
  return { fileName: path.basename(file), sheets };
}

// ---------- Export ----------
ipcMain.handle('export:kmz', async (_e, { kml, defaultName }) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Export for Google Earth / My Maps',
    defaultPath: defaultName || 'clients.kmz',
    filters: [{ name: 'Google Earth (KMZ)', extensions: ['kmz'] }, { name: 'KML', extensions: ['kml'] }],
  });
  if (r.canceled || !r.filePath) return null;
  if (/\.kml$/i.test(r.filePath)) fs.writeFileSync(r.filePath, kml, 'utf8');
  else {
    const zip = new JSZip();
    zip.file('doc.kml', kml);
    fs.writeFileSync(r.filePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  }
  shell.showItemInFolder(r.filePath);
  return r.filePath;
});

ipcMain.handle('export:xlsx', async (_e, { sheets, defaultName }) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Export to Excel',
    defaultPath: defaultName || 'clients.xlsx',
    filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    // ISO dates become real Excel dates so they can be sorted and filtered.
    const rows = s.rows.map(r => r.map(v => {
      const m = typeof v === 'string' && v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : v;
    }));
    const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true, dateNF: 'dd/mm/yyyy' });
    ws['!cols'] = (s.widths || []).map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  XLSX.writeFile(wb, r.filePath);
  shell.showItemInFolder(r.filePath);
  return r.filePath;
});

// ---------- Geocoding ----------
// 1) French national address service (IGN Géoplateforme) — fast, very accurate for France.
// 2) OpenStreetMap Nominatim as a fallback for other countries (max 1 request/second).
let geoCache = null;
function loadCache() {
  if (geoCache) return geoCache;
  try { geoCache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { geoCache = {}; }
  return geoCache;
}
let cacheTimer = null;
function saveCacheSoon() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    try { writeAtomic(cacheFile(), JSON.stringify(geoCache)); } catch (e) { console.error(e); }
  }, 1500);
}

async function getJson(url) {
  const res = await net.fetch(url, { headers: { 'User-Agent': APP_UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function geocodeIGN(q, postcode) {
  let url = 'https://data.geopf.fr/geocodage/search?limit=1&q=' + encodeURIComponent(q.slice(0, 200));
  if (/^\d{5}$/.test(postcode || '')) url += '&postcode=' + postcode;
  const j = await getJson(url);
  const f = j && j.features && j.features[0];
  if (!f) return null;
  const [lng, lat] = f.geometry.coordinates;
  const p = f.properties || {};
  return { lat, lng, label: p.label || q, score: p.score || 0, precision: p.type || '', source: 'IGN', city: p.city || '', postcode: p.postcode || '' };
}

let lastNominatim = 0;
let nominatimQueue = Promise.resolve();
function nominatimJson(url) {
  const request = nominatimQueue.then(async () => {
    const wait = lastNominatim + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastNominatim = Date.now();
    return getJson(url);
  });
  // A failed request must not block subsequent forward or reverse lookups.
  nominatimQueue = request.catch(() => {});
  return request;
}
async function geocodeNominatim(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q=' + encodeURIComponent(q);
  const j = await nominatimJson(url);
  if (!Array.isArray(j) || !j[0]) return null;
  return {
    lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), label: j[0].display_name,
    city: townOf(j[0].address), postcode: (j[0].address && j[0].address.postcode) || '',
    score: Math.min(1, j[0].importance ? 0.5 + j[0].importance / 2 : 0.6), precision: j[0].type || '', source: 'OSM',
  };
}

function townOf(a) {
  if (!a) return '';
  return a.city || a.town || a.village || a.municipality || a.hamlet || a.suburb || '';
}

// Town name for a map position (used to name groups when clients have no city).
let revCache = null;
const revCacheFile = () => path.join(dataDir(), 'town-cache.json');
let revTimer = null;
function loadRevCache() {
  if (!revCache) { try { revCache = JSON.parse(fs.readFileSync(revCacheFile(), 'utf8')); } catch { revCache = {}; } }
  return revCache;
}
ipcMain.handle('geo:town', async (_e, { lat, lng }) => {
  loadRevCache();
  const key = lat.toFixed(4) + ',' + lng.toFixed(4);
  if (revCache[key]) return revCache[key];
  let out = null;
  try {
    const j = await getJson(`https://data.geopf.fr/geocodage/reverse?lon=${lng}&lat=${lat}&limit=1`);
    const f = j && j.features && j.features[0];
    // IGN covers France only; accept the answer if it's within ~3 km.
    if (f && f.properties && f.properties.city && (f.properties.distance === undefined || f.properties.distance < 3000)) {
      out = { city: f.properties.city, postcode: f.properties.postcode || '' };
    }
  } catch { /* try the next service */ }
  if (!out) {
    try {
      const j = await nominatimJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${lat}&lon=${lng}`);
      if (j && j.address && townOf(j.address)) out = { city: townOf(j.address), postcode: j.address.postcode || '' };
    } catch (e) { return { error: e.message }; }
  }
  if (!out) return { error: 'No town found' };
  revCache[key] = out;
  clearTimeout(revTimer);
  revTimer = setTimeout(() => { try { writeAtomic(revCacheFile(), JSON.stringify(revCache)); } catch { /* ignore */ } }, 1500);
  return out;
});

ipcMain.handle('geo:geocode', async (_e, { query, postcode, country }) => {
  const key = (query + '|' + (postcode || '') + '|' + (country || '')).toLowerCase().replace(/\s+/g, ' ').trim();
  const cache = loadCache();
  if (cache[key]) return cache[key];
  const isFrance = !country || /^(fr|france|fra)$/i.test(country.trim());
  let result = null, error = null;
  if (isFrance) {
    try { result = await geocodeIGN(query, postcode); } catch (e) { error = e.message; }
  }
  if (!result || result.score < 0.45) {
    try {
      const alt = await geocodeNominatim(query + (country && !isFrance ? ', ' + country : ''));
      if (alt && (!result || alt.score > result.score)) result = alt;
    } catch (e) { error = error || e.message; }
  }
  if (result) { cache[key] = result; saveCacheSoon(); return result; }
  return { error: error || 'Address not found' };
});

// ---------- Google business pages (Places API "New") ----------
// The API key is kept apart from clients.json (so it never ends up in a backup file) and is
// encrypted with the Windows user account when possible. Calls are made here, never in the window.
//  - search:  Text Search with "Pro" fields only (name, address, position, link) — no opening hours,
//             so matching stays in Google's cheaper, larger free tier.
//  - details: Place Details with opening hours, phone and website — called once per linked client.
const googleFile = () => path.join(dataDir(), 'google.json');
let googleKey = null;
function loadGoogleKey() {
  if (googleKey !== null) return googleKey;
  googleKey = '';
  try {
    const j = JSON.parse(fs.readFileSync(googleFile(), 'utf8'));
    if (j.enc && safeStorage.isEncryptionAvailable()) googleKey = safeStorage.decryptString(Buffer.from(j.enc, 'base64'));
    else if (j.key) {
      googleKey = j.key;
      // Plain-text key from an older version: encrypt it now when possible.
      if (safeStorage.isEncryptionAvailable()) { try { storeGoogleKey(j.key); } catch { /* keep using it */ } }
    }
  } catch { /* no key yet */ }
  return googleKey;
}
// The key is only ever written to disk encrypted. If the system can't encrypt it, it isn't saved.
// (Older versions could store it in plain text; such a file is still read, and re-saved encrypted.)
const NO_ENCRYPTION = 'This computer cannot encrypt the key (Windows data protection is unavailable), so it was not saved.';
function storeGoogleKey(key) {
  key = key || '';
  if (!key) { googleKey = ''; try { fs.unlinkSync(googleFile()); } catch { /* already gone */ } return; }
  if (!safeStorage.isEncryptionAvailable()) throw new Error(NO_ENCRYPTION);
  writeAtomic(googleFile(), JSON.stringify({ enc: safeStorage.encryptString(key).toString('base64') }));
  googleKey = key;
}
const maskKey = k => (k ? '…' + k.slice(-4) : '');

async function placesCall(method, urlPath, fieldMask, body, key = loadGoogleKey()) {
  if (!key) return { error: 'No Google API key in Settings.', code: 'NOKEY' };
  let res;
  try {
    res = await net.fetch('https://places.googleapis.com/v1/' + urlPath, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fieldMask },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { return { error: "Couldn't reach Google: " + e.message, code: 'NETWORK' }; }
  let j = null;
  try { j = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const msg = (j && j.error && j.error.message) || `HTTP ${res.status}`;
    const status = (j && j.error && j.error.status) || '';
    let code = 'ERROR';
    if (res.status === 429 || status === 'RESOURCE_EXHAUSTED') code = 'QUOTA';
    else if (/api key|api_key|has not been used|is disabled|not authorized|billing/i.test(msg) || res.status === 401 || res.status === 403) code = 'KEY';
    else if (res.status === 404) code = 'NOTFOUND';
    return { error: msg, code };
  }
  return { data: j || {} };
}

const SEARCH_FIELDS = ['id', 'displayName', 'formattedAddress', 'location', 'googleMapsUri', 'businessStatus', 'primaryTypeDisplayName']
  .map(f => 'places.' + f).join(',');
const DETAIL_FIELDS = 'id,displayName,formattedAddress,location,googleMapsUri,businessStatus,regularOpeningHours,nationalPhoneNumber,websiteUri';

const simplePlace = p => ({
  id: p.id,
  name: (p.displayName && p.displayName.text) || '',
  address: p.formattedAddress || '',
  lat: p.location ? p.location.latitude : null,
  lng: p.location ? p.location.longitude : null,
  mapsUrl: p.googleMapsUri || '',
  status: p.businessStatus || '',
  type: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || '',
});

ipcMain.handle('google:keyStatus', () => {
  const k = loadGoogleKey();
  return { hasKey: !!k, masked: maskKey(k) };
});

ipcMain.handle('google:setKey', async (_e, key) => {
  key = String(key || '').trim();
  if (!key) { storeGoogleKey(''); return { ok: true, hasKey: false }; }
  // Check the key with an "IDs only" search, which Google doesn't charge for.
  const r = await placesCall('POST', 'places:searchText', 'places.id', { textQuery: 'Mairie de Lyon', pageSize: 1 }, key);
  if (r.error) {
    let msg = r.error;
    if (/not valid/i.test(msg)) msg = 'Google says this API key is not valid. Check that it was copied in full.';
    else if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) msg = 'This key works, but “Places API (New)” is not enabled for its project. Enable it in the Google Cloud console, wait a minute, then try again.';
    else if (/billing/i.test(msg)) msg = 'Google needs a billing account on this project before the Places API can be used.';
    else if (/referer|not authorized|blocked/i.test(msg)) msg = 'This key is restricted in a way that blocks the app. In the Google Cloud console, set “Application restrictions” to None and restrict it to “Places API (New)” instead. (' + msg + ')';
    return { ok: false, error: msg };
  }
  try { storeGoogleKey(key); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, hasKey: true, masked: maskKey(key) };
});

ipcMain.handle('google:search', async (_e, { query, lat, lng, radius }) => {
  const body = { textQuery: String(query || '').slice(0, 250), pageSize: 5, languageCode: 'fr' };
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: Math.max(50, Math.min(50000, radius || 1500)) } };
  }
  const r = await placesCall('POST', 'places:searchText', SEARCH_FIELDS, body);
  if (r.error) return r;
  return { places: (r.data.places || []).map(simplePlace) };
});

ipcMain.handle('google:details', async (_e, placeId) => {
  if (!/^[\w-]+$/.test(String(placeId || ''))) return { error: 'Invalid place id', code: 'ERROR' };
  const r = await placesCall('GET', 'places/' + placeId + '?languageCode=fr', DETAIL_FIELDS);
  if (r.error) return r;
  const p = r.data;
  const roh = p.regularOpeningHours;
  return {
    place: {
      ...simplePlace(p),
      phone: p.nationalPhoneNumber || '',
      website: p.websiteUri || '',
      hours: roh && Array.isArray(roh.periods) ? { periods: roh.periods.map(x => ({ open: x.open && { day: x.open.day, hour: x.open.hour || 0, minute: x.open.minute || 0 }, close: x.close && { day: x.close.day, hour: x.close.hour || 0, minute: x.close.minute || 0 } })) } : null,
    },
  };
});

// A Google Maps link pasted by the user (or found in an imported file): find the place it points to.
function parseMapsUrl(u) {
  const out = { url: u };
  let url;
  try { url = new URL(u); } catch { return out; }
  const dec = s => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
  const pid = url.searchParams.get('query_place_id') || url.searchParams.get('place_id') || (/place_id:([\w-]+)/.exec(u) || [])[1];
  if (pid) out.placeId = pid;
  const name = /\/maps\/place\/([^/@?]+)/.exec(url.pathname);
  if (name) out.name = dec(name[1]);
  if (!out.name) { const q = url.searchParams.get('q') || url.searchParams.get('query'); if (q && !/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(q)) out.name = q; }
  const exact = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(u); // the place's own position
  const view = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(u);     // the map view's centre
  const m = exact || view;
  if (m) { out.lat = parseFloat(m[1]); out.lng = parseFloat(m[2]); }
  return out;
}

ipcMain.handle('google:resolveLink', async (_e, link) => {
  let u = String(link || '').trim();
  if (!/^https?:\/\//i.test(u)) return { error: 'This is not a web link. Copy the link from Google Maps (Share → Copy link).' };
  let host = '';
  try { host = new URL(u).hostname; } catch { return { error: 'This link could not be read.' }; }
  if (!/(^|\.)(google\.[a-z.]+|goo\.gl|g\.co|g\.page|share\.google)$/i.test(host)) return { error: 'This is not a Google Maps link.' };
  if (/goo\.gl|g\.co|g\.page|share\.google/i.test(host)) {
    // Short share link: follow it to the full Google Maps address.
    try {
      const res = await net.fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' } });
      u = res.url || u;
      // In Europe Google may redirect to its cookie-consent page; the real address is in "continue".
      const cu = new URL(u);
      if (/consent\./.test(cu.hostname) && cu.searchParams.get('continue')) u = cu.searchParams.get('continue');
      if (!/\/maps|maps\.google|[?&](q|query)=/.test(u)) {
        const html = await res.text().catch(() => '');
        const found = /https:\/\/www\.google\.[a-z.]+\/maps\/place\/[^"'\s<>]+/.exec(html);
        if (found) u = found[0].replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
      }
    } catch (e) { return { error: "Couldn't open this link: " + e.message }; }
  }
  return parseMapsUrl(u);
});

// ---------- Backups to move data between computers ----------
// A ".ccbackup" file is a zip holding:
//   manifest.json          what's inside (date, computer, app version, counts)
//   data.json              clients, visits, groups, settings (the same as clients.json)
//   geocode-cache.json     addresses already found, so the other PC doesn't search them again
//   town-cache.json        towns already looked up from map positions
//   google-key.json        optional: the Google API key, encrypted with a password chosen by the user
// Older plain ".json" backups (version 1.4/1.5) can still be restored.
const BACKUP_EXT = 'ccbackup';
let pendingRestore = null; // what was read from the last opened backup, until it's applied or another is opened

function encryptWithPassword(text, password) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return { v: 1, alg: 'aes-256-gcm', kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decryptWithPassword(o, password) {
  const key = crypto.scryptSync(password, Buffer.from(o.salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(o.iv, 'base64'));
  d.setAuthTag(Buffer.from(o.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(o.data, 'base64')), d.final()]).toString('utf8');
}
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const countVisits = data => (data.clients || []).reduce((n, c) => n + ((c.visits || []).length), 0);

ipcMain.handle('backup:save', async (_e, { data, includeKey, password }) => {
  if (!data || !Array.isArray(data.clients)) throw new Error('Nothing to back up.');
  const r = await dialog.showSaveDialog(win, {
    title: 'Save a backup of all your data',
    defaultPath: path.join(app.getPath('documents'), `Client Clusters backup ${stamp()}.${BACKUP_EXT}`),
    filters: [{ name: 'Client Clusters backup', extensions: [BACKUP_EXT] }],
  });
  if (r.canceled || !r.filePath) return null;
  const zip = new JSZip();
  const key = includeKey ? loadGoogleKey() : '';
  // The prospecting map is an optional part, in its own file.
  const { prospecting, ...rest } = data;
  data = rest;
  zip.file('manifest.json', JSON.stringify({
    app: 'Client Clusters', format: 1, appVersion: app.getVersion(), createdAt: new Date().toISOString(),
    clients: data.clients.length, visits: countVisits(data), groups: (data.groups || []).length, googleKey: !!(key && password),
    prospects: prospecting ? (prospecting.prospects || []).length : 0,
  }, null, 1));
  zip.file('data.json', JSON.stringify(data));
  if (prospecting) zip.file('prospecting.json', JSON.stringify(prospecting));
  zip.file('geocode-cache.json', JSON.stringify(loadCache()));
  zip.file('town-cache.json', JSON.stringify(loadRevCache()));
  if (key && password) zip.file('google-key.json', JSON.stringify(encryptWithPassword(key, password)));
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const tmp = r.filePath + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, r.filePath);
  // Read it back to be sure the copy on disk is complete (USB keys, cloud folders…).
  const check = await JSZip.loadAsync(fs.readFileSync(r.filePath));
  JSON.parse(await check.file('data.json').async('string'));
  shell.showItemInFolder(r.filePath);
  return { path: r.filePath, size: buf.length };
});

async function readBackupFile(file) {
  const buf = fs.readFileSync(file);
  const out = { fileName: path.basename(file), manifest: null, data: null, geocode: null, towns: null, keyBlob: null };
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    let zip;
    try { zip = await JSZip.loadAsync(buf); } catch { throw new Error('This file is damaged or is not a Client Clusters backup.'); }
    const get = async name => { const f = zip.file(name); if (!f) return null; try { return JSON.parse(await f.async('string')); } catch { return null; } };
    out.manifest = await get('manifest.json');
    out.data = await get('data.json');
    out.geocode = await get('geocode-cache.json');
    out.towns = await get('town-cache.json');
    out.keyBlob = await get('google-key.json');
    const pros = await get('prospecting.json');
    if (out.data && pros) out.data.prospecting = pros;
  } else {
    // Older backups: just the data, as JSON.
    let text = buf.toString('utf8').replace(/^﻿/, '');
    try { out.data = JSON.parse(text); } catch { throw new Error('This file is not a Client Clusters backup.'); }
    const st = fs.statSync(file);
    out.manifest = { app: 'Client Clusters', format: 0, createdAt: st.mtime.toISOString(), computer: '', appVersion: '' };
  }
  if (!out.data || !Array.isArray(out.data.clients)) throw new Error('This file is not a Client Clusters backup.');
  out.manifest = { ...out.manifest, clients: out.data.clients.length, visits: countVisits(out.data), groups: (out.data.groups || []).length,
    prospects: out.data.prospecting ? (out.data.prospecting.prospects || []).length : 0 };
  return out;
}

ipcMain.handle('backup:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Restore a backup',
    defaultPath: app.getPath('documents'),
    filters: [{ name: 'Client Clusters backup', extensions: [BACKUP_EXT, 'json'] }, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  pendingRestore = await readBackupFile(r.filePaths[0]);
  return { fileName: pendingRestore.fileName, manifest: pendingRestore.manifest, data: pendingRestore.data, hasKey: !!pendingRestore.keyBlob, thisAppVersion: app.getVersion() };
});

// The Google key from the backup, unlocked with its password (checked before any data is changed).
ipcMain.handle('backup:unlockKey', (_e, password) => {
  if (!pendingRestore || !pendingRestore.keyBlob) return { ok: false, error: 'This backup has no Google API key.' };
  try { pendingRestore.key = decryptWithPassword(pendingRestore.keyBlob, String(password || '')); return { ok: true }; } catch { return { ok: false, error: 'Wrong password for the Google API key.' }; }
});

// Called just before the data in the window is replaced or merged.
ipcMain.handle('backup:apply', (_e, { current }) => {
  if (!pendingRestore) return { ok: false };
  // 1) Safety copy of what this PC had, kept in the backups folder.
  let safety = null;
  try {
    if (current && ((Array.isArray(current.clients) && current.clients.length) || current.prospecting?.prospects?.length)) {
      const d = new Date(), p = n => String(n).padStart(2, '0');
      safety = path.join(backupDir(), `before-restore-${stamp()}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`);
      fs.writeFileSync(safety, JSON.stringify(current, null, 1), 'utf8');
    }
  } catch (e) { return { ok: false, error: 'Could not save a safety copy of the current data: ' + e.message }; }
  // 2) Address and town caches: add what the backup knows.
  if (pendingRestore.geocode && typeof pendingRestore.geocode === 'object') {
    Object.assign(loadCache(), pendingRestore.geocode); saveCacheSoon();
  }
  if (pendingRestore.towns && typeof pendingRestore.towns === 'object') {
    Object.assign(loadRevCache(), pendingRestore.towns);
    try { writeAtomic(revCacheFile(), JSON.stringify(revCache)); } catch { /* not essential */ }
  }
  // 3) Google key, if it was unlocked.
  let masked = null;
  let keyError = null;
  if (pendingRestore.key) {
    try { storeGoogleKey(pendingRestore.key); masked = maskKey(pendingRestore.key); } catch (e) { keyError = e.message; }
  }
  pendingRestore = null;
  return { ok: true, safety: safety && path.basename(safety), keyMasked: masked, keyError };
});

ipcMain.handle('app:openExternal', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

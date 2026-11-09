// Geocoding, with caches on disk.
// 1) French national address service (IGN Géoplateforme) — fast, very accurate for France.
// 2) OpenStreetMap Nominatim as a fallback for other countries (max 1 request/second).
const { ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { APP_UA, dataDir, writeAtomic } = require('./paths');

// A JSON object kept in memory and written to disk shortly after the last change.
function jsonCache(fileName) {
  const file = () => path.join(dataDir(), fileName);
  let value = null, timer = null;
  const write = () => { timer = null; try { writeAtomic(file(), JSON.stringify(value)); } catch (e) { console.error(e); } };
  return {
    get() {
      if (!value) { try { value = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { value = {}; } }
      return value;
    },
    saveSoon() {
      clearTimeout(timer);
      timer = setTimeout(write, 1500);
    },
    flush() { if (timer) { clearTimeout(timer); write(); } }, // write now what was waiting (app closing)
    cancel() { clearTimeout(timer); timer = null; },
  };
}
const geoCache = jsonCache('geocode-cache.json');
const townCache = jsonCache('town-cache.json'); // towns for map positions (to name groups when clients have no city)

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

const townOf = a => (a ? a.city || a.town || a.village || a.municipality || a.hamlet || a.suburb || '' : '');

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

ipcMain.handle('geo:town', async (_e, { lat, lng }) => {
  const cache = townCache.get();
  const key = lat.toFixed(4) + ',' + lng.toFixed(4);
  if (cache[key]) return cache[key];
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
  cache[key] = out;
  townCache.saveSoon();
  return out;
});

ipcMain.handle('geo:geocode', async (_e, { query, postcode, country }) => {
  const key = (query + '|' + (postcode || '') + '|' + (country || '')).toLowerCase().replace(/\s+/g, ' ').trim();
  const cache = geoCache.get();
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
  if (result) { cache[key] = result; geoCache.saveSoon(); return result; }
  return { error: error || 'Address not found' };
});

module.exports = { geoCache, townCache, geocodeNominatim };

// Google business pages (Places API "New").
// The API key is kept apart from clients.json (so it never ends up in a backup file) and is
// encrypted with the Windows user account when possible. Calls are made here, never in the window.
//  - search:  Text Search with "Pro" fields only (name, address, position, link) — no opening hours,
//             so matching stays in Google's cheaper, larger free tier.
//  - details: Place Details with opening hours, phone and website — called once per linked client.
const { ipcMain, net, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { dataDir, writeAtomic } = require('./paths');

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
const timePoint = t => t && { day: t.day, hour: t.hour || 0, minute: t.minute || 0 };

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
      hours: roh && Array.isArray(roh.periods) ? { periods: roh.periods.map(x => ({ open: timePoint(x.open), close: timePoint(x.close) })) } : null,
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
  // google.com, google.fr, google.co.uk, google.com.au… but not a look-alike such as google.example.com.
  const SHORT_HOST = /(^|\.)(goo\.gl|g\.co|g\.page|share\.google)$/i;
  if (!/(^|\.)google\.(com|[a-z]{2}|com?\.[a-z]{2})$/i.test(host) && !SHORT_HOST.test(host)) return { error: 'This is not a Google Maps link.' };
  if (SHORT_HOST.test(host)) {
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

module.exports = { loadGoogleKey, storeGoogleKey, maskKey };

// Sync with the Android companion through the user's own relay (server/index.php).
// Everything secret (relay admin token, encryption key) stays here, in the main process, encrypted on disk
// with the Windows user account. The window only sees status text, the pairing QR picture and the changes it has to apply.
//   sync.json        { url, deviceId, needsInit, enc }   (enc = safeStorage({ adminToken, key }))
//   sync-state.json  the engine's own state (shadow copy, outbox, cursor)
// Neither file is part of a .ccbackup (backup.js only writes the files it names).
const electron = require('electron');
const { ipcMain, net, safeStorage } = electron;
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { ui, dataDir, dataFile, writeAtomic } = require('./paths');
const SyncModel = require('../shared/sync-model');
const SyncCrypto = require('../shared/sync-crypto');
const SyncEngine = require('../shared/sync-engine');

const NO_ENCRYPTION = 'This computer cannot encrypt the sync key (Windows data protection is unavailable), so sync was not turned on.';
const ALREADY_CLAIMED = 'This server is already set up. Use the same PC, or reset it by deleting its data folder on the server.';
const SAVE_DELAY = 5000;
const EVERY = 5 * 60 * 1000;
const RESUME_DELAY = 1000;
const RETRY_OFFLINE = 60 * 1000;
const ACK_TIMEOUT = 15000;      // the window must confirm it saved merged data within this time
const CLIP_CLEAR_MS = 60 * 1000;
const PAIRING_SHOW_MS = 5 * 60 * 1000;

const configFile = () => path.join(dataDir(), 'sync.json');
const stateFile = () => path.join(dataDir(), 'sync-state.json');

let config = null;       // { url, deviceId, needsInit, adminToken, key } while sync is on
let engine = null;
let lastData = null;     // the data as last saved by the window
let paused = true;       // until the window says its data is loaded (and while recovery is pending)
let saveTimer = null, everyTimer = null, retryTimer = null;
let phase = 'off';       // 'off' | 'idle' | 'syncing' | 'offline' | 'error'
let lastError = null;
let rekeying = false;    // a key reset is running: no sync, no capture
let confirming = false;  // a decision about held deletions / a rebase is being applied: saves are only remembered
let promptOpen = false;  // the window is showing the "also remove from phones?" question
let lastAsked = null;
let dismissedKey = null; // counts of a question the user dismissed: not asked again until they change
let ackTimeout = ACK_TIMEOUT;
let lastPairing = null, pairingTimer = null, clipTimer = null; // the text of the pairing code never leaves this process
const acks = new Map();
let ackSeq = 0;

// ---------- Config on disk ----------
function readConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    if (!j.url || !j.deviceId || !j.enc || !safeStorage.isEncryptionAvailable()) return null;
    const secret = JSON.parse(safeStorage.decryptString(Buffer.from(j.enc, 'base64')));
    if (!secret.adminToken || !secret.key) return null;
    return { url: j.url, deviceId: j.deviceId, needsInit: !!j.needsInit, adminToken: secret.adminToken, key: secret.key };
  } catch { return null; }
}
function writeConfig(c) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error(NO_ENCRYPTION);
  const enc = safeStorage.encryptString(JSON.stringify({ adminToken: c.adminToken, key: c.key })).toString('base64');
  writeAtomic(configFile(), JSON.stringify({ url: c.url, deviceId: c.deviceId, needsInit: !!c.needsInit, enc }));
}

const store = {
  async load() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return null; } },
  async save(st) { writeAtomic(stateFile(), JSON.stringify(st)); },
  // A bundle that could not be applied is kept (still encrypted) for diagnosis; the newest 20 stay.
  async quarantine(text) {
    const dir = path.join(dataDir(), 'sync-quarantine');
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`), String(text));
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.txt')).sort().slice(0, -20)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* gone */ } }
  },
};

// ---------- Relay calls ----------
// `action` must be the first key of the JSON body (the relay's rule). Anything but HTTP 2xx with a JSON body that says
// ok:true is an error. hello and claim go out with no token header at all (the relay rejects a wrong one).
function makeTransport(url, token) {
  return async function transport(action, body) {
    let res;
    try {
      res = await net.fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token, 'X-CC-Token': token } : {}),
        body: JSON.stringify(Object.assign({ action }, body || {})),
        signal: AbortSignal.timeout(60000),
      });
    } catch (e) {
      const err = new Error("Couldn't reach the server: " + (e && e.message));
      err.network = true;
      throw err;
    }
    let j = null;
    try { j = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const err = new Error((j && j.error) || `The server answered HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (!j || typeof j !== 'object' || j.ok !== true) {
      const err = new Error((j && j.error) || 'The server answered, but not like a Client Clusters server.');
      err.status = res.status; err.code = 'bad-response';
      throw err;
    }
    return j;
  };
}

// Accepts what people paste: with or without index.php, with or without a trailing slash.
function normalizeUrl(raw) {
  const text = String(raw || '').trim();
  if (!SyncCrypto.allowedRelayUrl(text)) throw new Error('The server address must start with https:// (for example https://example.com/sync/).');
  const u = new URL(text);
  u.search = ''; u.hash = '';
  let out = u.toString();
  if (!/\.php$/i.test(u.pathname) && !out.endsWith('/')) out += '/';
  return out;
}

async function hello(url) {
  let j;
  try { j = await makeTransport(url, null)('hello', {}); }
  catch (e) { throw new Error(e.network ? e.message : 'The server did not answer like a Client Clusters server: ' + e.message); }
  if (!j || j.app !== 'client-clusters-relay') throw new Error('This address does not look like a Client Clusters server.');
  return j;
}

// ---------- Status ----------
function status() {
  return {
    enabled: !!config,
    url: config ? config.url : '',
    state: config ? phase : 'off',   // off | idle | syncing | offline | error | paused
    error: config ? lastError : null,
    lastSyncAt: engine ? engine.lastSyncAt : 0,
    paused,
    needsConfirm: config && engine ? engine.needsConfirm : null,
  };
}
function emitStatus() {
  const w = ui.win;
  if (w && !w.isDestroyed()) w.webContents.send('sync:status-changed', status());
}

// ---------- Engine ----------
const usable = d => !!d && typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.clients);
// The data the window last saved, else the file. null when it cannot be trusted (unreadable file): sync then does nothing.
// A file that does not exist yet (first run) is an empty list, not a problem.
function currentData() {
  if (usable(lastData)) return lastData;
  try {
    const d = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    return usable(d) ? d : null;
  } catch (e) {
    return e && e.code === 'ENOENT' ? { version: 1, settings: {}, clients: [], groups: [], prospecting: null } : null;
  }
}
function startEngine() {
  const transport = makeTransport(config.url, config.adminToken);
  engine = SyncEngine.create({
    role: 'pc',
    config: { key: config.key, deviceId: config.deviceId, pcDeviceId: config.deviceId },
    transport, store,
  });
  phase = 'idle'; lastError = null;
  engine.onStatus(s => {
    phase = s.status; lastError = s.lastError;
    if (s.status === 'offline' && config && !paused) { clearTimeout(retryTimer); retryTimer = setTimeout(() => runSync(), RETRY_OFFLINE); }
    emitStatus();
  });
  clearInterval(everyTimer);
  everyTimer = setInterval(() => runSync(), EVERY);
  everyTimer.unref && everyTimer.unref();
}
function stopEngine() {
  clearTimeout(saveTimer); clearTimeout(retryTimer); clearInterval(everyTimer);
  saveTimer = retryTimer = everyTimer = null;
  engine = null; phase = 'off'; lastError = null; promptOpen = false;
}

// The window must be there to take the changes, and must say it saved them: the engine commits (moves its cursor and
// copy forward) only after this resolves. Rejecting makes the engine try again next time.
function applyWin(ops) {
  const w = ui.win;
  if (!w || w.isDestroyed() || w.webContents.isLoading()) return Promise.reject(new Error('window-not-ready'));
  return new Promise((resolve, reject) => {
    const id = ++ackSeq;
    const timer = setTimeout(() => { acks.delete(id); reject(new Error('window-timeout')); }, ackTimeout);
    if (timer.unref) timer.unref();
    acks.set(id, ok => { clearTimeout(timer); acks.delete(id); if (ok) resolve(); else reject(new Error('window-refused')); });
    w.webContents.send('sync:incoming', { id, ops });
  });
}

// Ask the window whether deletions held back by the circuit breaker should also reach the phones.
function maybePrompt() {
  const nc = engine && engine.needsConfirm;
  const w = ui.win;
  if (!nc) { dismissedKey = null; return; }
  if (JSON.stringify(nc) === dismissedKey) return;
  if (promptOpen || confirming || !w || w.isDestroyed() || w.webContents.isLoading()) return;
  promptOpen = true; lastAsked = JSON.stringify(nc);
  w.webContents.send('sync:confirm-deletes', nc);
  emitStatus();
}

async function runSync() {
  if (!engine || !config || paused || rekeying) return status();
  clearTimeout(saveTimer); saveTimer = null;
  const data = currentData();
  if (!data) { phase = 'error'; lastError = 'data-unavailable'; emitStatus(); return status(); }
  if (config.needsInit) {
    try {
      await engine.initPc(SyncModel.project(data));
      config.needsInit = false; writeConfig(config);
    } catch { return status(); } // the engine set the status (offline, error…)
  }
  await engine.sync({
    getProj: () => { const d = currentData(); if (!d) throw new Error('data-unavailable'); return SyncModel.project(d); },
    applyWin,
  });
  maybePrompt();
  return status();
}

// Called by data:save after the file is written.
function onSaved(data) {
  if (!usable(data)) return;
  lastData = data;
  if (!engine || !config || paused || config.needsInit || confirming || rekeying) return;
  engine.capture(SyncModel.project(data)).then(maybePrompt, e => console.error('Sync capture failed', e));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => runSync(), SAVE_DELAY);
}

function setPaused(p) {
  paused = !!p;
  if (paused) { clearTimeout(saveTimer); clearTimeout(retryTimer); }
  else if (engine) { clearTimeout(saveTimer); saveTimer = setTimeout(() => runSync(), RESUME_DELAY); } // lets the window's own save land first
  emitStatus();
}

// Start-up: pick up the saved configuration. The first sync waits until the window reports its data is loaded.
function init() {
  config = readConfig();
  if (config) startEngine();
  return status();
}

// ---------- IPC ----------
const fail = e => ({ ok: false, error: (e && e.message) || String(e) });

ipcMain.handle('sync:status', () => status());
ipcMain.handle('sync:pause', (_e, p) => { setPaused(p); return status(); });

ipcMain.handle('sync:test', async (_e, url) => {
  try {
    const j = await hello(normalizeUrl(url));
    return { ok: true, claimed: !!j.claimed, version: j.version };
  } catch (e) { return fail(e); }
});

ipcMain.handle('sync:enable', async (_e, { url, setupCode } = {}) => {
  try {
    if (config) throw new Error('Sync is already on.');
    url = normalizeUrl(url);
    setupCode = String(setupCode || '').trim();
    if (!setupCode) throw new Error('Enter the setup code you put in the server settings.');
    // Claiming is one-shot: make sure the result can be stored before doing it.
    if (!safeStorage.isEncryptionAvailable()) throw new Error(NO_ENCRYPTION);
    const data = currentData();
    if (!data) throw new Error('Your data could not be read, so sync was not turned on.');
    const h = await hello(url);
    if (h.claimed) throw new Error(ALREADY_CLAIMED);
    let claim;
    try { claim = await makeTransport(url, null)('claim', { setupCode }); }
    catch (e) {
      if (e.status === 409) throw new Error(ALREADY_CLAIMED);
      if (e.status === 403) throw new Error('The server did not accept this setup code. Check it matches the one in the server settings.');
      throw e;
    }
    const next = { url, deviceId: claim.deviceId, adminToken: claim.adminToken, key: await SyncCrypto.generateKey(), needsInit: true };
    writeConfig(next);
    try { fs.unlinkSync(stateFile()); } catch { /* none yet */ }
    lastPairing = null;
    config = next;
    startEngine();
    // First upload: the engine adopts the data as it is now. If it fails (offline), the next sync retries it.
    try {
      await engine.initPc(SyncModel.project(currentData() || data));
      config.needsInit = false; writeConfig(config);
    } catch { /* kept as needsInit */ }
    emitStatus();
    return { ok: true, status: status() };
  } catch (e) { return fail(e); }
});

ipcMain.handle('sync:disable', () => {
  stopEngine();
  config = null; lastPairing = null;
  for (const f of [configFile(), stateFile()]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  emitStatus();
  return { ok: true, status: status() };
});

const needConfig = () => { if (!config) throw new Error('Sync is off.'); return makeTransport(config.url, config.adminToken); };

ipcMain.handle('sync:addPhone', async (_e, name) => {
  try {
    const transport = needConfig();
    name = String(name || '').trim().slice(0, 60);
    if (!name) throw new Error('Give the phone a name, for example “Max’s phone”.');
    const dev = await transport('addDevice', { name });
    const code = SyncCrypto.encodePairing({
      url: config.url, token: dev.token, key: config.key, name, deviceId: dev.deviceId, pcDeviceId: config.deviceId,
    });
    const qrDataUrl = await QRCode.toDataURL(code, { errorCorrectionLevel: 'M', margin: 1, width: 280 });
    // The text of the code stays in this process; the window only gets the picture. "Copy" goes through copyPairing.
    lastPairing = code;
    clearTimeout(pairingTimer);
    pairingTimer = setTimeout(() => { lastPairing = null; }, PAIRING_SHOW_MS);
    if (pairingTimer.unref) pairingTimer.unref();
    return { ok: true, qrDataUrl, deviceId: dev.deviceId };
  } catch (e) { return fail(e); }
});

ipcMain.handle('sync:copyPairing', () => {
  if (!lastPairing) return { ok: false, error: 'The pairing code is no longer available. Add the phone again.' };
  const code = lastPairing, { clipboard } = electron;
  clipboard.writeText(code);
  clearTimeout(clipTimer);
  clipTimer = setTimeout(() => { try { if (clipboard.readText() === code) clipboard.clear(); } catch { /* clipboard busy */ } }, CLIP_CLEAR_MS);
  if (clipTimer.unref) clipTimer.unref();
  return { ok: true, clearsInMs: CLIP_CLEAR_MS };
});
ipcMain.handle('sync:clearPairing', () => { lastPairing = null; clearTimeout(pairingTimer); return true; });

ipcMain.handle('sync:listPhones', async () => {
  try {
    const j = await needConfig()('listDevices', {});
    const phones = (j.devices || []).filter(d => d.deviceId !== config.deviceId)
      .map(d => ({ id: d.deviceId, name: d.name, addedAt: d.addedAt, lastSeen: d.lastSeen }));
    return { ok: true, phones };
  } catch (e) { return fail(e); }
});

ipcMain.handle('sync:revokePhone', async (_e, id) => {
  try {
    if (typeof id !== 'string' || id === (config && config.deviceId)) throw new Error('Unknown phone.');
    await needConfig()('revokeDevice', { deviceId: id });
    return { ok: true };
  } catch (e) { return fail(e); }
});

// The window's answer to the deletion question: true = send them, false = keep them (they come back here), null = dismissed.
ipcMain.handle('sync:confirmDeletes', async (_e, answer) => {
  promptOpen = false;
  if (!engine || !config) return { ok: true };
  if (answer !== true && answer !== false) { dismissedKey = lastAsked; emitStatus(); return { ok: true, dismissed: true }; }
  dismissedKey = null;
  confirming = true;
  try {
    const r = await engine.confirmDeletes(answer);
    if (!answer && r.restore.length) await applyWin(r.restore);
    return { ok: true, queued: r.queued, restored: r.restore.length };
  } catch (e) { return fail(e); }
  finally {
    confirming = false;
    if (usable(lastData) && engine && !paused) engine.capture(SyncModel.project(lastData)).then(maybePrompt, () => {});
    if (answer && !paused) { clearTimeout(saveTimer); saveTimer = setTimeout(() => runSync(), RESUME_DELAY); }
    emitStatus();
  }
});

// After the window replaced its data on purpose (recovery, Replace restore, start empty): what the phones and the relay
// still have comes back into the window and is never sent as a deletion.
ipcMain.handle('sync:rebase', async () => {
  if (!engine || !config || config.needsInit || rekeying) return { ok: true, skipped: true, restored: 0 };
  confirming = true;
  try {
    if (!usable(lastData)) throw new Error('There is no saved data to compare with.');
    const r = await engine.rebase(SyncModel.project(lastData));
    if (r.ops.length) await applyWin(r.ops);
    return {
      ok: true,
      restored: r.ops.filter(o => o.k === 'add' && o.e === 'client').length,
      restoredProspects: r.ops.filter(o => o.k === 'add' && o.e === 'prospect').length,
      restoredVisits: r.ops.filter(o => o.k === 'visit').length,
    };
  } catch (e) { return fail(e); }
  finally {
    confirming = false;
    if (!paused) { clearTimeout(saveTimer); saveTimer = setTimeout(() => runSync(), RESUME_DELAY); }
  }
});

// New key: every phone must pair again, and nothing readable with the old key stays on the relay.
ipcMain.handle('sync:rekey', async () => {
  try {
    const transport = needConfig();
    const data = currentData();
    if (!data) throw new Error('Your data could not be read, so the sync key cannot be reset now.');
    if (paused) throw new Error('Sync is paused until the data problem is resolved.');
    rekeying = true;
    clearTimeout(saveTimer); clearTimeout(retryTimer);
    try { await engine.capture(null); } catch { /* only waits for a sync that is running */ }
    const key = await SyncCrypto.generateKey();
    await transport('rekey', {});
    // From here the relay is empty and every phone token is gone.
    stopEngine();
    config.key = key; config.needsInit = true;
    writeConfig(config);
    try { fs.unlinkSync(stateFile()); } catch { /* none */ }
    lastPairing = null;
    startEngine();
    rekeying = false;
    try { await engine.initPc(SyncModel.project(data)); config.needsInit = false; writeConfig(config); } catch { /* kept as needsInit; the next sync retries */ }
    emitStatus();
    return { ok: true, status: status() };
  } catch (e) { return fail(e); }
  finally { rekeying = false; }
});

ipcMain.handle('sync:applied', (_e, id, ok) => { const f = acks.get(id); if (f) f(ok === true); return true; });

ipcMain.handle('sync:now', async () => {
  try {
    if (!config) throw new Error('Sync is off.');
    if (paused) throw new Error('Sync is paused until the data problem is resolved.');
    return Object.assign({ ok: true }, await runSync());
  } catch (e) { return fail(e); }
});

module.exports = {
  init, onSaved, setPaused, status, runSync, normalizeUrl,
  _engine: () => engine, _stop: stopEngine, _pairingCode: () => lastPairing, _setAckTimeout: ms => { ackTimeout = ms; },
};

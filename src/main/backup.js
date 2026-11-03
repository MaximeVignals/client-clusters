// Backups to move data between computers.
// A ".ccbackup" file is a zip holding:
//   manifest.json          what's inside (date, computer, app version, counts)
//   data.json              clients, visits, groups, settings (the same as clients.json)
//   prospecting.json       optional: the prospecting map
//   geocode-cache.json     addresses already found, so the other PC doesn't search them again
//   town-cache.json        towns already looked up from map positions
//   google-key.json        optional: the Google API key, encrypted with a password chosen by the user
// Older plain ".json" backups (version 1.4/1.5) can still be restored.
const { app, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const JSZip = require('jszip');
const { ui, backupDir, writeAtomic } = require('./paths');
const { geoCache, townCache } = require('./geocode');
const { loadGoogleKey, storeGoogleKey, maskKey } = require('./google');

const BACKUP_EXT = 'ccbackup';
let pendingRestore = null; // what was read from the last opened backup, until it's applied or another is opened

const passwordKey = (password, salt) => crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
function encryptWithPassword(text, password) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', passwordKey(password, salt), iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return { v: 1, alg: 'aes-256-gcm', kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decryptWithPassword(o, password) {
  const d = crypto.createDecipheriv('aes-256-gcm', passwordKey(password, Buffer.from(o.salt, 'base64')), Buffer.from(o.iv, 'base64'));
  d.setAuthTag(Buffer.from(o.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(o.data, 'base64')), d.final()]).toString('utf8');
}

const pad = n => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const counts = data => ({
  clients: data.clients.length,
  visits: data.clients.reduce((n, c) => n + ((c.visits || []).length), 0),
  groups: (data.groups || []).length,
  prospects: data.prospecting ? (data.prospecting.prospects || []).length : 0,
});

ipcMain.handle('backup:save', async (_e, { data, includeKey, password }) => {
  if (!data || !Array.isArray(data.clients)) throw new Error('Nothing to back up.');
  const r = await dialog.showSaveDialog(ui.win, {
    title: 'Save a backup of all your data',
    defaultPath: path.join(app.getPath('documents'), `Client Clusters backup ${stamp()}.${BACKUP_EXT}`),
    filters: [{ name: 'Client Clusters backup', extensions: [BACKUP_EXT] }],
  });
  if (r.canceled || !r.filePath) return null;
  const zip = new JSZip();
  const key = includeKey ? loadGoogleKey() : '';
  // The prospecting map is an optional part, in its own file.
  const { prospecting, ...rest } = data;
  zip.file('manifest.json', JSON.stringify({
    app: 'Client Clusters', format: 1, appVersion: app.getVersion(), createdAt: new Date().toISOString(),
    ...counts(data), googleKey: !!(key && password),
  }, null, 1));
  zip.file('data.json', JSON.stringify(rest));
  if (prospecting) zip.file('prospecting.json', JSON.stringify(prospecting));
  zip.file('geocode-cache.json', JSON.stringify(geoCache.get()));
  zip.file('town-cache.json', JSON.stringify(townCache.get()));
  if (key && password) zip.file('google-key.json', JSON.stringify(encryptWithPassword(key, password)));
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  writeAtomic(r.filePath, buf);
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
    const text = buf.toString('utf8').replace(/^﻿/, '');
    try { out.data = JSON.parse(text); } catch { throw new Error('This file is not a Client Clusters backup.'); }
    const st = fs.statSync(file);
    out.manifest = { app: 'Client Clusters', format: 0, createdAt: st.mtime.toISOString(), computer: '', appVersion: '' };
  }
  if (!out.data || !Array.isArray(out.data.clients)) throw new Error('This file is not a Client Clusters backup.');
  out.manifest = { ...out.manifest, ...counts(out.data) };
  return out;
}

ipcMain.handle('backup:open', async () => {
  const r = await dialog.showOpenDialog(ui.win, {
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
      const d = new Date();
      safety = path.join(backupDir(), `before-restore-${stamp(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`);
      fs.writeFileSync(safety, JSON.stringify(current, null, 1), 'utf8');
    }
  } catch (e) { return { ok: false, error: 'Could not save a safety copy of the current data: ' + e.message }; }
  // 2) Address and town caches: add what the backup knows.
  for (const [cache, incoming] of [[geoCache, pendingRestore.geocode], [townCache, pendingRestore.towns]]) {
    if (incoming && typeof incoming === 'object') { Object.assign(cache.get(), incoming); cache.saveSoon(); }
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

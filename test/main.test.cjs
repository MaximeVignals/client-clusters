const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Each test loads a fresh copy of the main process with a stand-in for Electron.
const src = path.resolve(__dirname, '../src');
let electron = null;
const realLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electron : realLoad.call(this, request, ...rest); };

function mainContext(t, fetch) {
  const tmpRoot = path.resolve(__dirname, '../.test-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'main-'));
  t.after(() => {
    load('geocode').geoCache.cancel(); load('geocode').townCache.cancel();
    assert.equal(path.dirname(dir), tmpRoot);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const handlers = new Map();
  const dialogs = { showOpenDialog: async () => ({ filePaths: [path.join(dir, 'backup.ccbackup')] }),
    showSaveDialog: async () => ({ filePath: path.join(dir, 'backup.ccbackup') }) };
  electron = {
    app: { getPath: () => dir, getVersion: () => '1.8.0', requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, dialog: dialogs,
    shell: { showItemInFolder() {} }, safeStorage: {}, net: { fetch },
  };
  for (const key of Object.keys(require.cache)) if (key.startsWith(src)) delete require.cache[key];
  require(path.join(src, 'main.js'));
  return { handlers, dir, dialogs };
}
const load = name => require(path.join(src, 'main', name + '.js'));

test('CSV import preserves quotes, multiline fields and Windows encodings', t => {
  mainContext(t);
  const { parseCsv, decodeText } = load('files');
  const rows = parseCsv('Name;Notes\r\n"Épicerie";"Line one\nLine ""two"""\r\n');
  assert.deepEqual(rows, [['Name', 'Notes'], ['Épicerie', 'Line one\nLine "two"']]);
  assert.equal(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'café');
});

test('an unreadable data file is copied to the backups folder before anything can replace it', t => {
  const { handlers, dir } = mainContext(t);
  fs.writeFileSync(path.join(dir, 'clients.json'), '{"clients": [tru');
  const result = handlers.get('data:load')();
  assert.match(result.__error, /Could not read the data file/);
  const kept = fs.readdirSync(path.join(dir, 'backups')).filter(f => f.startsWith('unreadable-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'backups', kept[0]), 'utf8'), '{"clients": [tru');
});

const writeBackup = (dir, name, content) => {
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backups', name), typeof content === 'string' ? content : JSON.stringify(content));
};

test('a damaged data file lists the daily backups that can still be restored, newest first', t => {
  const { handlers, dir } = mainContext(t);
  fs.writeFileSync(path.join(dir, 'clients.json'), '{"clients": [tru');
  writeBackup(dir, 'clients-2026-11-06.json', { clients: [{ id: 'a', visits: [{}, {}] }, { id: 'b' }] });
  writeBackup(dir, 'clients-2026-11-08.json', { clients: [{ id: 'a', visits: [{}] }] });
  writeBackup(dir, 'clients-2026-11-07.json', '{"clients": [');
  const result = handlers.get('data:load')();
  assert.match(result.__error, /Could not read the data file/);
  assert.deepEqual(result.backups, [
    { file: 'clients-2026-11-08.json', date: '2026-11-08', clients: 1, visits: 1 },
    { file: 'clients-2026-11-06.json', date: '2026-11-06', clients: 2, visits: 2 },
  ]);
});

test('restoring a daily backup reads plain backup names only', t => {
  const { handlers, dir } = mainContext(t);
  const data = { clients: [{ id: 'a', visits: [] }] };
  writeBackup(dir, 'clients-2026-11-08.json', data);
  writeBackup(dir, 'unreadable-x.json', data);
  fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify(data));
  const restore = name => handlers.get('data:restoreDaily')(null, name);
  assert.deepEqual(restore('clients-2026-11-08.json'), data);
  for (const bad of ['..\\clients.json', '../clients.json', 'clients-2026-11-08.json\\..\\x',
    path.join(dir, 'clients.json'), 'unreadable-x.json', 'clients-2026-11-09.json', undefined])
    assert.throws(() => restore(bad), bad === 'clients-2026-11-09.json' ? /could not be read/ : /not a daily backup/);
});

test('a damaged data file is never copied into the daily backups and pushes none out', t => {
  const { dir } = mainContext(t);
  for (let d = 1; d <= 16; d++) writeBackup(dir, `clients-2026-10-${String(d).padStart(2, '0')}.json`, { clients: [] });
  fs.writeFileSync(path.join(dir, 'clients.json'), '{"clients": [tru');
  load('paths').dailyBackup();
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).filter(f => /^clients-/.test(f)).length, 16);
});

test('address caches waiting to be written are saved when the app closes', t => {
  const { dir } = mainContext(t);
  const { geoCache } = load('geocode');
  geoCache.get()['fictional address'] = { lat: 45, lng: 4 };
  geoCache.saveSoon();
  geoCache.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'geocode-cache.json'), 'utf8')), { 'fictional address': { lat: 45, lng: 4 } });
});

test('Google Maps links are accepted from Google hosts only', async t => {
  const { handlers } = mainContext(t);
  const resolve = link => handlers.get('google:resolveLink')(null, link);
  assert.equal((await resolve('https://www.google.co.uk/maps/place/Caf%C3%A9+Fictif/@51.5,-0.1,17z')).name, 'Café Fictif');
  assert.equal((await resolve('https://maps.google.com/?q=Fictional+shop')).name, 'Fictional shop');
  for (const link of ['https://www.google.example.com/maps/place/X', 'https://notgoogle.com/maps/place/X', 'https://blog.co/maps'])
    assert.match((await resolve(link)).error, /not a Google Maps link/);
});

test('backup round trip includes prospects and writes a safety copy before restore', async t => {
  const { handlers, dir } = mainContext(t);
  const data = { settings: {}, clients: [{ id: 'c', visits: [{ date: '2026-01-01' }] }], groups: [],
    prospecting: { prospects: [{ id: 'p', name: 'Prospect' }], areas: [] } };
  const saved = await handlers.get('backup:save')(null, { data });
  assert.ok(saved.size > 0);
  const opened = await handlers.get('backup:open')();
  assert.deepEqual(JSON.parse(JSON.stringify(opened.data)), data);
  assert.equal(opened.manifest.prospects, 1);
  const applied = handlers.get('backup:apply')(null, { current: data });
  assert.equal(applied.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'backups', applied.safety), 'utf8')), data);
  assert.equal(handlers.get('backup:apply')(null, { current: data }).ok, false);
});

test('concurrent forward and reverse geocoding share the Nominatim rate limit', async t => {
  const starts = [];
  const { handlers } = mainContext(t, async url => {
    if (url.includes('data.geopf.fr')) return { ok: true, json: async () => ({ features: [] }) };
    starts.push(Date.now());
    return { ok: true, json: async () => url.includes('/reverse?')
      ? { address: { city: 'Town' } } : [{ lat: '45', lon: '4', display_name: 'Town' }] };
  });
  await Promise.all([
    load('geocode').geocodeNominatim('one'),
    load('geocode').geocodeNominatim('two'),
    handlers.get('geo:town')(null, { lat: 45, lng: 4 }),
  ]);
  assert.equal(starts.length, 3);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 1000,
    `requests were only ${starts[i] - starts[i - 1]} ms apart`);
});

test('a failed Nominatim request does not block the queue', async t => {
  let attempts = 0;
  mainContext(t, async () => {
    if (++attempts === 1) throw new Error('offline');
    return { ok: true, json: async () => [] };
  });
  const result = await Promise.allSettled([
    load('geocode').geocodeNominatim('one'),
    load('geocode').geocodeNominatim('two'),
  ]);
  assert.equal(result[0].status, 'rejected');
  assert.equal(result[1].status, 'fulfilled');
  assert.equal(result[1].value, null);
});

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

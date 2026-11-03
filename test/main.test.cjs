const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function mainContext(t, fetch) {
  const tmpRoot = path.resolve(__dirname, '../.test-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'main-'));
  t.after(() => {
    vm.runInContext('clearTimeout(cacheTimer); clearTimeout(revTimer);', context);
    assert.equal(path.dirname(dir), tmpRoot);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const handlers = new Map();
  const dialogs = { showOpenDialog: async () => ({ filePaths: [path.join(dir, 'backup.ccbackup')] }),
    showSaveDialog: async () => ({ filePath: path.join(dir, 'backup.ccbackup') }) };
  const electron = {
    app: { getPath: () => dir, getVersion: () => '1.8.0', requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, dialog: dialogs,
    shell: { showItemInFolder() {} }, safeStorage: {}, net: { fetch },
  };
  const filename = path.resolve(__dirname, '../src/main.js');
  const localRequire = createRequire(filename);
  const context = vm.createContext({ require: name => name === 'electron' ? electron : localRequire(name),
    __dirname: path.dirname(filename), Buffer, TextDecoder, URL, console, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { context, handlers, dir, dialogs };
}

test('CSV import preserves quotes, multiline fields and Windows encodings', t => {
  const { context } = mainContext(t);
  context.input = 'Name;Notes\r\n"Épicerie";"Line one\nLine ""two"""\r\n';
  const rows = vm.runInContext('parseCsv(input)', context);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [['Name', 'Notes'], ['Épicerie', 'Line one\nLine "two"']]);
  context.bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
  assert.equal(vm.runInContext('decodeText(bytes)', context), 'café');
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
  const { context, handlers } = mainContext(t, async url => {
    if (url.includes('data.geopf.fr')) return { ok: true, json: async () => ({ features: [] }) };
    starts.push(Date.now());
    return { ok: true, json: async () => url.includes('/reverse?')
      ? { address: { city: 'Town' } } : [{ lat: '45', lon: '4', display_name: 'Town' }] };
  });
  await Promise.all([
    vm.runInContext("geocodeNominatim('one')", context),
    vm.runInContext("geocodeNominatim('two')", context),
    handlers.get('geo:town')(null, { lat: 45, lng: 4 }),
  ]);
  assert.equal(starts.length, 3);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 1000,
    `requests were only ${starts[i] - starts[i - 1]} ms apart`);
});

test('a failed Nominatim request does not block the queue', async t => {
  let attempts = 0;
  const { context } = mainContext(t, async () => {
    if (++attempts === 1) throw new Error('offline');
    return { ok: true, json: async () => [] };
  });
  const result = await Promise.allSettled([
    vm.runInContext("geocodeNominatim('one')", context),
    vm.runInContext("geocodeNominatim('two')", context),
  ]);
  assert.equal(result[0].status, 'rejected');
  assert.equal(result[1].status, 'fulfilled');
  assert.equal(result[1].value, null);
});

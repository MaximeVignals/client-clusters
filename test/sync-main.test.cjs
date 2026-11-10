'use strict';
// Windows main-process sync (src/main/sync.js) against the real PHP relay (php -S) with a stand-in for Electron.
// Skipped when no php binary is available (PATH, or set PHP_BIN). Made-up data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const PHP = process.env.PHP_BIN || 'php';
const hasPhp = (() => { try { return spawnSync(PHP, ['-v'], { encoding: 'utf8' }).status === 0; } catch { return false; } })();
const SKIP = hasPhp ? false : 'PHP not found (put php on PATH or set PHP_BIN); sync main tests skipped';
const SETUP = 'test-setup-code-0123456789';
const ALREADY = 'This server is already set up. Use the same PC, or reset it by deleting its data folder on the server.';
const src = path.resolve(__dirname, '../src');
const SyncCrypto = require('../src/shared/sync-crypto');
const SyncEngine = require('../src/shared/sync-engine');
const SyncOps = require('../src/shared/sync-ops');
const SyncModel = require('../src/shared/sync-model');

let electron = null;
const realLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electron : realLoad.call(this, request, ...rest); };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
async function startRelay() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-relay-'));
  const cfgFile = path.join(dir, 'config.php');
  fs.writeFileSync(cfgFile, `<?php return ['SETUP_CODE' => '${SETUP}', 'DATA_DIR' => '${path.join(dir, 'data').replace(/\\/g, '/')}'];\n`);
  const port = await freePort();
  const proc = spawn(PHP, ['-S', `127.0.0.1:${port}`, '-t', path.join(__dirname, '..', 'server')], { env: { ...process.env, CC_RELAY_CONFIG: cfgFile }, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}/index.php`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { await fetch(url, { method: 'POST', body: JSON.stringify({ action: 'hello' }), headers: { 'Content-Type': 'application/json' } }); up = true; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  if (!up) { proc.kill(); throw new Error('php -S did not start'); }
  return { url, async stop() { proc.kill(); await new Promise(r => setTimeout(r, 150)); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// Loads a fresh main-process sync module with a stand-in Electron.
function loadSync(t, { encryption = true, dir: given } = {}) {
  const tmpRoot = path.resolve(__dirname, '../.test-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = given || fs.mkdtempSync(path.join(tmpRoot, 'sync-'));
  if (!given) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map(), sent = [];
  const clip = { text: '', writeText: x => { clip.text = x; }, readText: () => clip.text, clear: () => { clip.text = ''; } };
  // The window: by default it confirms every batch of incoming changes at once (win.autoAck = false to hold it back).
  const win = { autoAck: true, isDestroyed: () => false, webContents: { loading: false, isLoading: () => win.webContents.loading, send: (ch, p) => {
    sent.push([ch, p]);
    if (ch === 'sync:incoming' && win.autoAck) setImmediate(() => { if (win.apply) win.apply(p.ops); handlers.get('sync:applied')({}, p.id, true); });
  } } };
  electron = {
    app: { getPath: () => dir, getVersion: () => '1.10.0' },
    ipcMain: { handle: (n, fn) => handlers.set(n, fn) },
    net: { fetch: (u, o) => fetch(u, o) },
    clipboard: clip,
    // Reversible stand-in for Windows data protection: enough to prove nothing readable is stored.
    safeStorage: {
      isEncryptionAvailable: () => encryption,
      encryptString: s => Buffer.from(Buffer.from(s).toString('base64').split('').reverse().join('')),
      decryptString: b => Buffer.from(b.toString().split('').reverse().join(''), 'base64').toString(),
    },
  };
  for (const k of Object.keys(require.cache)) if (k.startsWith(src)) delete require.cache[k];
  const sync = require(path.join(src, 'main', 'sync.js'));
  require(path.join(src, 'main', 'paths.js')).ui.win = win;
  const call = (name, ...a) => handlers.get(name)({}, ...a);
  t.after(async () => { await call('sync:pause', true); sync._stop(); });
  return { sync, call, dir, sent, win, clip, electron };
}

const client = (id, name) => ({ id, name, address: '1 rue Test', city: 'Lyon', postcode: '69001', notes: '', visits: [], extra: {} });
const baseData = () => ({ version: 1, settings: {}, clients: [client('c1', 'Café Alpha'), client('c2', 'Boulangerie Beta')], groups: [], prospecting: { prospects: [] } });
const writeData = (dir, data) => fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify(data));

// A phone: a real engine paired with the code produced by the PC.
async function makePhone(pairing) {
  const p = SyncCrypto.decodePairing(pairing);
  const transport = async (action, body) => {
    const res = await fetch(p.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.token }, body: JSON.stringify({ action, ...body }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(j.error || 'HTTP ' + res.status); e.status = res.status; throw e; }
    return j;
  };
  let mem = null, proj = null;
  const incoming = [];
  const engine = SyncEngine.create({ role: 'phone', config: { key: p.key, deviceId: p.deviceId, pcDeviceId: p.pcDeviceId }, transport,
    store: { load: async () => mem, save: async s => { mem = JSON.parse(JSON.stringify(s)); } } });
  return {
    p, engine, incoming, get proj() { return proj; },
    sync: () => engine.sync({ getProj: () => proj, applySnapshot: s => { proj = JSON.parse(JSON.stringify(s)); }, applyWin: w => { incoming.push(...w); if (proj) SyncOps.applyToProj(proj, w); } }),
  };
}

test('sync main (php relay)', { skip: SKIP }, async t => {
  await t.test('refuses to turn on without encryption, before claiming the server', async tt => {
    const relay = await startRelay(); tt.after(() => relay.stop());
    const { call } = loadSync(tt, { encryption: false });
    const r = await call('sync:enable', { url: relay.url, setupCode: SETUP });
    assert.equal(r.ok, false);
    assert.match(r.error, /cannot encrypt/);
    assert.equal((await call('sync:test', relay.url)).claimed, false, 'server still unclaimed');
  });

  await t.test('test connection and enable errors', async tt => {
    const relay = await startRelay(); tt.after(() => relay.stop());
    const { call } = loadSync(tt);
    assert.equal((await call('sync:test', 'ftp://x')).ok, false);
    assert.equal((await call('sync:test', 'http://example.com/')).ok, false);
    assert.equal((await call('sync:test', 'http://127.0.0.1:1/')).ok, false);
    const hello = await call('sync:test', relay.url);
    assert.deepEqual([hello.ok, hello.claimed], [true, false]);
    assert.match((await call('sync:enable', { url: relay.url, setupCode: 'wrong' })).error, /setup code/);
    assert.equal((await call('sync:enable', { url: relay.url, setupCode: '' })).ok, false);
    assert.equal((await call('sync:status')).enabled, false);
  });

  await t.test('enable, secrets, pairing, phone round trip, no echo, pause, revoke, disable', async tt => {
    const relay = await startRelay(); tt.after(() => relay.stop());
    const { sync, call, dir, sent } = loadSync(tt);
    writeData(dir, baseData());
    await call('sync:pause', false);
    const en = await call('sync:enable', { url: relay.url, setupCode: SETUP });
    assert.equal(en.ok, true, en.error);
    assert.equal(en.status.enabled, true);
    assert.equal((await call('sync:enable', { url: relay.url, setupCode: SETUP })).error, 'Sync is already on.');

    // Nothing readable on disk, nothing secret in the status the window sees.
    const raw = fs.readFileSync(path.join(dir, 'sync.json'), 'utf8');
    assert.ok(!/adminToken|"key"/.test(raw));
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['deviceId', 'enc', 'needsInit', 'url']);
    assert.equal(JSON.parse(raw).needsInit, false);
    assert.ok(!/token|key/i.test(JSON.stringify(await call('sync:status'))));
    assert.ok(fs.existsSync(path.join(dir, 'sync-state.json')));
    // Backups only contain the files they name (data, prospecting, caches, key); sync files are not among them.
    assert.ok(!/sync\.json|sync-state|SyncEngine/i.test(fs.readFileSync(path.join(src, 'main', 'backup.js'), 'utf8').replace(/\/\/.*$/gm, '')));

    // Pair a phone
    assert.equal((await call('sync:addPhone', '  ')).ok, false);
    const add = await call('sync:addPhone', 'Test phone');
    assert.equal(add.ok, true, add.error);
    assert.match(add.qrDataUrl, /^data:image\/png;base64,/);
    assert.equal(add.code, undefined, 'the text of the pairing code is not given to the window');
    assert.ok(!JSON.stringify(add).includes('CCSYNC1.'));
    const phone = await makePhone(sync._pairingCode());
    assert.equal(phone.p.name, 'Test phone');
    const list = await call('sync:listPhones');
    assert.deepEqual(list.phones.map(p => p.id), [phone.p.deviceId], 'the PC itself is not listed');
    assert.equal((await phone.sync()).status, 'idle');

    // Phone logs a visit and edits a note; the PC receives them in the window
    phone.proj.clients.c1.visits.v1 = { id: 'v1', date: '2026-11-09', type: 'visit', outcome: '', status: 'done', note: 'Went well' };
    phone.proj.clients.c2.notes = 'Phone note';
    await phone.engine.capture(phone.proj);
    assert.equal((await phone.sync()).pushed, 2);
    const now = await call('sync:now');
    assert.equal(now.ok, true);
    const inc = sent.filter(s => s[0] === 'sync:incoming');
    assert.equal(inc.length, 1);
    assert.ok(inc[0][1].ops.some(o => o.k === 'visit' && o.c === 'c1' && o.v.id === 'v1'));

    // applied incoming ops are not re-captured
    const data = baseData();
    const res = SyncOps.applyToData(data, inc[0][1].ops);
    assert.equal(res.counts.visits, 1);
    assert.equal(data.clients[0].visits.length, 1);
    assert.equal(data.clients[1].notes, 'Phone note');
    const outbox = () => sync._engine().getState().outbox.length;
    sync.onSaved(data);
    await sync._engine().capture(SyncModel.project(data)); // queued behind the hook's own capture
    assert.equal(outbox(), 0);

    // A PC edit goes out and reaches the phone
    data.clients[0].notes = 'PC note';
    sync.onSaved(data);
    assert.equal((await call('sync:now')).ok, true);
    await phone.sync();
    assert.equal(phone.proj.clients.c1.notes, 'PC note');

    // Pause (recovery): nothing is captured or synced
    await call('sync:pause', true);
    data.clients[1].notes = 'while paused';
    sync.onSaved(data);
    assert.equal(outbox(), 0);
    assert.equal((await call('sync:now')).ok, false);
    assert.equal((await call('sync:status')).paused, true);

    // Revoke: the phone is rejected
    await call('sync:pause', false);
    assert.equal((await call('sync:revokePhone', phone.p.deviceId)).ok, true);
    assert.equal((await call('sync:listPhones')).phones.length, 0);
    const after = await phone.sync();
    assert.deepEqual([after.status, after.error], ['error', 'disconnected']);
    assert.equal((await call('sync:revokePhone', 'x')).ok, false);

    // Disable forgets everything locally; the server stays claimed
    const off = await call('sync:disable');
    assert.equal(off.status.enabled, false);
    assert.ok(!fs.existsSync(path.join(dir, 'sync.json')) && !fs.existsSync(path.join(dir, 'sync-state.json')));
    assert.equal((await call('sync:enable', { url: relay.url, setupCode: SETUP })).error, ALREADY);
    assert.equal((await call('sync:test', relay.url)).claimed, true);
  });

  await t.test('changes are not lost when the window cannot take them yet', async tt => {
    const relay = await startRelay(); tt.after(() => relay.stop());
    const { call, dir, sent, win, sync } = loadSync(tt);
    writeData(dir, baseData());
    await call('sync:pause', false);
    assert.equal((await call('sync:enable', { url: relay.url, setupCode: SETUP })).ok, true);
    assert.equal((await call('sync:addPhone', 'p')).ok, true);
    const phone = await makePhone(sync._pairingCode());
    await phone.sync();
    phone.proj.clients.c1.notes = 'from phone';
    await phone.engine.capture(phone.proj);
    await phone.sync();

    win.webContents.loading = true;
    const r1 = await call('sync:now');
    assert.equal(r1.state, 'error');
    assert.equal(sent.filter(s => s[0] === 'sync:incoming').length, 0);
    win.webContents.loading = false;
    const r2 = await call('sync:now');
    assert.equal(r2.state, 'idle');
    const inc = sent.filter(s => s[0] === 'sync:incoming');
    assert.equal(inc.length, 1);
    assert.equal(inc[0][1].ops[0].v, 'from phone');
  });

  await t.test('configuration survives a restart; sync starts only after the window resumes it', async tt => {
    const relay = await startRelay(); tt.after(() => relay.stop());
    const first = loadSync(tt);
    writeData(first.dir, baseData());
    await first.call('sync:pause', false);
    assert.equal((await first.call('sync:enable', { url: relay.url, setupCode: SETUP })).ok, true);
    first.sync._stop();
    const second = loadSync(tt, { dir: first.dir });
    const st = second.sync.init();
    assert.equal(st.enabled, true);
    assert.equal(st.paused, true, 'paused until the window has its data');
    assert.equal((await second.call('sync:now')).ok, false);
    await second.call('sync:pause', false);
    assert.equal((await second.call('sync:now')).state, 'idle');
  });

  // ---- review findings
  const enableWithPhone = async (tt, data = baseData()) => {
    const relay = await startRelay(); tt.after(() => relay.stop());
    const env = loadSync(tt);
    writeData(env.dir, data);
    await env.call('sync:pause', false);
    assert.equal((await env.call('sync:enable', { url: relay.url, setupCode: SETUP })).ok, true);
    assert.equal((await env.call('sync:addPhone', 'p')).ok, true);
    const phone = await makePhone(env.sync._pairingCode());
    await phone.sync();
    return { relay, phone, ...env };
  };
  const outbox = sync => sync._engine().getState().outbox.length;

  await t.test('H1: HTTP 200 that is not a relay answer is an error and the outbox is kept', async tt => {
    const { sync, call, electron } = await enableWithPhone(tt);
    const real = electron.net.fetch;
    const data = baseData(); data.clients[0].notes = 'edited on the PC';
    sync.onSaved(data);
    await sync._engine().capture(SyncModel.project(data));
    assert.equal(outbox(sync), 1);
    for (const reply of [() => new Response('<html>Welcome to your hosting</html>', { status: 200 }), () => new Response('{"ok":false}', { status: 200 }), () => new Response('{}', { status: 200 })]) {
      electron.net.fetch = async () => reply();
      const r = await call('sync:now');
      assert.equal(r.state, 'error');
      assert.equal(r.error, 'bad-response');
      assert.equal(outbox(sync), 1, 'outbox kept');
    }
    electron.net.fetch = real;
    assert.equal((await call('sync:now')).state, 'idle');
    assert.equal(outbox(sync), 0);
  });

  await t.test('headers: both token headers on authenticated calls, none on hello/claim; redirects are refused', async tt => {
    const { call, electron } = await enableWithPhone(tt);
    const real = electron.net.fetch, seen = [];
    electron.net.fetch = (u, o) => { seen.push(o); return real(u, o); };
    await call('sync:listPhones');
    const h = seen[0].headers;
    assert.match(h.Authorization, /^Bearer .{20,}/);
    assert.equal(h['X-CC-Token'], h.Authorization.slice(7));
    assert.equal(seen[0].redirect, 'error');
    seen.length = 0;
    await call('sync:test', 'http://127.0.0.1:1/'); // hello: no token header
    electron.net.fetch = (u, o) => { seen.push(o); return real(u, o); };
    await call('sync:test', (await call('sync:status')).url);
    assert.equal(seen[0].headers.Authorization, undefined); assert.equal(seen[0].headers['X-CC-Token'], undefined);
  });

  await t.test('URLs are parsed, not pattern-matched', async () => {
    const { sync } = loadSync({ after() {} });
    for (const bad of ['https://user:pw@example.com/', 'http://localhost.evil.com/', 'http://127.0.0.1.evil.com/', 'ftp://x', 'https://', 'javascript:alert(1)', 'http://example.com/']) {
      assert.throws(() => sync.normalizeUrl(bad), /must start with https/, bad);
    }
    assert.equal(sync.normalizeUrl('https://example.com/sync?x=1#y'), 'https://example.com/sync/');
    assert.equal(sync.normalizeUrl('http://127.0.0.1:8080/index.php'), 'http://127.0.0.1:8080/index.php');
    assert.equal(sync.normalizeUrl('http://localhost/s'), 'http://localhost/s/');
  });

  await t.test('M4: the engine commits only after the window confirms it saved; no confirmation in time = retry later', async tt => {
    const { sync, call, dir, sent, win, phone } = await enableWithPhone(tt);
    const data = baseData();
    win.apply = ops => { SyncOps.applyToData(data, ops); sync.onSaved(data); }; // a window that saves what it receives
    phone.proj.clients.c1.notes = 'from phone';
    await phone.engine.capture(phone.proj); await phone.sync();
    const cursorOnDisk = () => JSON.parse(fs.readFileSync(path.join(dir, 'sync-state.json'), 'utf8')).cursor;
    const before = cursorOnDisk();
    win.autoAck = false;
    const pending = call('sync:now');
    await new Promise(r => setTimeout(r, 300));
    const inc = sent.filter(x => x[0] === 'sync:incoming');
    assert.equal(inc.length, 1);
    assert.equal(cursorOnDisk(), before, 'nothing committed while the window has not confirmed');
    win.apply(inc[0][1].ops);
    await call('sync:applied', inc[0][1].id, true);
    assert.equal((await pending).state, 'idle');
    assert.ok(cursorOnDisk() > before);

    // a window that never answers: error, then the same changes come again
    phone.proj.clients.c1.notes = 'second';
    await phone.engine.capture(phone.proj); await phone.sync();
    sync._setAckTimeout(100); win.autoAck = false;
    const r = await call('sync:now');
    assert.deepEqual([r.state, r.error], ['error', 'window-timeout']);
    win.autoAck = true;
    assert.equal((await call('sync:now')).state, 'idle');
    const all = sent.filter(x => x[0] === 'sync:incoming');
    assert.equal(all.length, 3);
    assert.equal(all[2][1].ops[0].v, 'second');
    // and a window that says "could not save" is a retry too
    phone.proj.clients.c1.notes = 'third';
    await phone.engine.capture(phone.proj); await phone.sync();
    win.autoAck = false; sync._setAckTimeout(5000);
    const p3 = call('sync:now');
    await new Promise(r => setTimeout(r, 300));
    await call('sync:applied', sent.filter(x => x[0] === 'sync:incoming').pop()[1].id, false);
    assert.equal((await p3).error, 'window-refused');
  });

  await t.test('H2: data that cannot be read means no sync at all', async tt => {
    const { sync, call, dir } = await enableWithPhone(tt);
    fs.writeFileSync(path.join(dir, 'clients.json'), '{broken');
    sync._stop(); // new process view: nothing remembered from the window
    const second = loadSync(tt, { dir });
    second.sync.init();
    await second.call('sync:pause', false);
    const r = await second.call('sync:now');
    assert.deepEqual([r.state, r.error], ['error', 'data-unavailable']);
    assert.equal(second.sync._engine().getState(), null, 'engine never even loaded its state');
    assert.equal((await second.call('sync:rebase')).ok, false);
    // enabling on a fresh server with an unreadable data file is refused too
    const relay2 = await startRelay(); tt.after(() => relay2.stop());
    const third = loadSync(tt);
    fs.writeFileSync(path.join(third.dir, 'clients.json'), 'null');
    const en = await third.call('sync:enable', { url: relay2.url, setupCode: SETUP });
    assert.match(en.error, /could not be read/);
    assert.equal((await third.call('sync:test', relay2.url)).claimed, false, 'server not claimed');
  });

  await t.test('H2: start empty / restore of older data rebases: the phone keeps everything and the window gets it back', async tt => {
    const { sync, call, sent, phone } = await enableWithPhone(tt);
    phone.proj.clients.c1.visits.v1 = { id: 'v1', date: '2026-11-09', type: 'visit', outcome: '', status: 'done', note: '' };
    await phone.engine.capture(phone.proj); await phone.sync();
    assert.equal((await call('sync:now')).state, 'idle');
    sent.length = 0;
    // recovery: paused; the window starts empty and saves
    await call('sync:pause', true);
    const empty = { version: 1, settings: {}, clients: [], groups: [], prospecting: { prospects: [] } };
    sync.onSaved(empty);
    const rb = await call('sync:rebase');
    assert.equal(rb.ok, true);
    assert.equal(rb.restored, 2);
    assert.equal(rb.restoredVisits, 1);
    const inc = sent.filter(x => x[0] === 'sync:incoming');
    assert.equal(inc.length, 1);
    const data = JSON.parse(JSON.stringify(empty));
    SyncOps.applyToData(data, inc[0][1].ops);
    assert.deepEqual(data.clients.map(c => c.id).sort(), ['c1', 'c2']);
    assert.equal(data.clients.find(c => c.id === 'c1').visits.length, 1);
    sync.onSaved(data);
    await call('sync:pause', false);
    assert.equal((await call('sync:now')).state, 'idle');
    const ph = await phone.sync();
    assert.equal(ph.status, 'idle');
    assert.ok(phone.proj.clients.c1 && phone.proj.clients.c2 && phone.proj.clients.c1.visits.v1, 'phone data intact');
  });

  await t.test('breaker over IPC: the window is asked; "keep" restores here, "remove" reaches the phone', async tt => {
    const big = baseData();
    for (let i = 0; i < 8; i++) big.clients.push(client('x' + i, 'Extra ' + i));
    const { sync, call, sent, win, phone } = await enableWithPhone(tt, big);
    const now = JSON.parse(JSON.stringify(big)); now.clients = now.clients.slice(0, 2); // 8 removed
    sync.onSaved(now);
    await new Promise(r => setTimeout(r, 300));
    const q = sent.filter(x => x[0] === 'sync:confirm-deletes');
    assert.equal(q.length, 1);
    assert.deepEqual(q[0][1], { clients: 8, prospects: 0, groups: 0, visits: 0 });
    assert.deepEqual((await call('sync:status')).needsConfirm, { clients: 8, prospects: 0, groups: 0, visits: 0 });
    assert.equal(outbox(sync), 0);
    // dismissed: nothing happens, still pending
    assert.equal((await call('sync:confirmDeletes', null)).dismissed, true);
    assert.ok((await call('sync:status')).needsConfirm);
    // keep
    sent.length = 0;
    const kept = await call('sync:confirmDeletes', false);
    assert.deepEqual([kept.ok, kept.restored], [true, 8]);
    const inc = sent.filter(x => x[0] === 'sync:incoming');
    assert.equal(inc[0][1].ops.filter(o => o.k === 'add').length, 8);
    const back = JSON.parse(JSON.stringify(now)); SyncOps.applyToData(back, inc[0][1].ops);
    sync.onSaved(back);
    await call('sync:now');
    await phone.sync();
    assert.equal(Object.keys(phone.proj.clients).length, 10);
    // delete again and confirm removal
    sync.onSaved(now);
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await call('sync:confirmDeletes', true)).ok, true);
    assert.equal((await call('sync:now')).state, 'idle');
    await phone.sync();
    assert.equal(Object.keys(phone.proj.clients).length, 2);
  });

  await t.test('re-key: new key, old phone cannot sync, new pairing works, nothing secret reaches the window', async tt => {
    const { sync, call, dir, phone } = await enableWithPhone(tt);
    const oldRaw = fs.readFileSync(path.join(dir, 'sync.json'), 'utf8');
    const r = await call('sync:rekey');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.status.enabled, true);
    assert.notEqual(fs.readFileSync(path.join(dir, 'sync.json'), 'utf8'), oldRaw, 'key changed on disk');
    assert.ok(!/token|key/i.test(JSON.stringify(r)));
    const gone = await phone.sync();
    assert.deepEqual([gone.status, gone.error], ['error', 'disconnected']);
    assert.equal((await call('sync:listPhones')).phones.length, 0);
    assert.equal((await call('sync:addPhone', 'new')).ok, true);
    const fresh = await makePhone(sync._pairingCode());
    assert.notEqual(fresh.p.key, phone.p.key);
    assert.equal((await fresh.sync()).status, 'idle');
    assert.equal(Object.keys(fresh.proj.clients).length, 2);
    assert.equal((await call('sync:now')).state, 'idle');
  });

  await t.test('M6: pairing code goes to the clipboard from the main process and is cleared later', async tt => {
    const { sync, call, clip } = await enableWithPhone(tt);
    assert.equal((await call('sync:addPhone', 'q')).ok, true);
    const c = await call('sync:copyPairing');
    assert.deepEqual([c.ok, c.clearsInMs], [true, 60000]);
    assert.equal(clip.text, sync._pairingCode());
    await call('sync:clearPairing');
    assert.equal(sync._pairingCode(), null);
    assert.equal((await call('sync:copyPairing')).ok, false);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'sync.js'), 'utf8');
    assert.ok(!/never reach this window/.test(src));
    assert.ok(!/sync-pair-code/.test(src), 'no pairing text in the renderer DOM');
  });

  await t.test('N1: Replace path - paused while the data is swapped, no deletions go out, nothing before the answer', async tt => {
    const big = baseData();
    for (let i = 0; i < 4; i++) big.clients.push(client('y' + i, 'Extra ' + i));
    big.clients[0].visits = [{ id: 'v1', date: '2026-11-01', status: 'done', type: 'visit', outcome: '', note: '' }];
    const { sync, call, sent, phone } = await enableWithPhone(tt, big);
    // what the window does on Replace: pause, swap, save, rebase, resume
    await call('sync:pause', true);
    const older = { version: 1, settings: {}, groups: [], prospecting: { prospects: [] }, clients: [client('c1', 'Café Alpha')] };
    sync.onSaved(older);
    assert.equal(outbox(sync), 0, 'nothing captured while paused');
    const rb = await call('sync:rebase');
    assert.deepEqual([rb.ok, rb.restored, rb.restoredVisits], [true, 5, 1]);
    assert.equal(outbox(sync), 0, 'no deletion queued');
    const back = JSON.parse(JSON.stringify(older)); SyncOps.applyToData(back, sent.filter(x => x[0] === 'sync:incoming').pop()[1].ops);
    sync.onSaved(back);
    await call('sync:pause', false);
    assert.equal((await call('sync:now')).state, 'idle');
    await phone.sync();
    assert.equal(Object.keys(phone.proj.clients).length, 6);
    assert.equal(Object.keys(phone.proj.clients.c1.visits).length, 1);

    // Import-Replace / demo clear (no pause): more than 5 deletions wait for the answer, so the phone keeps everything until then
    const fresh = { ...older, clients: [client('n1', 'New one')] };
    sync.onSaved(fresh);
    await new Promise(r => setTimeout(r, 300));
    assert.ok((await call('sync:status')).needsConfirm);
    assert.equal((await call('sync:now')).state, 'idle');
    await phone.sync();
    assert.ok(phone.proj.clients.c1 && phone.proj.clients.y3, 'old clients still on the phone before the answer');
    assert.ok(phone.proj.clients.n1, 'additions are not held back');
    assert.equal(sent.filter(x => x[0] === 'sync:confirm-deletes').length, 1);
    assert.equal((await call('sync:confirmDeletes', true)).ok, true);
    await call('sync:now'); await phone.sync();
    assert.deepEqual(Object.keys(phone.proj.clients), ['n1']);
  });

  await t.test('N7: a dismissed question is not asked again for the same counts, only when they change', async tt => {
    const big = baseData();
    for (let i = 0; i < 10; i++) big.clients.push(client('z' + i, 'Extra ' + i));
    const { sync, call, sent } = await enableWithPhone(tt, big);
    const cut = n => ({ ...big, clients: big.clients.slice(0, big.clients.length - n) });
    const asked = () => sent.filter(x => x[0] === 'sync:confirm-deletes').length;
    sync.onSaved(cut(7)); await new Promise(r => setTimeout(r, 300));
    assert.equal(asked(), 1);
    await call('sync:confirmDeletes', null);
    sync.onSaved(cut(7)); await new Promise(r => setTimeout(r, 300));
    sync.onSaved(cut(7)); await new Promise(r => setTimeout(r, 300));
    assert.equal(asked(), 1, 'not asked again');
    assert.ok((await call('sync:status')).needsConfirm, 'chip still shows the pending decision');
    sync.onSaved(cut(8)); await new Promise(r => setTimeout(r, 300));
    assert.equal(asked(), 2, 'asked again because the counts changed');
  });
});

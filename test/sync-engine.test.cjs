'use strict';
// Tests for the sync engine: in-memory fake relay (mirrors server/index.php) plus one run against the real PHP relay.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SyncEngine = require('../src/shared/sync-engine');
const SyncOps = require('../src/shared/sync-ops');
const SyncModel = require('../src/shared/sync-model');
const SyncCrypto = require('../src/shared/sync-crypto');

const clone = x => JSON.parse(JSON.stringify(x));

// ---- fake relay -------------------------------------------------------------------------------------------
function makeRelay() {
  const r = { seq: 0, bundles: [], snapshot: null, down: false, revoked: new Set(), pushes: 0, epoch: 'e0e0e0e0e0e0e0e0', rekeyed: false, compacts: [] };
  r.transport = (id, admin) => async (action, body) => {
    if (r.down) { const e = new Error('network down'); e.network = true; throw e; }
    if (r.revoked.has(id) || (r.rekeyed && !admin)) { const e = new Error('Invalid or revoked token'); e.status = 401; throw e; }
    body = clone(body);
    const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
    if (action === 'push') {
      if (typeof body.bundle !== 'string' || !body.bundle) fail(400, 'bundle');
      r.pushes++;
      if (r.quota && r.bundles.filter(b => b.device === id).reduce((n, b) => n + b.bundle.length, 0) + body.bundle.length > r.quota) fail(507, 'Storage quota reached');
      r.bundles.push({ seq: ++r.seq, device: id, bundle: body.bundle });
      return { ok: true, seq: r.seq, epoch: r.epoch };
    }
    if (action === 'pull') {
      const since = body.since || 0;
      const oldest = r.bundles.length ? r.bundles[0].seq : r.seq + 1;
      const all = r.bundles.filter(b => b.seq > since);
      return clone({ ok: true, bundles: all.slice(0, 200), more: all.length > 200, snapshot: r.snapshot ? { seq: r.snapshot.seq } : null, oldest, last: r.seq, epoch: r.epoch });
    }
    if (action === 'putSnapshot') {
      if (!admin) fail(403, 'Admin token required');
      if (body.seq > r.seq) fail(400, 'seq beyond latest');
      r.snapshot = { seq: body.seq, bundle: body.bundle };
      return { ok: true, epoch: r.epoch };
    }
    if (action === 'compact') {
      if (!admin) fail(403, 'Admin token required');
      if (!r.snapshot || r.snapshot.seq < body.upTo) fail(400, 'no snapshot that far');
      r.compacts.push(body.upTo);
      r.bundles = r.bundles.filter(b => b.seq > body.upTo);
      return { ok: true, oldest: r.bundles.length ? r.bundles[0].seq : r.seq + 1, epoch: r.epoch };
    }
    if (action === 'rekey') {
      if (!admin) fail(403, 'Admin token required');
      r.snapshot = null; r.bundles = []; r.rekeyed = true;
      return { ok: true, epoch: r.epoch };
    }
    if (action === 'getSnapshot') return r.snapshot ? { ok: true, epoch: r.epoch, ...clone(r.snapshot) } : { ok: true, epoch: r.epoch, seq: null, bundle: null };
    fail(400, 'unknown action');
  };
  r.pruneUpTo = seq => { r.bundles = r.bundles.filter(b => b.seq > seq); };
  return r;
}

function memStore() {
  let saved = null;
  return { async load() { return saved ? clone(saved) : null; }, async save(s) { saved = clone(s); }, peek: () => saved };
}

function baseProj() {
  return SyncModel.project({
    clients: [
      { id: 'c1', name: 'Alpha', city: 'Lyon', notes: '', visits: [] },
      { id: 'c2', name: 'Beta', city: 'Nice', notes: '', visits: [] },
    ],
    groups: [{ id: 'g1', number: 1, name: 'North', color: '#111' }],
    prospecting: { prospects: [{ id: 'p1', name: 'Pro', status: 'todo', notes: '' }] },
    settings: {},
  });
}

const visit = (id, date) => ({ id, date, type: 'visit', outcome: '', status: 'done', note: '' });

// A device = engine + the "app data" (a projection) it syncs.
function makeDevice(role, relay, o) {
  const clockRef = o.clockRef;
  const data = { proj: o.proj || null };
  const config = { key: o.key, deviceId: o.deviceId, pcDeviceId: o.pcDeviceId };
  const store = o.store || memStore();
  const base = relay.transport(o.deviceId, role === 'pc');
  const engine = SyncEngine.create({ role, config, transport: o.wrap ? o.wrap(base) : base, store, now: () => clockRef.t++ });
  const dev = {
    engine, data, store,
    sync: () => engine.sync({
      getProj: () => data.proj,
      applyWin: win => SyncOps.applyToProj(data.proj, win),
      applySnapshot: p => { data.proj = clone(p); },
    }),
  };
  return dev;
}

async function pair(relay, clockRef, extra = {}) {
  const key = await SyncCrypto.generateKey();
  const pc = makeDevice('pc', relay, { key, deviceId: 'pcid', proj: baseProj(), clockRef });
  await pc.engine.initPc(pc.data.proj);
  const phone = makeDevice('phone', relay, { key, deviceId: 'phone1', pcDeviceId: 'pcid', clockRef, ...extra });
  return { key, pc, phone };
}

const newClock = () => ({ t: 1_800_000_000_000 });

// ---- tests ------------------------------------------------------------------------------------------------
test('phone bootstraps from the PC snapshot', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone } = await pair(relay, c);
  const r = await phone.sync();
  assert.equal(r.status, 'idle');
  assert.deepEqual(phone.data.proj, pc.data.proj);
});

test('two engines converge (visit + note on phone, other note on PC)', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone } = await pair(relay, c);
  await phone.sync();
  phone.data.proj.clients.c1.visits.v1 = visit('v1', '2026-11-09');
  phone.data.proj.clients.c1.notes = 'phone note';
  pc.data.proj.clients.c2.notes = 'pc note';
  pc.data.proj.clients.c1.name = 'Alpha Renamed';
  const r1 = await phone.sync();
  assert.equal(r1.pushed, 2);
  const r2 = await pc.sync();
  assert.equal(r2.pulled, 1);
  await phone.sync();
  assert.deepEqual(phone.data.proj, pc.data.proj);
  assert.equal(pc.data.proj.clients.c1.visits.v1.date, '2026-11-09');
  assert.equal(pc.data.proj.clients.c2.notes, 'pc note');
  assert.equal(phone.data.proj.clients.c1.name, 'Alpha Renamed');
});

test('same note edited on both sides offline converges on the later edit', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone } = await pair(relay, c);
  await phone.sync();
  phone.data.proj.clients.c1.notes = 'from phone';
  await phone.engine.capture(phone.data.proj);
  pc.data.proj.clients.c1.notes = 'from pc (later)';
  await pc.engine.capture(pc.data.proj);
  await phone.sync(); await pc.sync(); await phone.sync(); await pc.sync();
  assert.equal(pc.data.proj.clients.c1.notes, 'from pc (later)');
  assert.deepEqual(phone.data.proj, pc.data.proj);
});

test('stale phone rebootstraps and keeps its outbox', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone } = await pair(relay, c);
  await phone.sync();
  // Phone goes offline with unsent work.
  relay.down = true;
  phone.data.proj.clients.c1.notes = 'offline note';
  phone.data.proj.clients.c1.visits.v9 = visit('v9', '2026-11-08');
  const off = await phone.sync();
  assert.equal(off.status, 'offline');
  assert.equal(phone.engine.getState().outbox.length, 2, 'outbox kept while offline');
  relay.down = false;
  // The PC keeps working; time passes; a snapshot is written and old bundles pruned.
  for (const n of ['pc 1', 'pc 2', 'pc 3']) { pc.data.proj.clients.c2.notes = n; await pc.sync(); }
  pc.data.proj.clients.c2.name = 'Beta Renamed';
  c.t += 25 * 3600 * 1000;
  await pc.sync(); await pc.sync();
  assert.ok(relay.snapshot.seq >= 3, 'snapshot written');
  relay.pruneUpTo(relay.snapshot.seq);
  assert.ok(relay.bundles.length === 0 || relay.bundles[0].seq > phone.engine.getState().cursor + 1, 'phone cursor is behind the relay');

  let applied = 0;
  const r = await phone.engine.sync({
    getProj: () => phone.data.proj,
    applyWin: () => { applied++; },
    applySnapshot: p => { phone.data.proj = clone(p); applied += 100; },
  });
  assert.equal(r.status, 'idle');
  assert.ok(applied >= 100, 'phone data was replaced from the snapshot');
  assert.equal(phone.data.proj.clients.c2.name, 'Beta Renamed', 'PC changes arrive');
  assert.equal(phone.data.proj.clients.c2.notes, 'pc 3');
  assert.equal(phone.data.proj.clients.c1.notes, 'offline note', 'local note survives');
  assert.ok(phone.data.proj.clients.c1.visits.v9, 'local visit survives');
  assert.equal(r.pushed, 2, 'outbox uploaded');
  assert.equal(phone.engine.getState().outbox.length, 0);
  await pc.sync();
  assert.equal(pc.data.proj.clients.c1.visits.v9.date, '2026-11-08');
  assert.equal(pc.data.proj.clients.c1.notes, 'offline note');
  assert.deepEqual(phone.data.proj, pc.data.proj);
});

test('401 sets status error disconnected; outbox kept', async () => {
  const relay = makeRelay(), c = newClock();
  const { phone } = await pair(relay, c);
  await phone.sync();
  const seen = [];
  phone.engine.onStatus(s => seen.push(s.status + ':' + s.lastError));
  relay.revoked.add('phone1');
  phone.data.proj.clients.c1.notes = 'x';
  const r = await phone.sync();
  assert.equal(r.status, 'error');
  assert.equal(phone.engine.status, 'error');
  assert.equal(phone.engine.lastError, 'disconnected');
  assert.ok(seen.includes('error:disconnected'));
  assert.equal(phone.engine.getState().outbox.length, 1);
});

test('network failure sets offline and recovers', async () => {
  const relay = makeRelay(), c = newClock();
  const { phone } = await pair(relay, c);
  relay.down = true;
  assert.equal((await phone.sync()).status, 'offline');
  relay.down = false;
  assert.equal((await phone.sync()).status, 'idle');
  assert.equal(phone.engine.lastError, null);
});

test('garbage bundles are skipped, three in a row never block, a valid one after them applies', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone } = await pair(relay, c);
  await phone.sync();
  const junk = () => relay.bundles.push({ seq: ++relay.seq, device: 'pcid', bundle: '{"iv":"AAAA","ct":"AAAA"}' });
  junk();
  pc.data.proj.clients.c2.notes = 'after junk';
  await pc.sync();
  let r = await phone.sync();
  assert.equal(r.status, 'idle');
  assert.equal(r.skipped, 1);
  assert.equal(phone.data.proj.clients.c2.notes, 'after junk');

  junk(); junk(); junk();
  pc.data.proj.clients.c2.notes = 'after three';
  await pc.sync();
  r = await phone.sync();
  assert.equal(r.status, 'idle');
  assert.equal(r.skipped, 3);
  assert.equal(phone.data.proj.clients.c2.notes, 'after three');
  // the PC skips garbage too and keeps going
  for (let i = 0; i < 3; i++) relay.bundles.push({ seq: ++relay.seq, device: 'phone1', bundle: '{"iv":"AAAA","ct":"AAAA"}' });
  phone.data.proj.clients.c1.notes = 'phone after junk'; await phone.sync();
  r = await pc.sync();
  assert.equal(r.status, 'idle'); assert.equal(r.skipped, 3);
  assert.equal(pc.data.proj.clients.c1.notes, 'phone after junk');
});

test('a phone with the wrong key reports key-mismatch (snapshot does not open), cursor kept', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone } = await pair(relay, c);
  await phone.sync();
  const wrong = makeDevice('phone', relay, { key: await SyncCrypto.generateKey(), deviceId: 'phone1', pcDeviceId: 'pcid', clockRef: c, store: phone.store });
  for (let i = 0; i < 3; i++) { pc.data.proj.clients.c2.notes = 'n' + i; await pc.sync(); }
  const before = phone.store.peek().cursor;
  const r = await wrong.sync();
  assert.equal(r.status, 'error');
  assert.equal(wrong.engine.lastError, 'key-mismatch');
  assert.equal(wrong.store.peek().cursor, before);
  // a wrong key from the start fails at bootstrap
  const fresh = makeDevice('phone', relay, { key: await SyncCrypto.generateKey(), deviceId: 'phone2', pcDeviceId: 'pcid', clockRef: c });
  assert.equal((await fresh.sync()).error, 'key-mismatch');
});

test('bundle whose payload.from differs from the relay-assigned sender is rejected', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone, key } = await pair(relay, c);
  await phone.sync();
  const bundle = await SyncEngine.sealObj(key, {
    ops: [{ k: 'set', e: 'client', id: 'c1', f: 'name', v: 'Forged', t: c.t + 1e5, d: 'pcid' }], from: 'pcid', role: 'pc',
  }, SyncEngine.AAD_BUNDLE);
  // pushed with the phone's token, so the relay stamps it as phone1
  await relay.transport('phone1', false)('push', { bundle });
  const r = await pc.sync();
  assert.equal(r.skipped, 1);
  assert.equal(pc.data.proj.clients.c1.name, 'Alpha');
});

test('snapshot is written after 101 bundles, not after 100', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone } = await pair(relay, c);
  await phone.sync();
  assert.equal(relay.snapshot.seq, 0);
  for (let i = 1; i <= 100; i++) { phone.data.proj.clients.c1.notes = 'n' + i; await phone.sync(); }
  assert.equal(relay.seq, 100);
  await pc.sync();
  assert.equal(relay.snapshot.seq, 0, 'still the initial snapshot at 100 bundles');
  phone.data.proj.clients.c1.notes = 'n101'; await phone.sync();
  await pc.sync();
  assert.equal(relay.seq, 101);
  assert.equal(relay.snapshot.seq, 101);
  assert.equal(pc.engine.getState().bundlesSinceSnapshot, 0);
});

test('phone op editing client.name is ignored by the PC', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone, key } = await pair(relay, c);
  await phone.sync();
  // The engine itself never sends it; craft one as a hostile phone would.
  const bundle = await SyncEngine.sealObj(key, {
    ops: [
      { k: 'set', e: 'client', id: 'c1', f: 'name', v: 'Hacked', t: c.t + 1e5, d: 'phone1' },
      { k: 'set', e: 'client', id: 'c1', f: 'notes', v: 'fine', t: c.t + 1e5 + 1, d: 'phone1' },
    ], from: 'phone1', role: 'phone',
  }, SyncEngine.AAD_BUNDLE);
  await relay.transport('phone1', false)('push', { bundle });
  const r = await pc.sync();
  assert.equal(r.ignored, 1);
  assert.equal(pc.data.proj.clients.c1.name, 'Alpha');
  assert.equal(pc.data.proj.clients.c1.notes, 'fine');

  // And a name edit on the phone is never captured.
  phone.data.proj.clients.c2.name = 'Nope';
  assert.equal(await phone.engine.capture(phone.data.proj), 0);
});

test('restored client: visit logged on phone for a client the PC deleted', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone } = await pair(relay, c);
  await phone.sync();
  delete pc.data.proj.clients.c2;
  await pc.sync();
  phone.data.proj.clients.c2.visits.v7 = visit('v7', '2026-11-10');
  const r = await phone.sync(); // pulls the delete (kept: it has a visit), pushes the visit
  assert.equal(r.status, 'idle');
  assert.ok(phone.data.proj.clients.c2, 'phone keeps the client');
  await pc.sync();
  assert.ok(pc.data.proj.clients.c2, 'client restored on PC');
  assert.equal(pc.data.proj.clients.c2.name, 'Beta');
  assert.equal(pc.data.proj.clients.c2.visits.v7.date, '2026-11-10');
});

test('a 5 MB-of-JSON snapshot round-trips (gzip) and fits a small bundle', async () => {
  const relay = makeRelay(), c = newClock();
  const proj = baseProj();
  for (let i = 0; i < 3000; i++) proj.clients['x' + i] = { ...proj.clients.c1, id: 'x' + i, name: 'Client ' + i, address: i + ' rue de la Paix', notes: 'note '.repeat(60) + i, visits: {} };
  assert.ok(JSON.stringify(proj).length > 1_000_000);
  const big = 'lorem ipsum dolor sit amet '.repeat(200000);
  proj.clients.c1.notes = big; // 5.4 MB of JSON in one field
  assert.ok(JSON.stringify(proj).length > 5_000_000);
  const key = await SyncCrypto.generateKey();
  const pc = makeDevice('pc', relay, { key, deviceId: 'pcid', proj, clockRef: c });
  await pc.engine.initPc(proj);
  assert.ok(relay.snapshot.bundle.length < 1024 * 1024, 'compressed snapshot is small: ' + relay.snapshot.bundle.length);
  const phone = makeDevice('phone', relay, { key, deviceId: 'phone1', pcDeviceId: 'pcid', clockRef: c });
  const r = await phone.sync();
  assert.equal(r.status, 'idle');
  assert.deepEqual(phone.data.proj, proj);
});

test('concurrent sync calls share one run', async () => {
  const relay = makeRelay(), c = newClock();
  const { phone } = await pair(relay, c);
  const a = phone.sync(), b = phone.sync();
  assert.equal(a, b);
  await a;
  assert.notEqual(phone.sync(), a);
});

test('large outbox is split into several bundles', async () => {
  const relay = makeRelay(), c = newClock();
  const { phone } = await pair(relay, c);
  await phone.sync();
  const big = 'x'.repeat(9000);
  for (let i = 0; i < 150; i++) phone.data.proj.clients.c1.visits['b' + i] = { ...visit('b' + i, '2026-11-01'), note: big };
  const r = await phone.sync();
  assert.equal(r.pushed, 150);
  assert.ok(r.bundles >= 2);
  for (const b of relay.bundles) assert.ok(b.bundle.length < 1.5 * 1024 * 1024);
});

// ---- real PHP relay -----------------------------------------------------------------------------------------
const SERVER_DIR = path.join(__dirname, '..', 'server');
const PHP = process.env.PHP_BIN || 'php';
const hasPhp = (() => { try { return spawnSync(PHP, ['-v'], { encoding: 'utf8' }).status === 0; } catch { return false; } })();
const SKIP = hasPhp ? false : 'PHP not found (put php on PATH or set PHP_BIN); PHP integration test skipped';
const SETUP = 'test-setup-code-0123456789';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startPhp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-engine-'));
  const cfgFile = path.join(dir, 'config.php');
  const dataDir = path.join(dir, 'data').replace(/\\/g, '/');
  fs.writeFileSync(cfgFile, `<?php return ['SETUP_CODE' => '${SETUP}', 'DATA_DIR' => '${dataDir}'];\n`);
  const port = await freePort();
  const proc = spawn(PHP, ['-S', `127.0.0.1:${port}`, '-t', SERVER_DIR], { env: { ...process.env, CC_RELAY_CONFIG: cfgFile }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}/index.php`;
  const post = async (body, token) => {
    const res = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token, 'X-CC-Token': token } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { await post({ action: 'hello' }); up = true; } catch { await new Promise(r => setTimeout(r, 100)); } }
  if (!up) { proc.kill(); throw new Error('php -S did not start'); }
  const transportFor = token => async (action, body) => {
    let res;
    try { res = await post({ action, ...body }, token); } catch (e) { const err = new Error('network'); err.network = true; throw err; }
    if (res.status < 200 || res.status >= 300 || !res.json || res.json.ok !== true) { const err = new Error((res.json && res.json.error) || 'http ' + res.status); err.status = res.status; throw err; }
    return res.json;
  };
  return {
    post, transportFor,
    async stop() { proc.kill(); await new Promise(r => setTimeout(r, 150)); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('PC and phone engines converge through the real PHP relay', { skip: SKIP }, async () => {
  const relay = await startPhp();
  try {
    const claim = (await relay.post({ action: 'claim', setupCode: SETUP })).json;
    const admin = claim.adminToken;
    assert.match(claim.deviceId, /^[a-f0-9]{32}$/);
    const who = (await relay.post({ action: 'whoami' }, admin)).json;
    assert.deepEqual([who.ok, who.deviceId, who.admin], [true, claim.deviceId, true]);
    assert.match(who.epoch, /^[a-f0-9]{16}$/);
    const dev = (await relay.post({ action: 'addDevice', name: 'Test phone' }, admin)).json;
    const key = await SyncCrypto.generateKey();

    const pcData = { proj: baseProj() };
    const pc = SyncEngine.create({ role: 'pc', config: { key, deviceId: claim.deviceId }, transport: relay.transportFor(admin), store: memStore() });
    await pc.initPc(pcData.proj);

    const phoneData = { proj: null };
    const phone = SyncEngine.create({ role: 'phone', config: { key, deviceId: dev.deviceId, pcDeviceId: claim.deviceId }, transport: relay.transportFor(dev.token), store: memStore() });
    const hooks = (d) => ({
      getProj: () => d.proj,
      applyWin: w => SyncOps.applyToProj(d.proj, w),
      applySnapshot: p => { d.proj = clone(p); },
    });
    let r = await phone.sync(hooks(phoneData));
    assert.equal(r.status, 'idle');
    assert.deepEqual(phoneData.proj, pcData.proj);

    phoneData.proj.clients.c1.visits.v1 = visit('v1', '2026-11-09');
    phoneData.proj.clients.c1.notes = 'phone note';
    pcData.proj.clients.c2.notes = 'pc note';
    r = await phone.sync(hooks(phoneData));
    assert.equal(r.pushed, 2);
    r = await pc.sync(hooks(pcData));
    assert.equal(r.status, 'idle');
    assert.equal(r.pulled, 1);
    await phone.sync(hooks(phoneData));
    assert.deepEqual(phoneData.proj, pcData.proj);
    assert.equal(pcData.proj.clients.c1.visits.v1.date, '2026-11-09');

    // Revoked phone gets 401 from the real relay.
    await relay.post({ action: 'revokeDevice', deviceId: dev.deviceId }, admin);
    r = await phone.sync(hooks(phoneData));
    assert.equal(r.status, 'error');
    assert.equal(phone.lastError, 'disconnected');
  } finally { await relay.stop(); }
});


// ---- review findings: engine level -----------------------------------------------------------------------------
const hooks = d => ({ getProj: () => d.proj, applyWin: w => SyncOps.applyToProj(d.proj, w), applySnapshot: p => { d.proj = clone(p); } });
const emptyProj = () => ({ clients: {}, groups: {}, prospects: {}, settings: {} });
const rawBundle = (relay, key, device, ops, from) => SyncEngine.sealObj(key, { ops, from: from || device, role: 'pc' }, SyncEngine.AAD_BUNDLE)
  .then(bundle => relay.transport(device, device === 'pcid')('push', { bundle }));

test('H1: an answer without a sequence number (or without epoch/bundles) is bad-response and the outbox stays', async () => {
  const relay = makeRelay(), c = newClock();
  let mode = null;
  const { phone } = await pair(relay, c, { wrap: base => async (a, b) => {
    const j = await base(a, b);
    if (mode === 'push' && a === 'push') return { ok: true };
    if (mode === 'pull' && a === 'pull') return { ok: true, epoch: j.epoch };
    return j;
  } });
  await phone.sync();
  phone.data.proj.clients.c1.notes = 'keep me';
  mode = 'push';
  let r = await phone.sync();
  assert.deepEqual([r.status, r.error], ['error', 'bad-response']);
  assert.equal(phone.engine.getState().outbox.length, 1);
  mode = 'pull';
  r = await phone.sync();
  assert.equal(r.error, 'bad-response');
  assert.equal(phone.engine.getState().outbox.length, 1);
  mode = null;
  r = await phone.sync();
  assert.equal(r.status, 'idle'); assert.equal(r.pushed, 1);
  assert.equal(phone.engine.getState().outbox.length, 0);
});

test('H3: forged bundles (restore from cl, __proto__, malformed op, future clock) are dropped and sync is not wedged', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone, key } = await pair(relay, c);
  await phone.sync();
  const t = c.t + 1000;
  await rawBundle(relay, key, 'pcid', [
    { k: 'visit', e: 'visit', id: 'vx', c: 'c99', v: { id: 'vx', date: '2026-01-01' }, cl: { name: 'Fake client', lat: 1, lng: 2 }, t, d: 'pcid' },   // H3a: no tombstone
    { k: 'add', e: 'client', id: '__proto__', v: { name: 'polluted', polluted: true }, t, d: 'pcid' },                                                   // H3b
    { k: 'set', e: 'client', id: '__proto__', f: 'notes', v: 'polluted', t, d: 'pcid' },
    { t: 5, k: 7 }, null, 'text', { k: 'set', e: 'client', id: 'c1', f: 'notes', v: 'ok-after-bad', t, d: 'pcid' },                                    // H3c
    { k: 'set', e: 'client', id: 'c2', f: 'notes', v: 'future', t: 1e308, d: 'pcid' },                                                                // H3d
  ]);
  await rawBundle(relay, key, 'pcid', [{ k: 'set', e: 'client', id: 'c2', f: 'name', v: 'Valid later', t: t + 1, d: 'pcid' }]);
  const r = await phone.sync();
  assert.equal(r.status, 'idle');
  assert.ok(r.invalid >= 6, 'invalid ops counted: ' + r.invalid);
  assert.equal(phone.data.proj.clients.c99, undefined);
  assert.equal(Object.hasOwn(phone.data.proj.clients, '__proto__'), false);
  assert.equal({}.polluted, undefined);
  assert.equal(phone.data.proj.clients.c1.notes, 'ok-after-bad');
  assert.equal(phone.data.proj.clients.c2.name, 'Valid later');
  assert.ok(phone.engine.getState().clockT < 2_000_000_000_000, 'clock not poisoned');
  // and the same payload sent by a phone to the PC
  await rawBundle(relay, key, 'phone1', [{ k: 'visit', e: 'visit', id: 'vy', c: 'c99', v: { id: 'vy' }, cl: { name: 'Fake' }, t, d: 'phone1' }, { t: 1e308, k: 'visit' }]);
  const r2 = await pc.sync();
  assert.equal(r2.status, 'idle');
  assert.equal(pc.data.proj.clients.c99, undefined);
});

test('a bundle that inflates beyond 16 MB is rejected', async () => {
  const relay = makeRelay(), c = newClock();
  const { phone, key } = await pair(relay, c);
  await phone.sync();
  await rawBundle(relay, key, 'pcid', [{ k: 'set', e: 'client', id: 'c1', f: 'notes', v: 'x', t: c.t + 5, d: 'pcid' }].concat([]));
  const big = await SyncEngine.sealObj(key, { ops: [], from: 'pcid', pad: 'x'.repeat(20 * 1024 * 1024) }, SyncEngine.AAD_BUNDLE);
  await relay.transport('pcid', true)('push', { bundle: big });
  const r = await phone.sync();
  assert.equal(r.status, 'idle'); assert.equal(r.skipped, 1);
  assert.equal(phone.data.proj.clients.c1.notes, 'x');
});

test('M5: relay seq going backwards is relay-rollback and nothing is applied or pushed', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone } = await pair(relay, c);
  pc.data.proj.clients.c1.notes = 'a'; await pc.sync();
  await phone.sync();
  assert.ok(phone.engine.getState().cursor > 0);
  relay.bundles = []; relay.seq = 0; // the server was restored from an old copy
  phone.data.proj.clients.c1.notes = 'unsent';
  const r = await phone.sync();
  assert.deepEqual([r.status, r.error], ['error', 'relay-rollback']);
  assert.equal(relay.bundles.length, 0, 'nothing pushed');
  assert.equal(phone.engine.getState().outbox.length, 1);
});

test('M5: a different epoch is relay-reset', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone } = await pair(relay, c);
  await phone.sync();
  relay.epoch = 'ffffffffffffffff';
  const r = await phone.sync();
  assert.deepEqual([r.status, r.error], ['error', 'relay-reset']);
  assert.equal((await pc.sync()).error, 'relay-reset');
});

test('breaker: more than 5 clients / 5 prospects / 20 visits waits for the user; 5 does not', async () => {
  const relay = makeRelay(), c = newClock();
  const key = await SyncCrypto.generateKey();
  const proj = baseProj();
  for (let i = 0; i < 12; i++) proj.clients['k' + i] = { ...proj.clients.c1, id: 'k' + i, name: 'K' + i, visits: {} };
  for (let i = 0; i < 12; i++) proj.prospects['q' + i] = { ...proj.prospects.p1, id: 'q' + i };
  for (let i = 0; i < 30; i++) proj.clients.k11.visits['w' + i] = visit('w' + i, '2026-10-01');
  const pc = makeDevice('pc', relay, { key, deviceId: 'pcid', proj: clone(proj), clockRef: c });
  await pc.engine.initPc(pc.data.proj);
  const phone = makeDevice('phone', relay, { key, deviceId: 'phone1', pcDeviceId: 'pcid', clockRef: c });
  await phone.sync();

  for (let i = 0; i < 5; i++) delete pc.data.proj.clients['k' + i];
  assert.equal(await pc.engine.capture(pc.data.proj), 5);
  assert.equal(pc.engine.needsConfirm, null);
  await pc.sync(); await phone.sync();
  assert.equal(phone.data.proj.clients.k0, undefined);

  // 6 clients: held
  for (let i = 5; i < 11; i++) delete pc.data.proj.clients['k' + i];
  assert.equal(await pc.engine.capture(pc.data.proj), 0);
  assert.deepEqual(pc.engine.needsConfirm, { clients: 6, prospects: 0, groups: 0, visits: 0 });
  assert.equal(pc.engine.getState().outbox.length, 0);
  let r = await pc.sync(hooks(pc.data));
  assert.deepEqual(r.needsConfirm, { clients: 6, prospects: 0, groups: 0, visits: 0 });
  await phone.sync();
  assert.ok(phone.data.proj.clients.k6, 'phone keeps them while waiting');
  // keep: they come back to the PC, phones untouched
  const kept = await pc.engine.confirmDeletes(false);
  assert.equal(pc.engine.needsConfirm, null);
  assert.equal(kept.restore.filter(o => o.k === 'add').length, 6);
  SyncOps.applyToProj(pc.data.proj, kept.restore);
  assert.deepEqual(Object.keys(pc.data.proj.clients).sort(), Object.keys(phone.data.proj.clients).sort());
  assert.equal(await pc.engine.capture(pc.data.proj), 0, 'nothing left to send');

  // 6 prospects, then confirm to send
  for (let i = 0; i < 6; i++) delete pc.data.proj.prospects['q' + i];
  await pc.engine.capture(pc.data.proj);
  assert.deepEqual(pc.engine.needsConfirm, { clients: 0, prospects: 6, groups: 0, visits: 0 });
  const sent = await pc.engine.confirmDeletes(true);
  assert.equal(sent.queued, 6);
  await pc.sync(); await phone.sync();
  assert.equal(phone.data.proj.prospects.q0, undefined);

  // 21 visits
  for (let i = 0; i < 21; i++) delete pc.data.proj.clients.k11.visits['w' + i];
  await pc.engine.capture(pc.data.proj);
  assert.deepEqual(pc.engine.needsConfirm, { clients: 0, prospects: 0, groups: 0, visits: 21 });
  const back = await pc.engine.confirmDeletes(false);
  assert.equal(back.restore.length, 21);
  SyncOps.applyToProj(pc.data.proj, back.restore);
  assert.equal(Object.keys(pc.data.proj.clients.k11.visits).length, 30);
});

test('rebase: restoring an older copy keeps what the phone has; start empty does not wipe the phone', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone } = await pair(relay, c);
  await phone.sync();
  phone.data.proj.clients.c1.visits.v1 = visit('v1', '2026-11-09');
  await phone.sync(); await pc.sync();
  assert.ok(pc.data.proj.clients.c1.visits.v1);

  // The PC restores an older copy: no v1, no c2.
  const older = baseProj(); delete older.clients.c2; older.clients.c1.notes = 'older note';
  pc.data.proj = clone(older);
  const rb = await pc.engine.rebase(pc.data.proj);
  assert.ok(rb.ops.some(o => o.k === 'visit' && o.id === 'v1'));
  assert.ok(rb.ops.some(o => o.k === 'add' && o.id === 'c2'));
  SyncOps.applyToProj(pc.data.proj, rb.ops);
  assert.ok(pc.data.proj.clients.c2 && pc.data.proj.clients.c1.visits.v1);
  await pc.sync(); await phone.sync();
  assert.ok(phone.data.proj.clients.c2, 'phone still has c2');
  assert.ok(phone.data.proj.clients.c1.visits.v1, 'phone still has its visit');
  assert.equal(pc.engine.getState().outbox.length, 0);

  // Start empty
  pc.data.proj = emptyProj();
  const rb2 = await pc.engine.rebase(pc.data.proj);
  assert.deepEqual(rb2.ops.filter(o => o.k === 'add').map(o => o.id).sort(), ['c1', 'c2', 'g1', 'p1']);
  const dels = pc.engine.getState().outbox.filter(o => o.k === 'del' && o.e !== 'group');
  assert.equal(dels.length, 0, 'no client/prospect/visit deletion queued');
  SyncOps.applyToProj(pc.data.proj, rb2.ops);
  await pc.sync(); await phone.sync();
  assert.ok(phone.data.proj.clients.c1 && phone.data.proj.clients.c2 && phone.data.proj.prospects.p1);
  assert.ok(phone.data.proj.clients.c1.visits.v1);
});

test('after the PC saved its snapshot it compacts the relay up to it', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone } = await pair(relay, c);
  await phone.sync();
  for (let i = 1; i <= 101; i++) { phone.data.proj.clients.c1.notes = 'n' + i; await phone.sync(); }
  await pc.sync();
  assert.equal(relay.snapshot.seq, 101);
  assert.deepEqual(relay.compacts, [101]);
  assert.equal(relay.bundles.length, 0);
  phone.data.proj.clients.c1.notes = 'again'; // phone cursor = relay's, still fine
  assert.equal((await phone.sync()).status, 'idle');
});

test('rekey end to end on the real PHP relay: the old key and token read nothing', { skip: SKIP }, async () => {
  const relay = await startPhp();
  try {
    const claim = (await relay.post({ action: 'claim', setupCode: SETUP })).json;
    const admin = claim.adminToken;
    const dev = (await relay.post({ action: 'addDevice', name: 'Old phone' }, admin)).json;
    const oldKey = await SyncCrypto.generateKey();
    const pcData = { proj: baseProj() };
    const pcStore = memStore();
    let pc = SyncEngine.create({ role: 'pc', config: { key: oldKey, deviceId: claim.deviceId }, transport: relay.transportFor(admin), store: pcStore });
    await pc.initPc(pcData.proj);
    const phoneData = { proj: null };
    const phone = SyncEngine.create({ role: 'phone', config: { key: oldKey, deviceId: dev.deviceId, pcDeviceId: claim.deviceId }, transport: relay.transportFor(dev.token), store: memStore() });
    assert.equal((await phone.sync(hooks(phoneData))).status, 'idle');

    // Reset sync key: new key, relay rekey, fresh engine, new snapshot
    const newKey = await SyncCrypto.generateKey();
    await relay.transportFor(admin)('rekey', {});
    pc = SyncEngine.create({ role: 'pc', config: { key: newKey, deviceId: claim.deviceId }, transport: relay.transportFor(admin), store: memStore() });
    await pc.initPc(pcData.proj);
    pcData.proj.clients.c1.notes = 'secret after reset';
    assert.equal((await pc.sync(hooks(pcData))).status, 'idle');

    const r = await phone.sync(hooks(phoneData));
    assert.deepEqual([r.status, r.error], ['error', 'disconnected']);
    assert.notEqual(phoneData.proj.clients.c1.notes, 'secret after reset');
    // even someone holding the revoked token and old key cannot read the new data
    const snap = (await relay.post({ action: 'getSnapshot' }, dev.token));
    assert.equal(snap.status, 401);
    const adminSnap = (await relay.post({ action: 'getSnapshot' }, admin)).json;
    await assert.rejects(SyncEngine.openObj(oldKey, adminSnap.bundle, SyncEngine.AAD_SNAPSHOT));
    assert.ok(await SyncEngine.openObj(newKey, adminSnap.bundle, SyncEngine.AAD_SNAPSHOT));
    // a new phone pairs with the new key
    const dev2 = (await relay.post({ action: 'addDevice', name: 'New phone' }, admin)).json;
    const p2 = { proj: null };
    const phone2 = SyncEngine.create({ role: 'phone', config: { key: newKey, deviceId: dev2.deviceId, pcDeviceId: claim.deviceId }, transport: relay.transportFor(dev2.token), store: memStore() });
    assert.equal((await phone2.sync(hooks(p2))).status, 'idle');
    assert.equal(p2.proj.clients.c1.notes, 'secret after reset');
  } finally { await relay.stop(); }
});


// ---- second review round
test('N4: a 507 on the PC makes it snapshot and compact once, then the push goes through', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone } = await pair(relay, c);
  await phone.sync();
  pc.data.proj.clients.c1.notes = 'one'; await pc.sync();
  const size = relay.bundles.find(b => b.device === 'pcid').bundle.length;
  relay.quota = Math.floor(size * 2.5);
  pc.data.proj.clients.c1.notes = 'two'; await pc.sync();
  pc.data.proj.clients.c1.notes = 'three';
  const r = await pc.sync(); // third bundle would exceed the quota
  assert.equal(r.status, 'idle', r.error);
  assert.ok(relay.compacts.length >= 1, 'compacted');
  assert.equal(pc.engine.getState().outbox.length, 0);
  // a phone behind the compaction recovers from the snapshot and sees the latest note
  await phone.sync();
  assert.equal(phone.data.proj.clients.c1.notes, 'three');
  // a 507 that compaction cannot fix is still reported, with the outbox kept
  relay.quota = 10;
  pc.data.proj.clients.c1.notes = 'four';
  const r2 = await pc.sync();
  assert.deepEqual([r2.status, r2.error], ['error', 'relay-full']);
  assert.equal(pc.engine.getState().outbox.length, 1);
});

test('N5: groups are held with the other deletions and restored with them', async () => {
  const relay = makeRelay(), c = newClock();
  const key = await SyncCrypto.generateKey();
  const proj = baseProj();
  for (let i = 0; i < 8; i++) proj.clients['k' + i] = { ...proj.clients.c1, id: 'k' + i, visits: {} };
  const pc = makeDevice('pc', relay, { key, deviceId: 'pcid', proj: clone(proj), clockRef: c });
  await pc.engine.initPc(pc.data.proj);
  pc.data.proj = emptyProj();
  await pc.engine.capture(pc.data.proj);
  assert.equal(pc.engine.needsConfirm.groups, 1);
  assert.equal(pc.engine.getState().outbox.filter(o => o.k === 'del').length, 0, 'no group deletion went out either');
  const back = await pc.engine.confirmDeletes(false);
  assert.ok(back.restore.some(o => o.k === 'add' && o.e === 'group' && o.id === 'g1'));
  SyncOps.applyToProj(pc.data.proj, back.restore);
  assert.ok(pc.data.proj.groups.g1);
});

test('N7: visits that go with a deleted client are not counted twice', async () => {
  const relay = makeRelay(), c = newClock();
  const key = await SyncCrypto.generateKey();
  const proj = baseProj();
  for (let i = 0; i < 30; i++) proj.clients.c1.visits['w' + i] = visit('w' + i, '2026-10-01');
  const pc = makeDevice('pc', relay, { key, deviceId: 'pcid', proj: clone(proj), clockRef: c });
  await pc.engine.initPc(pc.data.proj);
  delete pc.data.proj.clients.c1;
  const n = await pc.engine.capture(pc.data.proj);
  assert.equal(pc.engine.needsConfirm, null);
  assert.equal(n, 31);
});

test('M4+: a batch the window keeps refusing is quarantined on the third try, and sync goes on', async () => {
  const relay = makeRelay(), c = newClock();
  const quarantined = [];
  const store = memStore(); store.quarantine = async t => { quarantined.push(t); };
  const { pc, phone } = await pair(relay, c);
  const pcStore = pc.store; pcStore.quarantine = async t => { quarantined.push(t); };
  await phone.sync();
  phone.data.proj.clients.c1.notes = 'poison'; await phone.sync();
  const refuse = () => pc.engine.sync({ getProj: () => pc.data.proj, applyWin: async () => { throw new Error('window-refused'); } });
  assert.equal((await refuse()).error, 'window-refused');
  assert.equal((await refuse()).error, 'window-refused');
  assert.equal((await refuse()).error, 'window-refused'); // third: set aside
  phone.data.proj.clients.c2.notes = 'fine'; await phone.sync();
  const r = await pc.sync();
  assert.equal(r.status, 'idle'); assert.equal(quarantined.length, 1);
  assert.equal(pc.data.proj.clients.c1.notes, '', 'the refused batch was not applied');
  assert.equal(pc.data.proj.clients.c2.notes, 'fine');
  // "window not ready" never counts
  phone.data.proj.clients.c2.notes = 'later'; await phone.sync();
  for (let i = 0; i < 5; i++) await pc.engine.sync({ getProj: () => pc.data.proj, applyWin: async () => { throw new Error('window-not-ready'); } });
  assert.equal((await pc.sync()).status, 'idle');
  assert.equal(pc.data.proj.clients.c2.notes, 'later');
});

test('N2: typed garbage from a phone is dropped while valid ops in the same bundle apply', async () => {
  const relay = makeRelay(), c = newClock();
  const { pc, phone, key } = await pair(relay, c);
  await phone.sync();
  const t = c.t + 1000;
  await rawBundle(relay, key, 'phone1', [
    { k: 'visit', e: 'visit', id: 'v1', c: 'c1', v: { id: 'v1', date: 'yesterday' }, t, d: 'phone1' },
    { k: 'visit', e: 'visit', id: 'v2', c: 'c1', v: { id: 'v2', date: '2026-11-09', status: 'weird' }, t, d: 'phone1' },
    { k: 'set', e: 'client', id: 'c1', f: 'notes', v: { not: 'a string' }, t, d: 'phone1' },
    { k: 'set', e: 'prospect', id: 'p1', f: 'status', v: 'bogus', t, d: 'phone1' },
    { k: 'visit', e: 'visit', id: 'v3', c: 'c1', v: { id: 'v3', date: '2026-11-09', status: 'done', type: 'visit', outcome: 'ok', note: 'good', evil: 'x' }, t, d: 'phone1' },
    { k: 'set', e: 'client', id: 'ghost', f: 'notes', v: 'x', t, d: 'phone1' },
  ], 'phone1');
  const r = await pc.sync();
  assert.equal(r.status, 'idle'); assert.equal(r.invalid, 4);
  assert.deepEqual(Object.keys(pc.data.proj.clients.c1.visits), ['v3']);
  assert.equal(pc.data.proj.clients.c1.visits.v3.evil, undefined);
  assert.equal(Object.keys(pc.engine.getState().stamps).some(k => k.includes('ghost')), false);
});

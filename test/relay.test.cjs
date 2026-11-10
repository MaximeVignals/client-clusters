'use strict';
// Tests for the PHP sync relay (server/index.php), driven over HTTP against `php -S`.
// Skipped when no php binary is available (PATH, or set PHP_BIN).
// Note: php -S ignores .htaccess; the Apache protection of the data folder is not covered here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const PHP = process.env.PHP_BIN || 'php';
const hasPhp = (() => {
  try { return spawnSync(PHP, ['-v'], { encoding: 'utf8' }).status === 0; } catch { return false; }
})();
const SKIP = hasPhp ? false : 'PHP not found (put php on PATH or set PHP_BIN); relay tests skipped';
const SETUP = 'test-setup-code-0123456789';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function phpValue(v) {
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

async function startRelay(cfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-relay-'));
  const dataDir = path.join(dir, 'data');
  const conf = Object.assign({ SETUP_CODE: SETUP, DATA_DIR: dataDir }, cfg);
  if (conf.DATA_DIR === null) delete conf.DATA_DIR; // use the relay's derived default folder
  const cfgFile = path.join(dir, 'config.php');
  const arr = Object.entries(conf).map(([k, v]) => `'${k}' => ${phpValue(v)}`).join(', ');
  fs.writeFileSync(cfgFile, `<?php return [${arr}];\n`);
  const port = await freePort();
  const proc = spawn(PHP, ['-d', 'post_max_size=64M', '-d', 'memory_limit=512M', '-S', `127.0.0.1:${port}`, '-t', SERVER_DIR], {
    env: { ...process.env, CC_RELAY_CONFIG: cfgFile },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}/index.php`;
  const relay = {
    base, dataDir, dir, conf,
    async call(body, { token, headers = {}, raw, method = 'POST' } = {}) {
      const h = { 'Content-Type': 'application/json', ...headers };
      if (token) h.Authorization = 'Bearer ' + token;
      const res = await fetch(base, {
        method, headers: h, body: method === 'POST' ? (raw ?? JSON.stringify(body)) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, text, headers: res.headers };
    },
    async stop() {
      proc.kill();
      await new Promise((r) => setTimeout(r, 150));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { await relay.call({ action: 'hello' }); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!up) { await relay.stop(); throw new Error('php -S did not start'); }
  return relay;
}

async function claimed(relay) {
  const r = await relay.call({ action: 'claim', setupCode: SETUP });
  assert.equal(r.status, 200);
  return r.json.adminToken;
}

test('relay (php -S)', { skip: SKIP }, async (t) => {
  await t.test('hello, claim once, setup code, auth basics', async () => {
    const r = await startRelay();
    try {
      let h = await r.call({ action: 'hello' });
      assert.equal(h.status, 200);
      assert.equal(h.json.app, 'client-clusters-relay');
      assert.equal(h.json.claimed, false);

      assert.equal((await r.call({ action: 'claim', setupCode: 'nope' })).status, 403);
      assert.equal((await r.call({ action: 'claim' })).status, 403);
      const claim = await r.call({ action: 'claim', setupCode: SETUP }).catch(() => null);
      assert.equal(claim.status, 200);
      const admin = claim.json.adminToken;
      assert.match(admin, /^[A-Za-z0-9_-]{43}$/);
      assert.match(claim.json.deviceId, /^[a-f0-9]{32}$/);
      const who = await r.call({ action: 'whoami' }, { token: admin });
      assert.deepEqual(who.json, { ok: true, deviceId: claim.json.deviceId, admin: true, epoch: claim.json.epoch });
      assert.equal((await r.call({ action: 'whoami' })).status, 401);
      const dv = (await r.call({ action: 'addDevice', name: 'p' }, { token: admin })).json;
      assert.deepEqual((await r.call({ action: 'whoami' }, { token: dv.token })).json, { ok: true, deviceId: dv.deviceId, admin: false, epoch: claim.json.epoch });
      assert.equal((await r.call({ action: 'claim', setupCode: SETUP })).status, 409);
      h = await r.call({ action: 'hello' });
      assert.equal(h.json.claimed, true);

      // only hashes on disk
      const state = fs.readFileSync(path.join(r.dataDir, 'state.json'), 'utf8');
      assert.ok(!state.includes(admin));

      assert.equal((await r.call({ action: 'pull', since: 0 })).status, 401);
      assert.equal((await r.call({ action: 'pull', since: 0 }, { token: 'garbage' })).status, 401);
      assert.equal((await r.call({ action: 'pull', since: 0 }, { token: 'A'.repeat(43) })).status, 401);
      assert.equal((await r.call({ action: 'pull', since: 0 }, { token: admin })).status, 200);
      // the JSON-body token fallback is gone
      assert.equal((await r.call({ action: 'pull', since: 0, token: admin })).status, 401);
      assert.equal((await r.call({ action: 'nope' }, { token: admin })).status, 400);
      assert.equal((await r.call({}, { token: admin })).status, 400);
    } finally { await r.stop(); }
  });

  await t.test('request validation and no CORS', async () => {
    const r = await startRelay();
    try {
      const get = await r.call(null, { method: 'GET' });
      assert.equal(get.status, 405);
      assert.equal(get.json.ok, false);
      assert.equal((await r.call(null, { raw: 'x=1', headers: { 'Content-Type': 'text/plain' } })).status, 415);
      assert.equal((await r.call(null, { raw: '{not json' })).status, 400);
      assert.equal((await r.call(null, { raw: '[1,2]' })).status, 400);
      const big = await r.call(null, { raw: '{"action":"hello","pad":"' + 'a'.repeat(2 * 1024 * 1024 + 8192) + '"}' });
      assert.equal(big.status, 413);
      // no CORS: no preflight handler, no CORS headers anywhere
      const pre = await fetch(r.base, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
      });
      assert.equal(pre.status, 405);
      assert.equal(pre.headers.get('access-control-allow-origin'), null);
      const hello = await r.call({ action: 'hello' }, { headers: { Origin: 'http://localhost' } });
      assert.equal(h(hello, 'access-control-allow-origin'), null);
      assert.equal(h(get, 'access-control-allow-origin'), null);
    } finally { await r.stop(); }
    function h(res, name) { return res.headers.get(name); }
  });

  await t.test('not configured (short setup code) -> 500 on auth actions, hello still works', async () => {
    const r = await startRelay({ SETUP_CODE: 'short' });
    try {
      assert.equal((await r.call({ action: 'hello' })).status, 200);
      const c = await r.call({ action: 'claim', setupCode: 'short' });
      assert.equal(c.status, 500);
      assert.equal(c.json.error, 'Relay not configured');
      assert.equal((await r.call({ action: 'pull', since: 0 }, { token: 'A'.repeat(43) })).status, 500);
    } finally { await r.stop(); }
  });

  await t.test('devices, push/pull ordering, paging, revocation', async () => {
    const r = await startRelay({ RATE_LIMIT: 100000 });
    try {
      const admin = await claimed(r);
      assert.equal((await r.call({ action: 'addDevice', name: 'Phone' })).status, 401);
      const add = await r.call({ action: 'addDevice', name: 'Pixel' }, { token: admin });
      assert.equal(add.status, 200);
      const { deviceId, token: dev } = add.json;
      assert.match(deviceId, /^[a-f0-9]{32}$/);
      assert.equal(add.json.hash, undefined);

      // device token cannot use admin actions
      for (const body of [{ action: 'addDevice', name: 'x' }, { action: 'listDevices' }, { action: 'revokeDevice', deviceId }, { action: 'putSnapshot', seq: 0, bundle: 'x' }]) {
        assert.equal((await r.call(body, { token: dev })).status, 403, body.action);
      }
      const list = await r.call({ action: 'listDevices' }, { token: admin });
      assert.equal(list.json.devices.length, 1);
      assert.equal(list.json.devices[0].name, 'Pixel');
      assert.equal(list.json.devices[0].token, undefined);

      // ordering + device id derived from the token (request value ignored)
      const p1 = await r.call({ action: 'push', bundle: 'first', device: 'evil' }, { token: dev });
      const p2 = await r.call({ action: 'push', bundle: 'second' }, { token: admin });
      assert.equal(p1.json.seq, 1);
      assert.equal(p2.json.seq, 2);
      const pulled = await r.call({ action: 'pull', since: 0 }, { token: dev });
      assert.deepEqual(pulled.json.bundles.map((b) => [b.seq, b.bundle]), [[1, 'first'], [2, 'second']]);
      assert.equal(pulled.json.bundles[0].device, deviceId);
      assert.notEqual(pulled.json.bundles[1].device, deviceId);
      assert.equal(pulled.json.more, false);
      assert.equal(pulled.json.snapshot, null);
      assert.equal(pulled.json.oldest, 1);
      assert.deepEqual((await r.call({ action: 'pull', since: 1 }, { token: dev })).json.bundles.map((b) => b.seq), [2]);
      assert.deepEqual((await r.call({ action: 'pull', since: '1' }, { token: dev })).json.bundles.map((b) => b.seq), [2]);

      // paging at 200
      for (let i = 3; i <= 205; i++) await r.call({ action: 'push', bundle: 'b' + i }, { token: dev });
      const page1 = await r.call({ action: 'pull', since: 0 }, { token: dev });
      assert.equal(page1.json.bundles.length, 200);
      assert.equal(page1.json.more, true);
      assert.equal(page1.json.bundles[199].seq, 200);
      const page2 = await r.call({ action: 'pull', since: 200 }, { token: dev });
      assert.deepEqual(page2.json.bundles.map((b) => b.seq), [201, 202, 203, 204, 205]);
      assert.equal(page2.json.more, false);

      // revocation
      assert.equal((await r.call({ action: 'revokeDevice', deviceId: 'zz' }, { token: admin })).status, 400);
      assert.equal((await r.call({ action: 'revokeDevice', deviceId: '0'.repeat(32) }, { token: admin })).status, 400);
      assert.equal((await r.call({ action: 'revokeDevice', deviceId }, { token: admin })).status, 200);
      assert.equal((await r.call({ action: 'pull', since: 0 }, { token: dev })).status, 401);
      assert.equal((await r.call({ action: 'push', bundle: 'x' }, { token: dev })).status, 401);
      assert.equal((await r.call({ action: 'listDevices' }, { token: admin })).json.devices.length, 0);
    } finally { await r.stop(); }
  });

  await t.test('size limits and path-like input', async () => {
    const r = await startRelay();
    try {
      const admin = await claimed(r);
      const max = 2 * 1024 * 1024;
      assert.equal((await r.call({ action: 'push', bundle: 'a'.repeat(max) }, { token: admin })).status, 200);
      assert.equal((await r.call({ action: 'push', bundle: 'a'.repeat(max + 1) }, { token: admin })).status, 413);
      // Snapshots have their own, larger limit; other actions keep the bundle cap even for huge bodies.
      assert.equal((await r.call({ action: 'putSnapshot', seq: 0, bundle: 'a'.repeat(max + 5000) }, { token: admin })).status, 200);
      assert.equal((await r.call({ action: 'putSnapshot', seq: 0, bundle: 'a'.repeat(21 * 1024 * 1024) }, { token: admin })).status, 413);
      assert.equal((await r.call({ action: 'push', bundle: 'a'.repeat(max + 5000) }, { token: admin })).status, 413);
      assert.equal((await r.call({ bundle: 'a'.repeat(max + 5000), action: 'putSnapshot', seq: 0 }, { token: admin })).status, 413, 'action not announced first is refused when over the bundle cap');
      assert.equal((await r.call({ action: 'push', bundle: '' }, { token: admin })).status, 400);
      assert.equal((await r.call({ action: 'push', bundle: 5 }, { token: admin })).status, 400);

      for (const since of ['../x', '..\\..\\x', '-1', 1.5, -1, '1e3', ' 1', '', null, [], {}, true]) {
        const res = await r.call({ action: 'pull', since }, { token: admin });
        assert.equal(res.status, 400, 'since=' + JSON.stringify(since));
      }
      assert.equal((await r.call({ action: 'putSnapshot', seq: '../x', bundle: 'x' }, { token: admin })).status, 400);

      // Nothing outside the data dir is reachable and the data dir is not served by index.php.
      for (const p of ['/data/state.json', '/data/b/1.json', '/../package.json', '/%2e%2e/package.json']) {
        const res = await fetch(r.base.replace('/index.php', p));
        assert.ok([403, 404, 405].includes(res.status) || !(await res.clone().text()).includes('"hash"'), p + ' -> ' + res.status);
      }
      const noIndex = fs.readFileSync(path.join(r.dataDir, '.htaccess'), 'utf8');
      assert.match(noIndex, /Require all denied/);
      assert.ok(fs.existsSync(path.join(r.dataDir, 'index.html')));
      // only integer-named bundle files
      const names = fs.readdirSync(path.join(r.dataDir, 'b')).filter((n) => !n.startsWith('.') && n !== 'index.html');
      assert.deepEqual(names, ['1.json']);
    } finally { await r.stop(); }
  });

  await t.test('snapshot and pruning', async () => {
    const r = await startRelay({ PRUNE_DAYS: 0, PRUNE_EVERY: 0 });
    try {
      const admin = await claimed(r);
      const dev = (await r.call({ action: 'addDevice', name: 'P' }, { token: admin })).json.token;
      const g0 = (await r.call({ action: 'getSnapshot' }, { token: dev })).json;
      assert.equal(g0.seq, null);
      assert.equal(g0.bundle, null);
      for (let i = 1; i <= 3; i++) await r.call({ action: 'push', bundle: 'b' + i }, { token: dev });
      assert.equal((await r.call({ action: 'putSnapshot', seq: 2, bundle: 'snap' }, { token: dev })).status, 403);
      assert.equal((await r.call({ action: 'putSnapshot', seq: 9, bundle: 'snap' }, { token: admin })).status, 400);
      assert.equal((await r.call({ action: 'putSnapshot', seq: 2, bundle: 'snap' }, { token: admin })).status, 200);
      const g = await r.call({ action: 'getSnapshot' }, { token: dev });
      assert.equal(g.json.seq, 2);
      assert.equal(g.json.bundle, 'snap');
      await new Promise((res) => setTimeout(res, 1200));
      await r.call({ action: 'push', bundle: 'b4' }, { token: dev }); // opportunistic prune
      const p = await r.call({ action: 'pull', since: 0 }, { token: dev });
      assert.deepEqual(p.json.bundles.map((b) => b.seq), [3, 4]); // 1,2 covered by snapshot and old enough
      assert.equal(p.json.oldest, 3);
      assert.deepEqual(p.json.snapshot, { seq: 2 });
    } finally { await r.stop(); }
  });

  await t.test('storage cap -> 507', async () => {
    const r = await startRelay({ MAX_TOTAL: 4000 });
    try {
      const admin = await claimed(r);
      assert.equal((await r.call({ action: 'push', bundle: 'a'.repeat(2000) }, { token: admin })).status, 200);
      assert.equal((await r.call({ action: 'push', bundle: 'a'.repeat(2000) }, { token: admin })).status, 507);
    } finally { await r.stop(); }
  });

  await t.test('rate limit per token -> 429', async () => {
    const r = await startRelay({ RATE_LIMIT: 5 });
    try {
      const admin = await claimed(r);
      const codes = [];
      for (let i = 0; i < 7; i++) codes.push((await r.call({ action: 'pull', since: 0 }, { token: admin })).status);
      assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
    } finally { await r.stop(); }
  });

  await t.test('repeated bad tokens / setup codes lock out the IP -> 429', async () => {
    const r = await startRelay({ FAIL_LIMIT: 3 });
    try {
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await r.call({ action: 'claim', setupCode: 'wrong' + i })).status);
      assert.deepEqual(codes, [403, 403, 403, 429, 429]);
      // even the right code is refused while locked out
      assert.equal((await r.call({ action: 'claim', setupCode: SETUP })).status, 429);
    } finally { await r.stop(); }
  });

  await t.test('epoch on claim and every authenticated response, `last` on pull', async () => {
    const r = await startRelay({ RATE_LIMIT: 100000 });
    try {
      const claim = await r.call({ action: 'claim', setupCode: SETUP });
      const epoch = claim.json.epoch;
      assert.match(epoch, /^[a-f0-9]{16}$/);
      const admin = claim.json.adminToken;
      const dev = (await r.call({ action: 'addDevice', name: 'P' }, { token: admin })).json;
      assert.equal(dev.epoch, epoch);
      assert.equal((await r.call({ action: 'push', bundle: 'a' }, { token: dev.token })).json.epoch, epoch);
      const p0 = await r.call({ action: 'pull', since: 0 }, { token: admin });
      assert.equal(p0.json.epoch, epoch);
      assert.equal(p0.json.last, 1);
      await r.call({ action: 'push', bundle: 'b' }, { token: admin });
      assert.equal((await r.call({ action: 'pull', since: 2 }, { token: dev.token })).json.last, 2);
      for (const body of [{ action: 'listDevices' }, { action: 'getSnapshot' }, { action: 'putSnapshot', seq: 1, bundle: 'x' }]) {
        assert.equal((await r.call(body, { token: admin })).json.epoch, epoch, body.action);
      }
      // hello is anonymous and says nothing about the epoch
      assert.equal((await r.call({ action: 'hello' })).json.epoch, undefined);
      assert.equal((await r.call({ action: 'whoami' }, { token: admin })).json.epoch, epoch);
    } finally { await r.stop(); }
  });

  await t.test('relay claimed before epochs existed gets a stable epoch lazily', async () => {
    const r = await startRelay({ RATE_LIMIT: 100000 });
    try {
      const admin = await claimed(r);
      const sf = path.join(r.dataDir, 'state.json');
      const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
      delete st.epoch;
      fs.writeFileSync(sf, JSON.stringify(st));
      const first = (await r.call({ action: 'pull', since: 0 }, { token: admin })).json.epoch;
      assert.match(first, /^[a-f0-9]{16}$/);
      assert.equal(JSON.parse(fs.readFileSync(sf, 'utf8')).epoch, first, 'persisted');
      assert.equal((await r.call({ action: 'whoami' }, { token: admin })).json.epoch, first);
      assert.equal((await r.call({ action: 'pull', since: 0 }, { token: admin })).json.epoch, first);
    } finally { await r.stop(); }
  });

  await t.test('X-CC-Token header is accepted; Authorization wins when both are sent', async () => {
    const r = await startRelay();
    try {
      const admin = await claimed(r);
      const viaX = await r.call({ action: 'whoami' }, { headers: { 'X-CC-Token': admin } });
      assert.equal(viaX.status, 200);
      assert.equal(viaX.json.admin, true);
      const both = await r.call({ action: 'whoami' }, { token: admin, headers: { 'X-CC-Token': 'A'.repeat(43) } });
      assert.equal(both.status, 200);
      const bothBad = await r.call({ action: 'whoami' }, { token: 'A'.repeat(43), headers: { 'X-CC-Token': admin } });
      assert.equal(bothBad.status, 401);
      assert.equal((await r.call({ action: 'whoami' }, { headers: { 'X-CC-Token': 'junk' } })).status, 401);
    } finally { await r.stop(); }
  });

  await t.test('auth before body: anonymous bodies capped at 8 KB (413, not parsed); big bodies only for the admin token', async () => {
    const r = await startRelay({ RATE_LIMIT: 100000 });
    try {
      const admin = await claimed(r);
      const dev = (await r.call({ action: 'addDevice', name: 'P' }, { token: admin })).json.token;
      // Oversized and not even JSON: 413 proves the body was refused before parsing (parsing would give 400).
      assert.equal((await r.call(null, { raw: '{' + 'x'.repeat(9000) })).status, 413);
      assert.equal((await r.call(null, { raw: '{"action":"hello","pad":"' + 'a'.repeat(9000) + '"}' })).status, 413);
      assert.equal((await r.call(null, { raw: '{"action":"claim","setupCode":"' + 'a'.repeat(9000) + '"}' })).status, 413);
      assert.equal((await r.call(null, { raw: '{"action":"putSnapshot","seq":0,"bundle":"' + 'a'.repeat(9000) + '"}' })).status, 413);
      assert.equal((await r.call({ action: 'hello', pad: 'a'.repeat(3000) })).status, 200); // small anonymous body is fine
      // A bad token is refused (401) before its big body is even considered.
      const huge = '{"action":"push","bundle":"' + 'a'.repeat(3 * 1024 * 1024) + '"}';
      assert.equal((await r.call(null, { raw: huge, token: 'A'.repeat(43) })).status, 401);
      assert.equal((await r.call(null, { raw: huge, token: dev })).status, 413);
      // putSnapshot above 2 MB: only with the admin header token.
      const snap = '{"action":"putSnapshot","seq":0,"bundle":"' + 'a'.repeat(2 * 1024 * 1024 + 5000) + '"}';
      assert.equal((await r.call(null, { raw: snap })).status, 413, 'anonymous');
      assert.equal((await r.call(null, { raw: snap, token: dev })).status, 413, 'device token');
      assert.equal((await r.call(null, { raw: snap, token: admin })).status, 200, 'admin token');
      assert.equal((await r.call(null, { raw: snap, headers: { 'X-CC-Token': admin } })).status, 200, 'admin via X-CC-Token');
      // Protected action without a token: 401.
      assert.equal((await r.call({ action: 'push', bundle: 'x' })).status, 401);
    } finally { await r.stop(); }
  });

  await t.test('compact: needs admin, refused when snapshot seq < upTo, deletes bundles <= upTo', async () => {
    const r = await startRelay({ RATE_LIMIT: 100000 });
    try {
      const admin = await claimed(r);
      const dev = (await r.call({ action: 'addDevice', name: 'P' }, { token: admin })).json.token;
      for (let i = 1; i <= 5; i++) await r.call({ action: 'push', bundle: 'b' + i }, { token: dev });
      assert.equal((await r.call({ action: 'compact', upTo: 2 }, { token: dev })).status, 403);
      assert.equal((await r.call({ action: 'compact', upTo: 2 }, { token: admin })).status, 409, 'no snapshot yet');
      assert.equal((await r.call({ action: 'putSnapshot', seq: 3, bundle: 'snap' }, { token: admin })).status, 200);
      assert.equal((await r.call({ action: 'compact', upTo: 4 }, { token: admin })).status, 409, 'snapshot seq 3 < 4');
      assert.equal((await r.call({ action: 'compact', upTo: -1 }, { token: admin })).status, 400);
      assert.equal((await r.call({ action: 'compact', upTo: 'x' }, { token: admin })).status, 400);
      assert.equal((await r.call({ action: 'pull', since: 0 }, { token: admin })).json.bundles.length, 5, 'refusals deleted nothing');
      const ok = await r.call({ action: 'compact', upTo: 3 }, { token: admin });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.ok, true);
      assert.equal(ok.json.oldest, 4);
      assert.match(ok.json.epoch, /^[a-f0-9]{16}$/);
      const p = await r.call({ action: 'pull', since: 0 }, { token: dev });
      assert.deepEqual(p.json.bundles.map((b) => b.seq), [4, 5]);
      assert.equal(p.json.oldest, 4);
      assert.equal(p.json.last, 5);
      // compacting everything leaves oldest = last + 1
      assert.equal((await r.call({ action: 'putSnapshot', seq: 5, bundle: 'snap2' }, { token: admin })).status, 200);
      assert.equal((await r.call({ action: 'compact', upTo: 5 }, { token: admin })).json.oldest, 6);
    } finally { await r.stop(); }
  });

  await t.test('rekey: bundles and snapshot gone, device tokens revoked, admin and epoch stay', async () => {
    const r = await startRelay({ RATE_LIMIT: 100000 });
    try {
      const claim = await r.call({ action: 'claim', setupCode: SETUP });
      const admin = claim.json.adminToken;
      const epoch = claim.json.epoch;
      const dev = (await r.call({ action: 'addDevice', name: 'P' }, { token: admin })).json.token;
      for (let i = 1; i <= 3; i++) await r.call({ action: 'push', bundle: 'b' + i }, { token: dev });
      await r.call({ action: 'putSnapshot', seq: 2, bundle: 'snap' }, { token: admin });
      assert.equal((await r.call({ action: 'rekey' }, { token: dev })).status, 403);
      assert.equal((await r.call({ action: 'pull', since: 0 }, { token: dev })).status, 200, 'refused rekey changed nothing');
      const rk = await r.call({ action: 'rekey' }, { token: admin });
      assert.equal(rk.status, 200);
      assert.equal(rk.json.ok, true);
      assert.equal((await r.call({ action: 'pull', since: 0 }, { token: dev })).status, 401);
      assert.equal((await r.call({ action: 'getSnapshot' }, { token: dev })).status, 401);
      const p = await r.call({ action: 'pull', since: 0 }, { token: admin });
      assert.equal(p.status, 200);
      assert.deepEqual(p.json.bundles, []);
      assert.equal(p.json.snapshot, null);
      assert.equal(p.json.epoch, epoch, 'epoch unchanged');
      assert.equal(p.json.last, 3, 'sequence counter is not reset');
      assert.equal(p.json.oldest, 4);
      assert.equal((await r.call({ action: 'getSnapshot' }, { token: admin })).json.bundle, null);
      assert.equal((await r.call({ action: 'listDevices' }, { token: admin })).json.devices.length, 0);
      // new phones and a new snapshot work afterwards
      const dev2 = (await r.call({ action: 'addDevice', name: 'P2' }, { token: admin })).json.token;
      assert.equal((await r.call({ action: 'push', bundle: 'n' }, { token: dev2 })).json.seq, 4);
      assert.equal((await r.call({ action: 'putSnapshot', seq: 4, bundle: 'new' }, { token: admin })).status, 200);
    } finally { await r.stop(); }
  });

  await t.test('per-device quota -> 507 for that device only', async () => {
    const r = await startRelay({ DEVICE_QUOTA: 3000, RATE_LIMIT: 100000 });
    try {
      const admin = await claimed(r);
      const a = (await r.call({ action: 'addDevice', name: 'A' }, { token: admin })).json.token;
      const b = (await r.call({ action: 'addDevice', name: 'B' }, { token: admin })).json.token;
      assert.equal((await r.call({ action: 'push', bundle: 'a'.repeat(2000) }, { token: a })).status, 200);
      const full = await r.call({ action: 'push', bundle: 'a'.repeat(2000) }, { token: a });
      assert.equal(full.status, 507);
      assert.equal(full.json.ok, false);
      assert.equal((await r.call({ action: 'push', bundle: 'small' }, { token: a })).status, 200, 'still room for a small one');
      assert.equal((await r.call({ action: 'push', bundle: 'a'.repeat(2000) }, { token: b })).status, 200, 'other device unaffected');
      assert.equal((await r.call({ action: 'push', bundle: 'a'.repeat(2000) }, { token: admin })).status, 200, 'admin has its own quota');
    } finally { await r.stop(); }
  });

  await t.test('a valid token is never blocked by the IP failure limiter', async () => {
    const r = await startRelay({ FAIL_LIMIT: 30, RATE_LIMIT: 100000 });
    try {
      const admin = await claimed(r);
      const dev = (await r.call({ action: 'addDevice', name: 'P' }, { token: admin })).json.token;
      const codes = [];
      for (let i = 0; i < 33; i++) codes.push((await r.call({ action: 'pull', since: 0 }, { token: 'B'.repeat(42) + String(i % 10) })).status);
      assert.deepEqual(codes.slice(0, 30), Array(30).fill(401));
      assert.deepEqual(codes.slice(30), [429, 429, 429], 'failures are blocked');
      assert.equal((await r.call({ action: 'pull', since: 0 }, { token: admin })).status, 200);
      assert.equal((await r.call({ action: 'pull', since: 0 }, { token: dev })).status, 200);
      assert.equal((await r.call({ action: 'push', bundle: 'x' }, { token: dev })).status, 200);
      assert.equal((await r.call({ action: 'whoami' }, { headers: { 'X-CC-Token': admin } })).status, 200);
      // ...while a further bad token from the same IP is still blocked
      assert.equal((await r.call({ action: 'pull', since: 0 })).status, 429);
    } finally { await r.stop(); }
  });

  await t.test('rate-limit files: check-only creates none; only counted hits do', async () => {
    const r = await startRelay({ RATE_LIMIT: 100000 });
    try {
      await r.call({ action: 'hello' });
      const rl = () => fs.readdirSync(path.join(r.dataDir, 'rl')).filter((n) => n.endsWith('.json'));
      const admin = await claimed(r);
      assert.equal(rl().length, 0);
      void 0; // claim only checks the IP counter: no file
      assert.equal(rl().length, 0);
      assert.equal((await r.call({ action: 'claim', setupCode: SETUP + 'x' })).status, 409);
      assert.equal(rl().length, 0);
      await r.call({ action: 'pull', since: 0 }, { token: admin }); // the per-token counter
      assert.equal(rl().length, 1);
      assert.equal((await r.call({ action: 'pull', since: 0 }, { token: 'A'.repeat(43) })).status, 401); // a failure: IP counter
      assert.equal(rl().length, 2);
    } finally { await r.stop(); }
  });

  await t.test('claim on a claimed relay -> 409 even with a wrong or missing code, and counts no failure', async () => {
    const r = await startRelay({ FAIL_LIMIT: 2 });
    try {
      await claimed(r);
      for (let i = 0; i < 4; i++) {
        assert.equal((await r.call({ action: 'claim', setupCode: 'wrong' + i })).status, 409);
      }
      assert.equal((await r.call({ action: 'claim' })).status, 409);
      assert.equal((await r.call({ action: 'claim', setupCode: SETUP })).status, 409);
    } finally { await r.stop(); }
  });

  await t.test('data folder name is derived from the setup code, not data/', async () => {
    const r = await startRelay({ DATA_DIR: null });
    const expected = path.join(SERVER_DIR, 'data-' + require('node:crypto').createHash('sha256').update(SETUP + 'cc-data').digest('hex').slice(0, 24));
    try {
      assert.ok(!fs.existsSync(path.join(SERVER_DIR, 'data')), 'no plain data/ folder in the relay directory');
      const admin = await claimed(r);
      await r.call({ action: 'push', bundle: 'x' }, { token: admin });
      assert.ok(fs.existsSync(path.join(expected, 'state.json')), 'state lives in data-<24 hex>');
      assert.match(path.basename(expected), /^data-[a-f0-9]{24}$/);
      assert.ok(!fs.existsSync(path.join(SERVER_DIR, 'data')), 'still no plain data/ folder');
      if (process.platform !== 'win32') assert.equal(fs.statSync(expected).mode & 0o077, 0, 'owner-only permissions');
      assert.ok(fs.existsSync(path.join(expected, '.htaccess')));
    } finally {
      await r.stop();
      fs.rmSync(expected, { recursive: true, force: true });
    }
  });
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const SyncCrypto = require('../src/shared/sync-crypto');

const obj = { a: 1, s: 'é✓', n: [1, 2] };

test('generateKey and randomToken are 32 bytes base64url', async () => {
  const k = await SyncCrypto.generateKey();
  assert.match(k, /^[A-Za-z0-9_-]{43}$/);
  assert.match(SyncCrypto.randomToken(), /^[A-Za-z0-9_-]{43}$/);
});

test('round trip', async () => {
  const k = await SyncCrypto.generateKey();
  const env = await SyncCrypto.encrypt(k, obj, 'dev1');
  assert.deepEqual(await SyncCrypto.decrypt(k, env, 'dev1'), obj);
});

test('wrong key rejects', async () => {
  const env = await SyncCrypto.encrypt(await SyncCrypto.generateKey(), obj, 'd');
  await assert.rejects(SyncCrypto.decrypt(await SyncCrypto.generateKey(), env, 'd'));
});

test('wrong AAD rejects', async () => {
  const k = await SyncCrypto.generateKey();
  const env = await SyncCrypto.encrypt(k, obj, 'd1');
  await assert.rejects(SyncCrypto.decrypt(k, env, 'd2'));
});

test('tampered ct rejects', async () => {
  const k = await SyncCrypto.generateKey();
  const env = await SyncCrypto.encrypt(k, obj, 'd');
  const c = env.ct;
  const ct = (c[0] === 'A' ? 'B' : 'A') + c.slice(1);
  await assert.rejects(SyncCrypto.decrypt(k, { iv: env.iv, ct }, 'd'));
});

test('IV differs between encryptions', async () => {
  const k = await SyncCrypto.generateKey();
  const a = await SyncCrypto.encrypt(k, obj, 'd');
  const b = await SyncCrypto.encrypt(k, obj, 'd');
  assert.notEqual(a.iv, b.iv);
});

test('pairing round trip', async () => {
  const p = { url: 'https://example.com/sync', token: SyncCrypto.randomToken(), key: await SyncCrypto.generateKey(), name: 'PC é' };
  const code = SyncCrypto.encodePairing(p);
  assert.ok(code.startsWith('CCSYNC1.'));
  assert.deepEqual(SyncCrypto.decodePairing(code), p);
});

test('pairing keeps the device ids', async () => {
  const p = { url: 'https://x.io/', token: 't', key: await SyncCrypto.generateKey(), name: 'n', deviceId: 'a'.repeat(32), pcDeviceId: 'b'.repeat(32) };
  assert.deepEqual(SyncCrypto.decodePairing(SyncCrypto.encodePairing(p)), p);
});

test('garbage code throws', () => {
  for (const g of ['', 'hello', 'CCSYNC1.', 'CCSYNC1.!!!', 'CCSYNC1.' + Buffer.from('{}').toString('base64url'), null, 5]) {
    assert.throws(() => SyncCrypto.decodePairing(g), { message: 'Not a Client Clusters pairing code' });
  }
});

test('pairing URL and key validation', async () => {
  const key = await SyncCrypto.generateKey();
  const mk = (o) => SyncCrypto.encodePairing({ url: 'https://x.io/', token: 't', key, name: 'n', ...o });
  for (const url of ['https://x.io/', 'http://127.0.0.1:8080/', 'http://localhost/s']) {
    assert.doesNotThrow(() => SyncCrypto.decodePairing(mk({ url })));
  }
  for (const url of ['http://example.com/', 'ftp://x', 'javascript:alert(1)', 'http://localhost.evil.com/', '']) {
    assert.throws(() => SyncCrypto.decodePairing(mk({ url })), /Not a Client Clusters pairing code/);
  }
  assert.throws(() => SyncCrypto.decodePairing(mk({ token: '' })));
  assert.throws(() => SyncCrypto.decodePairing(mk({ key: 'AAAA' })));
});

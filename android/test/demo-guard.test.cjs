// The demo mode must never activate in the real app. Loads android/www/dev/demo.js in a vm sandbox.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.resolve(__dirname, '../www/dev/demo.js'), 'utf8');

function run({ url, capacitor, androidBridge }) {
  const u = new URL(url);
  const written = [], appended = [];
  const Store = { read: 'orig-read', write: 'orig-write' };
  const Sync = { init: 'orig-init', run: 'orig-run' };
  const sandbox = {
    location: { protocol: u.protocol, hostname: u.hostname, search: u.search },
    document: { body: { appendChild: el => appended.push(el) }, write: s => written.push(s), createElement: () => ({ style: {}, setAttribute() {} }), addEventListener() {} },
    URLSearchParams, console, Store, Sync,
  };
  if (capacitor) sandbox.Capacitor = capacitor;
  if (androidBridge) sandbox.androidBridge = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const untouched = Store.read === 'orig-read' && Store.write === 'orig-write' && Sync.init === 'orig-init' && Sync.run === 'orig-run' && !('active' in Sync);
  return { untouched, badge: appended.length > 0, written, sandbox, Store, Sync };
}

const DEMO = 'http://127.0.0.1:5178/index.html?demo=1';
const inactive = (name, opts) => test(name, () => {
  const r = run(opts);
  assert.ok(r.untouched, 'Store/Sync were modified');
  assert.equal(r.badge, false);
  assert.equal(r.written.length, 0);
  assert.equal(r.sandbox.__DEMO__, undefined);
});

inactive('inactive in a native Capacitor app', { url: DEMO, capacitor: { isNativePlatform: () => true } });
inactive('inactive on https://localhost (Capacitor Android)', { url: 'https://localhost/index.html?demo=1' });
inactive('inactive without the demo parameter', { url: 'http://127.0.0.1:5178/index.html' });
inactive('inactive with demo=0', { url: 'http://127.0.0.1:5178/index.html?demo=0' });
inactive('inactive when androidBridge exists', { url: DEMO, androidBridge: true });

test('active in a plain desktop browser on http://127.0.0.1:5178/?demo=1', async () => {
  const r = run({ url: DEMO });
  assert.equal(r.untouched, false);
  assert.equal(r.badge, true);
  assert.equal(r.written.length, 1);
  assert.match(r.written[0], /fixtures\.js/);
  assert.equal(typeof r.Sync.init, 'function');
  assert.equal(r.Sync.active, false); // becomes true once the app calls Sync.init(pairing)
  assert.deepEqual(await r.Store.read('pairing.json').then(p => Object.keys(p).includes('deviceId')), true);
});

test('active with Capacitor present but not native (web platform)', () => {
  const r = run({ url: DEMO, capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' } });
  assert.equal(r.badge, true);
});

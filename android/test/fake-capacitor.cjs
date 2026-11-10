// Electron preload (no context isolation): puts a fake window.Capacitor in the page before its scripts run.
// In-memory Filesystem, in-memory relay behind CapacitorHttp, fake App and BarcodeScanner plugins.
// Also exposes window.__test with the relay, a PC-side engine and helpers for the test runner. Made-up data only.
const path = require('node:path');
const shared = p => require(path.resolve(__dirname, '../../src/shared', p));
const SyncEngine = shared('sync-engine.js');
const SyncModel = shared('sync-model.js');
const SyncCrypto = shared('sync-crypto.js');

const files = new Map();
const appListeners = {};
const TOKENS = { 'phone-token': 'phone-dev', 'phone2-token': 'phone-dev2', 'pc-token': 'pc-dev' };
const relay = { bundles: [], seq: 0, snapshot: null, revoked: new Set(), offline: false, requests: [], epoch: '0123456789abcdef', htmlFor: null, gate: null, gateHit: false, badHeaders: 0 };

function handle(action, body, token) {
  relay.requests.push(action);
  if (relay.offline) { const e = new Error('offline'); e.network = true; throw e; }
  const device = TOKENS[token];
  if (!device || relay.revoked.has(token)) return { status: 401, data: { ok: false, error: 'Unauthorized' } };
  const ok = o => ({ status: 200, data: Object.assign({ ok: true, epoch: relay.epoch }, o) });
  switch (action) {
    case 'push': relay.bundles.push({ seq: ++relay.seq, device, bundle: body.bundle }); return ok({ seq: relay.seq });
    case 'pull': {
      const list = relay.bundles.filter(b => b.seq > (body.since || 0));
      return ok({ bundles: list.slice(0, 200), more: list.length > 200, last: relay.seq, snapshot: relay.snapshot ? { seq: relay.snapshot.seq } : null, oldest: relay.bundles.length ? relay.bundles[0].seq : relay.seq + 1 });
    }
    case 'putSnapshot': relay.snapshot = { seq: body.seq, bundle: body.bundle }; return ok();
    case 'getSnapshot': return ok(relay.snapshot || { seq: null, bundle: null });
    case 'compact': {
      if (device !== 'pc-dev') return { status: 403, data: { ok: false, error: 'Forbidden' } };
      if (!relay.snapshot || relay.snapshot.seq < body.upTo) return { status: 409, data: { ok: false, error: 'snapshot too old' } };
      relay.bundles = relay.bundles.filter(b => b.seq > body.upTo);
      return ok({ oldest: relay.bundles.length ? relay.bundles[0].seq : relay.seq + 1 });
    }
    case 'rekey': if (device !== 'pc-dev') return { status: 403, data: { ok: false, error: 'Forbidden' } }; relay.bundles = []; relay.snapshot = null; return ok();
    default: return { status: 400, data: { ok: false, error: 'bad action' } };
  }
}

const b64url = text => Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function sampleData() {
  const now = new Date(), past = new Date(now.getTime() - 3 * 86400000);
  const today = ymd(now);
  return {
    clients: [
      { id: 'c1', name: 'Boulangerie Exemple', address: '1 rue Fictive', postcode: '69001', city: 'Lyon', country: 'FR', lat: 45.767, lng: 4.835, groupId: 'g1', tier: 'A', notes: 'Likes baguettes', extra: { 'Téléphone': '04 78 00 00 01', Contact: 'Alex Test' },
        gbp: { hours: { periods: [{ open: { day: 0, hour: 0, minute: 0 } }] }, phone: null, website: null, url: null },
        visits: [{ id: 'v1', date: today, status: 'planned', type: 'visit', outcome: '', note: '', order: 1 }, { id: 'v0', date: ymd(past), status: 'planned', type: 'visit', outcome: '', note: 'Old plan' }] },
      { id: 'c2', name: 'Garage Fictif', address: '2 avenue Imaginaire', postcode: '69003', city: 'Lyon', country: 'FR', lat: 45.76, lng: 4.86, groupId: 'g1', notes: '', extra: {}, gbp: null,
        visits: [{ id: 'v2', date: today, status: 'planned', type: 'visit', outcome: '', note: '', order: 2 }] },
    ],
    groups: [{ id: 'g1', number: 1, name: 'Lyon centre', color: '#d9480f' }],
    prospecting: { prospects: [{ id: 'p1', name: 'Cafe Prospect', address: '3 place Test', postcode: '69002', city: 'Lyon', country: 'FR', lat: 45.75, lng: 4.83, status: 'todo', notes: '', group: null, extra: {} }] },
    settings: { home: { lat: 45.77, lng: 4.84, label: 'Home' }, dueDays: 30, overdueDays: 60 },
  };
}

window.__opened = [];

window.Capacitor = {
  isNativePlatform: () => true,
  Plugins: {
    Filesystem: {
      async readFile({ path: p }) { if (!files.has(p)) throw new Error('File does not exist.'); return { data: files.get(p) }; },
      async writeFile({ path: p, data }) { files.set(p, String(data)); return { uri: p }; },
      async rename({ from, to }) { if (!files.has(from)) throw new Error('File does not exist.'); files.set(to, files.get(from)); files.delete(from); },
      async deleteFile({ path: p }) { if (!files.has(p)) throw new Error('File does not exist.'); files.delete(p); },
    },
    CapacitorHttp: {
      async request({ headers, data }) {
        const token = String((headers && headers.Authorization) || '').replace(/^Bearer /, '');
        if (!token || (headers && headers['X-CC-Token']) !== token) relay.badHeaders++; // the phone must send both headers
        const { action, ...body } = data;
        if (relay.gate && action === 'pull') { relay.gateHit = true; await relay.gate; }
        if (relay.htmlFor === action) return { status: 200, headers: {}, url: '', data: '<html><body>Captive portal</body></html>' };
        return Object.assign({ headers: {}, url: '' }, handle(action, body, token));
      },
    },
    AppLauncher: { async openUrl({ url }) { window.__opened.push(url); return { completed: true }; } },
    App: {
      async addListener(name, fn) { (appListeners[name] = appListeners[name] || []).push(fn); return { remove: async () => {} }; },
      async exitApp() {},
    },
    CapacitorBarcodeScanner: { async scanBarcode() { return { ScanResult: window.__test.scanText }; } },
  },
};

window.__test = {
  files, relay, scanText: '', appListeners,
  pairingCode(extra) {
    return 'CCSYNC1.' + b64url(JSON.stringify(Object.assign({ url: 'https://relay.example.test/index.php', token: 'phone-token', key: this.key, name: 'Test PC', deviceId: 'phone-dev', pcDeviceId: 'pc-dev' }, extra)));
  },
  // Plays the Windows app: creates the key, pushes a snapshot of the sample data to the relay.
  async seedPc() {
    this.key = await SyncCrypto.generateKey();
    this.pcData = sampleData();
    const store = { s: null, async load() { return this.s; }, async save(s) { this.s = JSON.parse(JSON.stringify(s)); } };
    this.pc = SyncEngine.create({
      role: 'pc', config: { key: this.key, deviceId: 'pc-dev' }, store,
      transport: async (action, body) => { const r = handle(action, body, 'pc-token'); if (r.status >= 400) { const e = new Error(r.data.error); e.status = r.status; throw e; } return r.data; },
    });
    await this.pc.initPc(SyncModel.project(this.pcData));
    return this.key;
  },
  // PC side: pull what the phone sent and return the projection the PC would now hold.
  async pcSync() {
    const applied = [];
    const res = await this.pc.sync({ getProj: () => SyncModel.project(this.pcData), applyWin: async ops => { applied.push(...ops); } });
    return { res, applied };
  },
};

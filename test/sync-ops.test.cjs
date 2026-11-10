const assert = require('node:assert/strict');
const { test } = require('node:test');
const SyncModel = require('../src/shared/sync-model');
const SyncOps = require('../src/shared/sync-ops');

const clone = x => JSON.parse(JSON.stringify(x));
const clockAt = (d, t = 0, now = 0) => SyncOps.createClock(d, t, () => now);

function sampleData() {
  return {
    version: 3,
    settings: { home: { lat: 1, lng: 2 }, dueDays: 30, overdueDays: 60, visitMin: 30, dayStart: '08:30', dayEnd: '18:00', googleKey: 'SECRET', maxSize: 6 },
    groups: [{ id: 'g1', number: 1, name: 'North', color: '#f00', internal: 'x' }],
    clients: [{
      id: 'c1', name: 'Acme', address: '1 rue A', postcode: '75001', city: 'Paris', country: 'FR', lat: 48.8, lng: 2.3,
      groupId: 'g1', tier: 'A', notes: 'hello', extra: { Tel: '0102' }, geo: { q: 1 },
      gbp: { hours: ['9-17'], phone: '0102', website: 'http://a', url: 'http://g', placeId: 'P1', checkedAt: '2026-01-01' },
      visits: [{ id: 'v1', date: '2026-10-01', note: 'n', status: 'done', type: 'visit', outcome: 'ok' }],
    }, {
      id: 'c2', name: 'Beta', address: '', postcode: '', city: '', country: '', lat: null, lng: null, groupId: null, extra: {}, visits: [],
    }],
    prospecting: { fileName: 'p.xlsx', importedAt: 'x', areas: [{ id: 'a' }], prospects: [{ id: 'p1', name: 'Pro', status: 'todo', notes: '', extra: {}, group: null, createdAt: '2026-01-01' }] },
  };
}

test('project keeps only the projected fields', () => {
  const p = SyncModel.project(sampleData());
  assert.deepEqual(Object.keys(p.clients.c1).sort(), ['address', 'city', 'country', 'extra', 'gbp', 'groupId', 'id', 'lat', 'lng', 'name', 'notes', 'postcode', 'tier', 'visits']);
  assert.deepEqual(p.clients.c1.gbp, { hours: ['9-17'], phone: '0102', website: 'http://a', url: 'http://g' });
  assert.equal(p.clients.c1.visits.v1.outcome, 'ok');
  assert.deepEqual(p.groups.g1, { id: 'g1', number: 1, name: 'North', color: '#f00' });
  assert.equal(p.prospects.p1.createdAt, undefined);
  assert.equal(p.settings.googleKey, undefined);
  assert.equal(p.settings.maxSize, undefined);
  assert.equal(p.settings.dueDays, 30);
});

test('diff of identical projections is empty', () => {
  const p = SyncModel.project(sampleData());
  assert.deepEqual(SyncOps.diff(p, clone(p), clockAt('A')), []);
});

test('note edit gives one set; new visit one visit; removed visit a del', () => {
  const prev = SyncModel.project(sampleData());
  const next = clone(prev);
  next.clients.c1.notes = 'changed';
  let ops = SyncOps.diff(prev, next, clockAt('A', 0, 100));
  assert.equal(ops.length, 1);
  assert.deepEqual({ k: ops[0].k, e: ops[0].e, id: ops[0].id, f: ops[0].f, v: ops[0].v, d: ops[0].d }, { k: 'set', e: 'client', id: 'c1', f: 'notes', v: 'changed', d: 'A' });

  const n2 = clone(prev);
  n2.clients.c1.visits.v2 = { id: 'v2', date: '2026-11-01', status: 'done' };
  ops = SyncOps.diff(prev, n2, clockAt('A'));
  assert.equal(ops.length, 1);
  assert.equal(ops[0].k, 'visit'); assert.equal(ops[0].id, 'v2'); assert.equal(ops[0].c, 'c1'); assert.equal(ops[0].cl.name, 'Acme');

  const n3 = clone(prev); delete n3.clients.c1.visits.v1;
  ops = SyncOps.diff(prev, n3, clockAt('A'));
  assert.deepEqual(ops.map(o => [o.k, o.e, o.id, o.c]), [['del', 'visit', 'v1', 'c1']]);
});

test('phoneMayWrite rejects set client.name and accepts the allowed writes', () => {
  const ok = op => SyncModel.phoneMayWrite(op);
  assert.equal(ok({ k: 'set', e: 'client', id: 'c1', f: 'name' }), false);
  assert.equal(ok({ k: 'set', e: 'client', id: 'c1', f: 'notes' }), true);
  assert.equal(ok({ k: 'set', e: 'prospect', id: 'p1', f: 'status' }), true);
  assert.equal(ok({ k: 'set', e: 'prospect', id: 'p1', f: 'name' }), false);
  assert.equal(ok({ k: 'visit', e: 'visit', id: 'v', c: 'c1' }), true);
  assert.equal(ok({ k: 'del', e: 'visit', id: 'v' }), true);
  assert.equal(ok({ k: 'del', e: 'client', id: 'c1' }), false);
  assert.equal(ok({ k: 'add', e: 'client', id: 'c1' }), false);
});

test('resolve ignores disallowed phone ops and counts them', () => {
  const stamps = {};
  const r = SyncOps.resolve([{ k: 'set', e: 'client', id: 'c1', f: 'name', v: 'X', t: 1, d: 'P' }, { k: 'set', e: 'client', id: 'c1', f: 'notes', v: 'Y', t: 2, d: 'P' }], stamps, { fromPhone: true });
  assert.equal(r.ignored, 1);
  assert.equal(r.win.length, 1);
});

test('clock: hybrid logical, slow clock still orders after what it has seen', () => {
  let now = 1000;
  const c = SyncOps.createClock('A', 0, () => now);
  assert.equal(c.now(), 1000);
  assert.equal(c.now(), 1001);
  c.observe(5000);
  now = 1002;
  assert.equal(c.now(), 5001);
  assert.equal(c.last, 5001);
});

test('concurrent note edits: both devices end with the later value, in any order', () => {
  const base = SyncModel.project(sampleData());
  const mkOp = (v, t, d) => ({ k: 'set', e: 'client', id: 'c1', f: 'notes', v, t, d });
  const a = mkOp('from A', 10, 'A'), b = mkOp('from B', 12, 'B');
  for (const order of [[a, b], [b, a]]) {
    const proj = clone(base), stamps = {};
    for (const op of order) SyncOps.applyToProj(proj, SyncOps.resolve([op], stamps, { fromPhone: false }).win);
    assert.equal(proj.clients.c1.notes, 'from B');
  }
  // tie on t: higher device id wins
  const proj = clone(base), stamps = {};
  for (const op of [mkOp('x', 5, 'A'), mkOp('y', 5, 'B')]) SyncOps.applyToProj(proj, SyncOps.resolve([op], stamps, {}).win);
  assert.equal(proj.clients.c1.notes, 'y');
});

test('visit for deleted client restores it', () => {
  const data = sampleData();
  data.clients = data.clients.filter(c => c.id !== 'c1'); // PC deleted Acme
  const stamps = { 'client:c1': { t: 10, d: 'P', del: true } }; // ... and remembers it
  const ops = [{ k: 'visit', e: 'visit', id: 'v9', c: 'c1', v: { id: 'v9', date: '2026-11-05', status: 'done', type: 'visit' }, cl: { name: 'Acme', address: '1 rue A', postcode: '75001', city: 'Paris', country: 'FR', lat: 48.8, lng: 2.3 }, t: 50, d: 'P' }];
  const { win } = SyncOps.resolve(ops, stamps, { fromPhone: true });
  const res = SyncOps.applyToData(data, win);
  assert.deepEqual(res.restored, ['Acme']);
  assert.equal(res.counts.visits, 1);
  const c = data.clients.find(x => x.id === 'c1');
  assert.equal(c.name, 'Acme'); assert.equal(c.visits.length, 1); assert.equal(c.visits[0].id, 'v9');
  assert.equal(c.lat, 48.8);
});

test('a client deleted on the PC with a pending phone visit keeps the client; later older set does not resurrect', () => {
  const data = sampleData();
  const stamps = {};
  const del = [
    { k: 'del', e: 'visit', id: 'v1', c: 'c1', t: 20, d: 'PC' },
    { k: 'del', e: 'client', id: 'c2', t: 21, d: 'PC' },
    { k: 'set', e: 'client', id: 'c2', f: 'notes', v: 'late', t: 5, d: 'PH' },
  ];
  const win = SyncOps.resolve(del, stamps, {}).win;
  SyncOps.applyToData(data, win);
  assert.equal(data.clients.find(c => c.id === 'c2'), undefined);
  assert.equal(data.clients.find(c => c.id === 'c1').visits.length, 0);
});

test('applyToData leaves non-projected fields alone and creates entities with defaults', () => {
  const data = sampleData();
  const before = clone(data);
  const win = SyncOps.resolve([
    { k: 'set', e: 'client', id: 'c1', f: 'notes', v: 'new', t: 1, d: 'A' },
    { k: 'set', e: 'client', id: 'c1', f: 'gbp', v: { hours: ['10-11'], phone: '9', website: 'w', url: 'u' }, t: 2, d: 'A' },
    { k: 'add', e: 'prospect', id: 'p9', v: { name: 'New', status: 'todo' }, t: 3, d: 'A' },
    { k: 'add', e: 'group', id: 'g9', v: { number: 2, name: 'South', color: '#0f0' }, t: 4, d: 'A' },
    { k: 'set', e: 'settings', id: 'settings', f: 'dueDays', v: 45, t: 5, d: 'A' },
  ], {}, {}).win;
  const res = SyncOps.applyToData(data, win);
  const c = data.clients[0], b = before.clients[0];
  assert.equal(c.notes, 'new');
  assert.equal(c.geo.q, 1);
  assert.equal(c.gbp.placeId, 'P1'); assert.equal(c.gbp.checkedAt, '2026-01-01'); assert.equal(c.gbp.phone, '9');
  assert.deepEqual(c.visits, b.visits);
  assert.equal(data.settings.googleKey, 'SECRET'); assert.equal(data.settings.dueDays, 45);
  assert.deepEqual(data.prospecting.areas, [{ id: 'a' }]);
  assert.equal(data.prospecting.prospects.find(p => p.id === 'p9').notes, '');
  assert.deepEqual(data.groups.find(g => g.id === 'g9'), { id: 'g9', number: 2, name: 'South', color: '#0f0' });
  assert.equal(data.groups[0].internal, 'x');
  assert.equal(res.counts.notes, 1); assert.equal(res.counts.prospects, 1);
  assert.equal(res.counts.other, 3);
});

test('diff then applyToData round trip reproduces the projection', () => {
  const a = sampleData();
  const b = clone(a);
  b.clients.push({ id: 'c3', name: 'Gamma', address: 'z', postcode: '1', city: 'Y', country: 'FR', lat: 1, lng: 2, groupId: 'g1', tier: null, notes: '', extra: { a: 1 }, visits: [{ id: 'v7', date: '2026-11-02', status: 'planned' }] });
  b.clients[0].notes = 'edited';
  b.prospecting.prospects[0].status = 'visited';
  b.clients = b.clients.filter(c => c.id !== 'c2');
  const ops = SyncOps.diff(SyncModel.project(a), SyncModel.project(b), clockAt('PC', 0, 1000));
  const target = clone(a);
  SyncOps.applyToData(target, SyncOps.resolve(ops, {}, {}).win);
  assert.deepEqual(SyncModel.project(target), SyncModel.project(b));
});

test('pruneStamps drops only old tombstones', () => {
  const now = 200 * 24 * 3600 * 1000;
  const stamps = { 'client:a': { t: 1, d: 'A', del: true }, 'client:b': { t: now - 1000, d: 'A', del: true }, 'client:c': { t: 1, d: 'A', del: false } };
  assert.equal(SyncOps.pruneStamps(stamps, now), 1);
  assert.deepEqual(Object.keys(stamps).sort(), ['client:b', 'client:c']);
});

// ---- Property test: two devices, random edits, random delivery order -> converge.
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function makeDevice(id, base, rnd) {
  let skew = Math.floor(rnd() * 500);
  return { id, proj: clone(base), shadow: clone(base), stamps: {}, clock: SyncOps.createClock(id, 0, () => (skew += Math.floor(rnd() * 3))), inbox: [], seq: 0 };
}

test('200 random interleavings converge', () => {
  const base = SyncModel.project(sampleData());
  base.clients.c2.visits.v2 = { id: 'v2', date: '2026-09-01', status: 'done' };
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = mulberry32(seed);
    const pick = arr => arr[Math.floor(rnd() * arr.length)];
    const pc = makeDevice('PC', base, rnd), ph = makeDevice('PH', base, rnd);
    pc.peer = ph; ph.peer = pc;
    let n = 0;
    const capture = dev => {
      const ops = SyncOps.diff(dev.shadow, dev.proj, dev.clock);
      dev.shadow = clone(dev.proj);
      SyncOps.resolve(ops, dev.stamps, {}); // own ops stamp our own keys
      dev.peer.inbox.push(...ops);
    };
    const deliver = dev => {
      if (!dev.inbox.length) return;
      const op = dev.inbox.shift(); // the relay keeps each sender's order; only the interleaving with local edits is random
      dev.clock.observe(op.t);
      const { win } = SyncOps.resolve([op], dev.stamps, { fromPhone: dev.id === 'PC' });
      SyncOps.applyToProj(dev.proj, win);
      SyncOps.applyToProj(dev.shadow, win);
    };
    const edit = dev => {
      const clients = Object.values(dev.proj.clients), prospects = Object.values(dev.proj.prospects);
      const r = rnd();
      n++;
      if (r < 0.2 && clients.length) pick(clients).notes = 'note-' + dev.id + n;
      else if (r < 0.4 && clients.length) { const c = pick(clients); const id = `v-${dev.id}-${n}`; c.visits[id] = { id, date: '2026-11-0' + (1 + n % 9), status: pick(['done', 'planned']), note: dev.id + n }; }
      else if (r < 0.55 && clients.length) { const c = pick(clients); const ids = Object.keys(c.visits); if (ids.length) { if (rnd() < 0.5) delete c.visits[pick(ids)]; else c.visits[pick(ids)].status = 'done'; } }
      else if (r < 0.7 && prospects.length) pick(prospects).status = pick(['todo', 'visited', 'converted']);
      else if (r < 0.8 && prospects.length) pick(prospects).notes = 'pn-' + dev.id + n;
      else if (dev.id === 'PC') {
        if (r < 0.86 && clients.length) pick(clients).name = 'name-' + n;
        else if (r < 0.9 && clients.length) pick(clients).tier = pick(['A', 'B', null]);
        else if (r < 0.93) { const id = 'p-new-' + n; dev.proj.prospects[id] = { id, name: 'P' + n, address: '', postcode: '', city: '', country: '', lat: null, lng: null, status: 'todo', notes: '', group: null, extra: {} }; }
        else if (r < 0.96 && prospects.length) delete dev.proj.prospects[pick(prospects).id];
        else if (r < 0.98) { const id = 'c-new-' + n; dev.proj.clients[id] = { id, name: 'C' + n, address: 'a', postcode: '', city: 'X', country: 'FR', lat: 1, lng: 2, groupId: 'g1', tier: null, notes: '', extra: {}, gbp: null, visits: { ['vn' + n]: { id: 'vn' + n, date: '2026-11-03', status: 'planned' } } }; }
        else dev.proj.settings.dueDays = 20 + (n % 30);
      }
    };
    for (let step = 0; step < 40; step++) {
      const dev = rnd() < 0.5 ? pc : ph;
      if (rnd() < 0.6) { edit(dev); capture(dev); } else deliver(dev);
    }
    while (pc.inbox.length || ph.inbox.length) { deliver(pc); deliver(ph); }
    assert.deepEqual(pc.proj, ph.proj, `seed ${seed} diverged`);
  }
});


// ---- validation of ops from the relay (security review H3a-d)
const NOW = 1_800_000_000_000;
const goodSet = { k: 'set', e: 'client', id: 'c1', f: 'notes', v: 'x', t: NOW, d: 'whatever' };
const goodVisit = { k: 'visit', e: 'visit', id: 'v1', c: 'c1', v: { id: 'v1', date: '2026-11-09' }, t: NOW, d: 'x' };

test('validateOp accepts good ops and stamps the sender id', () => {
  assert.equal(SyncOps.validateOp(goodSet, 'sender', NOW).d, 'sender');
  assert.equal(SyncOps.validateOp(goodVisit, 'sender', NOW).v.id, 'v1');
  assert.equal(SyncOps.validateOp({ k: 'add', e: 'client', id: 'c9', v: { name: 'N', evil: 1, __proto__x: 2 }, t: NOW }, 's', NOW).v.evil, undefined);
});

test('validateOp rejects malformed ops', () => {
  const bad = [
    null, 5, 'x', [], {},
    { ...goodSet, id: '__proto__' }, { ...goodSet, id: 'a/b' }, { ...goodSet, id: 'x'.repeat(65) }, { ...goodSet, id: 7 },
    { ...goodSet, e: 'nope' }, { ...goodSet, k: 'nope' }, { ...goodSet, f: 'googleKey' }, { ...goodSet, e: 'settings', id: 'client' },
    { ...goodSet, t: 1e308 }, { ...goodSet, t: -1 }, { ...goodSet, t: 1.5 }, { ...goodSet, t: '5' },
    { ...goodVisit, v: null }, { ...goodVisit, v: { id: 'other' } }, { ...goodVisit, c: '../x' }, { ...goodVisit, v: { id: 'v1', note: 'x'.repeat(10001) } },
    { k: 'del', e: 'visit', id: 'v1', t: NOW }, { k: 'add', e: 'visit', id: 'v1', v: {}, t: NOW }, { k: 'add', e: 'client', id: 'c1', v: 'str', t: NOW },
  ];
  for (const op of bad) assert.equal(SyncOps.validateOp(op, 'd', NOW), null, JSON.stringify(op));
  assert.equal(SyncOps.validateOp(goodSet, '', NOW), null);
});

test('ids like __proto__ cannot pollute or be created', () => {
  const proj = SyncModel.project(sampleData());
  const win = SyncOps.resolve([{ k: 'add', e: 'client', id: '__proto__', v: { name: 'x' }, t: 1, d: 'A' }, { k: 'set', e: 'client', id: '__proto__', f: 'notes', v: 'p', t: 2, d: 'A' }], {}, {}).win;
  SyncOps.applyToProj(proj, win); // even if validation were skipped
  assert.equal({}.notes, undefined);
  assert.equal({}.name, undefined);
  assert.equal(Object.getPrototypeOf(proj.clients), Object.prototype);
});

test('restore from cl needs a delete tombstone; fields are fixed and id is never taken from cl', () => {
  const data = sampleData(); data.clients = data.clients.filter(c => c.id !== 'c1');
  const op = { k: 'visit', e: 'visit', id: 'v9', c: 'c1', v: { id: 'v9', date: '2026-11-05' }, cl: { name: 'Acme', id: 'EVIL', admin: true, lat: 1, lng: 2 }, t: 50, d: 'P' };
  // no tombstone: a made-up client is not created
  let d1 = clone(data);
  const r1 = SyncOps.applyToData(d1, SyncOps.resolve([op], {}, { fromPhone: true }).win);
  assert.equal(d1.clients.some(c => c.id === 'c1'), false); assert.equal(r1.restored.length, 0);
  // a forged flag on the wire does not count either (validateOp drops it)
  assert.equal(SyncOps.validateOp({ ...op, restore: true }, 'P', 60).restore, undefined);
  // tombstone: restored with the fixed field list
  const d2 = clone(data);
  const win = SyncOps.resolve([op], { 'client:c1': { t: 10, d: 'P', del: true } }, { fromPhone: true }).win;
  SyncOps.applyToData(d2, win);
  const c = d2.clients.find(x => x.id === 'c1');
  assert.ok(c); assert.equal(c.name, 'Acme'); assert.equal(c.admin, undefined); assert.equal(c.visits.length, 1);
  // bad cl values
  const d3 = clone(data);
  SyncOps.applyToData(d3, SyncOps.resolve([{ ...op, cl: { name: 5 } }], { 'client:c1': { t: 10, d: 'P', del: true } }, {}).win);
  assert.equal(d3.clients.some(x => x.id === 'c1'), false);
});

test('the clock ignores timestamps from the far future', () => {
  const clock = SyncOps.createClock('A', 0, () => NOW);
  clock.observe(1e308); clock.observe(NOW + 5 * 24 * 3600 * 1000); clock.observe(NaN);
  assert.equal(clock.last, 0);
  clock.observe(NOW + 1000);
  assert.equal(clock.last, NOW + 1000);
});


// ---- typed values (N2) and tolerances (N8)
const Visits = require('../src/shared/visits');
test('value lists match the app', () => {
  assert.deepEqual(SyncModel.VISIT_OUTCOMES, Object.keys(Visits.OUTCOMES));
  assert.deepEqual(SyncModel.VISIT_TYPES, Object.keys(Visits.VISIT_TYPES));
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'renderer', 'prospecting.js'), 'utf8');
  const block = src.slice(src.indexOf('const PROSPECT_STATUS = {'), src.indexOf('};', src.indexOf('const PROSPECT_STATUS = {')));
  assert.deepEqual([...block.matchAll(/^\s+(\w+): \{ label/gm)].map(m => m[1]), SyncModel.PROSPECT_STATUS);
});

test('validateOp type-checks visits and drops unknown keys', () => {
  const v = (o, id = 'v1') => ({ k: 'visit', e: 'visit', id, c: 'c1', v: { id, date: '2026-11-09', ...o }, t: NOW, d: 'x' });
  const good = SyncOps.validateOp(v({ note: 'n', status: 'planned', type: 'call', outcome: 'followup', order: 2.5, confirmedFrom: 'planned', evil: 'x', __proto__x: 1 }), 's', NOW);
  assert.deepEqual(good.v, { id: 'v1', date: '2026-11-09', note: 'n', status: 'planned', type: 'call', outcome: 'followup', order: 2.5, confirmedFrom: 'planned' });
  for (const bad of [{ date: '2026-13-40' }, { date: '2026-2-3' }, { date: 5 }, { date: undefined }, { status: 'maybe' }, { type: 'visit2' }, { outcome: 'done' },
    { note: 5 }, { order: NaN }, { order: '1' }, { order: Infinity }, { confirmedFrom: 'done' }]) {
    assert.equal(SyncOps.validateOp(v(bad), 's', NOW), null, JSON.stringify(bad));
  }
});

test('validateOp type-checks set/add values by field', () => {
  const set = (e, id, f, val) => SyncOps.validateOp({ k: 'set', e, id, f, v: val, t: NOW }, 's', NOW);
  const ok = [['client', 'c1', 'notes', 'x'], ['client', 'c1', 'lat', 45.5], ['client', 'c1', 'lat', null], ['client', 'c1', 'groupId', null], ['client', 'c1', 'groupId', 'g1'],
    ['client', 'c1', 'tier', 'A'], ['client', 'c1', 'tier', null], ['client', 'c1', 'extra', { a: 'b', n: 1, z: null }], ['client', 'c1', 'gbp', null],
    ['client', 'c1', 'gbp', { hours: { mon: ['9-12'] }, phone: '01', website: 'https://a.fr', url: '' }],
    ['prospect', 'p1', 'status', 'converted'], ['prospect', 'p1', 'group', null], ['group', 'g1', 'number', 3], ['group', 'g1', 'color', '#fff'],
    ['settings', 'settings', 'dueDays', 30], ['settings', 'settings', 'home', { lat: 1, lng: 2, label: 'Home' }], ['settings', 'settings', 'dayStart', '08:30'],
    ['settings', 'settings', 'tiers', { A: { due: 21, over: 35 } }]];
  for (const a of ok) assert.ok(set(...a), JSON.stringify(a));
  const bad = [['client', 'c1', 'notes', 5], ['client', 'c1', 'notes', 'x'.repeat(10001)], ['client', 'c1', 'lat', 'x'], ['client', 'c1', 'lat', 91], ['client', 'c1', 'lng', Infinity],
    ['client', 'c1', 'groupId', '../x'], ['client', 'c1', 'groupId', 7], ['client', 'c1', 'tier', 'AAAAAAAAAA'], ['client', 'c1', 'tier', { a: 1 }],
    ['client', 'c1', 'extra', 'str'], ['client', 'c1', 'extra', { a: { nested: 1 } }], ['client', 'c1', 'extra', []],
    ['client', 'c1', 'gbp', { website: 'javascript:alert(1)' }], ['client', 'c1', 'gbp', { placeId: 'x' }], ['client', 'c1', 'gbp', 'str'],
    ['prospect', 'p1', 'status', 'bogus'], ['prospect', 'p1', 'group', 'a b'], ['group', 'g1', 'number', -1], ['group', 'g1', 'number', 1.5], ['group', 'g1', 'color', 5],
    ['settings', 'settings', 'dueDays', 'x'], ['settings', 'settings', 'dayStart', 'late'], ['settings', 'settings', 'home', { lat: 'x' }], ['settings', 'settings', 'tiers', { A: 5 }]];
  for (const a of bad) assert.equal(set(...a), null, JSON.stringify(a));
  assert.equal(SyncOps.validateOp({ k: 'add', e: 'prospect', id: 'p9', v: { name: 'N', status: 'weird' }, t: NOW }, 's', NOW), null);
  assert.equal(SyncOps.validateOp({ k: 'add', e: 'client', id: 'c9', v: { name: 'N', lat: 'north' }, t: NOW }, 's', NOW), null);
  assert.ok(SyncOps.validateOp({ k: 'add', e: 'client', id: 'c9', v: { name: 'N', lat: 4 }, t: NOW }, 's', NOW));
  assert.equal(SyncOps.validateOp({ k: 'add', e: 'client', id: 'c9', v: { name: 'N', country: null }, t: NOW }, 's', NOW).v.country, '');
});

test('timestamps more than 10 minutes ahead are clamped, not dropped (ops) and ignored by the clock', () => {
  assert.equal(SyncOps.validateOp({ ...goodSet, t: NOW + 9 * 60 * 1000 }, 's', NOW).t, NOW + 9 * 60 * 1000);
  // A phone with a fast clock keeps its edit; its stamp can't land more than 10 minutes ahead.
  assert.equal(SyncOps.validateOp({ ...goodSet, t: NOW + 11 * 60 * 1000 }, 's', NOW).t, NOW + 10 * 60 * 1000);
  assert.equal(SyncOps.validateOp({ ...goodSet, t: NOW + 25 * 3600 * 1000 }, 's', NOW).t, NOW + 10 * 60 * 1000);
  const clock = SyncOps.createClock('A', 0, () => NOW);
  clock.observe(NOW + 11 * 60 * 1000); assert.equal(clock.last, 0);
  clock.observe(NOW + 9 * 60 * 1000); assert.equal(clock.last, NOW + 9 * 60 * 1000);
});

test('phone ops about unknown entities leave no stamps', () => {
  const stamps = {};
  const known = new Set(['client:c1']);
  const exists = (e, id) => known.has(e + ':' + id);
  const ops = [
    { k: 'set', e: 'client', id: 'ghost', f: 'notes', v: 'x', t: 5, d: 'P' },
    { k: 'visit', e: 'visit', id: 'vg', c: 'ghost', v: { id: 'vg', date: '2026-11-01' }, t: 6, d: 'P' },
    { k: 'del', e: 'visit', id: 'vh', c: 'ghost', t: 7, d: 'P' },
    { k: 'set', e: 'client', id: 'c1', f: 'notes', v: 'real', t: 8, d: 'P' },
  ];
  const { win } = SyncOps.resolve(ops, stamps, { fromPhone: true, exists });
  assert.deepEqual(win.map(o => o.id), ['c1']);
  assert.deepEqual(Object.keys(stamps), ['client:c1:notes']);
});

test('everything the app itself produces passes validation', () => {
  const data = sampleData();
  data.clients.push({ id: 'c3', name: 'Bare', visits: [{ id: 'v5', date: '2026-10-02', status: 'planned', order: 1 }] }); // missing fields travel as null
  data.prospecting.prospects.push({ id: 'p2', name: 'Grouped', status: 'visited', notes: '', extra: {}, group: 3 }); // "Group by proximity" stores a number
  const empty = { clients: {}, groups: {}, prospects: {}, settings: {} };
  const ops = SyncOps.diff(empty, SyncModel.project(data), clockAt('PC', 0, NOW));
  assert.ok(ops.length > 10);
  for (const op of ops) assert.ok(SyncOps.validateOp(op, 'PC', NOW), JSON.stringify(op));
  const regroup = { k: 'set', e: 'prospect', id: 'p1', f: 'group', t: 1 };
  assert.ok(SyncOps.validateOp({ ...regroup, v: 2 }, 'PC', NOW), 'a prospect group number is valid');
  assert.ok(SyncOps.validateOp({ ...regroup, v: null }, 'PC', NOW), 'no group is valid');
  for (const bad of [0, -1, 1.5, 1e6, {}, '<b>']) assert.equal(SyncOps.validateOp({ ...regroup, v: bad }, 'PC', NOW), null, JSON.stringify(bad));
});

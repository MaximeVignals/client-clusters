const assert = require('node:assert/strict');
const { test } = require('node:test');
const Visits = require('../src/shared/visits');

const TODAY = '2026-11-10';
let n = 0;
const uid = () => 'id' + (++n);
const client = visits => ({ id: 'c1', name: 'Test Client', visits });

test('done recorded on a planned day confirms that planned visit', () => {
  const c = client([{ id: 'p1', date: TODAY, status: 'planned', type: 'visit', outcome: '', note: 'bring samples' }]);
  const v = Visits.recordVisit(c, { date: TODAY, outcome: 'ok' }, TODAY, uid);
  assert.equal(v.id, 'p1');
  assert.equal(c.visits.length, 1);
  assert.equal(v.status, 'done');
  assert.equal(v.confirmedFrom, 'planned');
  assert.equal(v.note, 'bring samples');
});

test('a phone call does not confirm a planned visit', () => {
  const c = client([{ id: 'p1', date: TODAY, status: 'planned', type: 'visit', outcome: '', note: '' }]);
  const v = Visits.recordVisit(c, { date: TODAY, type: 'call' }, TODAY, uid);
  assert.notEqual(v.id, 'p1');
  assert.equal(c.visits.length, 2);
  assert.equal(c.visits[0].status, 'planned');
  assert.equal(v.confirmedFrom, undefined);
});

test('future date is recorded as planned and does not duplicate', () => {
  const c = client([]);
  const a = Visits.recordVisit(c, { date: '2026-11-20' }, TODAY, uid);
  const b = Visits.recordVisit(c, { date: '2026-11-20', note: 'x' }, TODAY, uid);
  assert.equal(a, b);
  assert.equal(a.status, 'planned');
  assert.equal(Visits.nextPlannedVisit(c, TODAY), '2026-11-20');
  assert.equal(Visits.lastVisit(c, TODAY), null);
});

test('undoDone reverts a confirmed visit and removes a fresh one', () => {
  const c = client([{ id: 'p1', date: TODAY, status: 'planned', type: 'visit', outcome: '', note: '' }]);
  const confirmed = Visits.recordVisit(c, { date: TODAY, outcome: 'order' }, TODAY, uid);
  Visits.undoDone(c, confirmed);
  assert.equal(c.visits.length, 1);
  assert.equal(c.visits[0].status, 'planned');
  assert.equal(c.visits[0].outcome, '');
  assert.equal('confirmedFrom' in c.visits[0], false);

  const fresh = Visits.recordVisit(c, { date: '2026-11-01' }, TODAY, uid);
  assert.equal(c.visits.length, 2);
  Visits.undoDone(c, fresh);
  assert.deepEqual(c.visits.map(v => v.id), ['p1']);
});

test('countsAsVisit is false for absent, closed, calls and planned', () => {
  assert.equal(Visits.countsAsVisit({ date: '2026-11-01', status: 'done', outcome: 'absent' }, TODAY), false);
  assert.equal(Visits.countsAsVisit({ date: '2026-11-01', status: 'done', outcome: 'closed' }, TODAY), false);
  assert.equal(Visits.countsAsVisit({ date: '2026-11-01', status: 'done', type: 'call' }, TODAY), false);
  assert.equal(Visits.countsAsVisit({ date: '2026-11-20' }, TODAY), false);
  assert.equal(Visits.countsAsVisit({ date: '2026-11-01', status: 'done', outcome: 'ok' }, TODAY), true);
});

test('normalizeVisits fills defaults and lastVisit picks newest counted visit', () => {
  const c = client([{ date: '2026-10-01' }, { date: '2026-10-20', outcome: 'absent' }, { date: '2026-12-01' }, null, { note: 'no date' }]);
  Visits.normalizeVisits(c, TODAY, uid);
  assert.equal(c.visits.length, 3);
  assert.ok(c.visits.every(v => v.id && v.type === 'visit' && v.note === ''));
  assert.equal(c.visits[2].status, 'planned');
  assert.equal(Visits.lastVisit(c, TODAY), '2026-10-01');
  assert.equal(Visits.plannedOf(c, TODAY).length, 1);
});

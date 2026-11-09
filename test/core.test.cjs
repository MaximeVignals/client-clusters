const assert = require('node:assert/strict');
const { test } = require('node:test');
const Hours = require('../src/renderer/hours');
const Planning = require('../src/renderer/planning');
const Cluster = require('../src/renderer/cluster');
globalThis.Hours = Hours;

test('opening hours parse French times and wrap Saturday night into Sunday', () => {
  const hours = Hours.parseWeek(['9h-12h / 14h-18h30', '', '', '', '', '22-2', '']);
  assert.equal(Hours.status(hours, new Date(2026, 10, 8, 1)).open, true);
  assert.equal(Hours.status(hours, new Date(2026, 10, 8, 3)).open, false);
  assert.throws(() => Hours.parseDay('25-26'));
  assert.deepEqual(Hours.parseDay('24h'), [[0, 1440]]);
});

test('planning includes the previous day’s overnight opening', () => {
  const hours = Hours.parseWeek(['22-2', '', '', '', '', '23-3', '']);
  assert.equal(Planning.checkArrival(hours, 2, 60, 30).state, 'open');
  assert.equal(Planning.checkArrival(hours, 0, 120, 30).state, 'open');
  assert.equal(Planning.checkArrival(hours, 2, 110, 30).state, 'closing');
  assert.equal(Planning.checkArrival(hours, 2, 180, 30).state, 'closedLater');
  assert.equal(Planning.checkArrival(hours, 1, 23 * 60 + 50, 30).state, 'open');
  const contiguous = Hours.parseWeek(['9-12, 12-18', '', '', '', '', '', '']);
  assert.equal(Planning.checkArrival(contiguous, 1, 11 * 60 + 50, 30).state, 'open');
  assert.deepEqual(Hours.toLines(hours), ['22:00–02:00', 'Closed', 'Closed', 'Closed', 'Closed', '23:00–03:00', 'Closed']);
});

test('a day plan rejects even its first new stop when it cannot fit', () => {
  const result = Planning.planDay([{ id: 'far', lat: 48, lng: 2, urgency: 3 }], {
    home: { lat: 45, lng: 2 }, startMin: 510, endMin: 540, visitMin: 30,
  });
  assert.deepEqual(result.ids, []);
});

test('day plans keep fixed stops and exclude clients closed that day', () => {
  const fixed = { id: 'fixed', lat: 45, lng: 4, urgency: 0 };
  const closed = { id: 'closed', lat: 45, lng: 4, urgency: 9, hours: Hours.parseWeek(['', '9-18', '', '', '', '', '']) };
  const result = Planning.planDay([closed, { id: 'near', lat: 45.001, lng: 4, urgency: 2 }], {
    fixed: [fixed], weekday: 1, maxStops: 2, startMin: 510, endMin: 1080,
  });
  assert.deepEqual(new Set(result.ids), new Set(['fixed', 'near']));
  assert.deepEqual(result.closedThatDay, ['closed']);
});

test('time input rejects invalid clock values', () => {
  assert.equal(Planning.parseHHMM('8h30'), 510);
  assert.equal(Planning.parseHHMM('23:59'), 1439);
  for (const value of ['24:00', '09:99', '99:00', 'garbage']) assert.equal(Planning.parseHHMM(value), null);
});

test('long Google routes retain every stop and connect adjacent parts', () => {
  const points = Array.from({ length: 25 }, (_, i) => ({ lat: 45 + i / 100, lng: 4 }));
  for (const home of [null, { lat: 44, lng: 3 }]) {
    const links = Planning.routeLinks(home, points);
    assert.equal(links[0].from, 1);
    assert.equal(links.at(-1).to, 25);
    let previous;
    const seen = new Set();
    for (const part of links) {
      const url = new URL(part.url);
      const waypoints = (url.searchParams.get('waypoints') || '').split('|').filter(Boolean);
      assert.ok(waypoints.length <= 9);
      if (previous) assert.equal(url.searchParams.get('origin'), previous);
      for (const p of [...waypoints, url.searchParams.get('origin'), url.searchParams.get('destination')]) seen.add(p);
      previous = url.searchParams.get('destination');
    }
    for (const p of points) assert.ok(seen.has(`${p.lat.toFixed(6)},${p.lng.toFixed(6)}`));
  }
  assert.equal(Planning.routeLinks(null, points.slice(0, 1)).length, 1);
});

test('clustering respects capacity, town flexibility and maximum pairwise distance', () => {
  const points = Array.from({ length: 55 }, (_, i) => ({
    lat: 45 + (i % 11) * 0.005, lng: 4 + Math.floor(i / 11) * 0.04,
    town: i < 7 ? 'One town' : '',
  }));
  const result = Cluster.groupByTownAndDistance(points, { maxSize: 6, flexSize: 8, maxSpanKm: 8 });
  assert.equal(result.labels.length, points.length);
  assert.equal(new Set(result.labels.slice(0, 7)).size, 1);
  for (let g = 0; g < result.groups; g++) {
    const members = points.filter((_, i) => result.labels[i] === g);
    assert.ok(members.length > 0 && members.length <= (g === result.labels[0] ? 8 : 6));
    assert.ok(Cluster.diameterKm(members) <= 8);
  }
  const a = Cluster.clusterPoints(points, 6);
  assert.deepEqual(a, Cluster.clusterPoints(points, 6));
  for (const g of new Set(a.labels)) assert.ok(a.labels.filter(x => x === g).length <= 6);
});

test('Google matching leaves ambiguous branches for review', () => {
  const client = { name: 'Boulangerie Martin', postcode: '69003', address: '12 rue Paul Bert' };
  const places = [1, 2].map(id => ({ id, name: client.name, address: '12 rue Paul Bert 69003 Lyon' }));
  assert.equal(Hours.judge(client, places).match, null);
  assert.equal(Hours.judge(client, places.slice(0, 1)).match.id, 1);
  // A postal code typed with stray punctuation must not break the search.
  assert.equal(Hours.judge({ ...client, postcode: '69003 (' }, places.slice(0, 1)).candidates.length, 1);
});

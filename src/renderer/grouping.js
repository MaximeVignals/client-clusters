/* Client Clusters — renderer: grouping clients by proximity */
'use strict';

// =====================================================================
// Grouping
// =====================================================================
function assignColors(groups) {
  const usage = new Array(PALETTE.length).fill(0);
  const done = [];
  for (const g of groups) {
    const near = done.filter(o => o.lat !== null && g.lat !== null)
      .map(o => [o, Cluster.distanceKm(g, o)]).sort((a, b) => a[1] - b[1]).slice(0, 6).map(x => x[0].color);
    let best = 0, bestScore = Infinity;
    PALETTE.forEach((col, i) => {
      const nIdx = near.indexOf(col);
      const score = (nIdx >= 0 ? 100 * (6 - nIdx) : 0) + usage[i];
      if (score < bestScore) { bestScore = score; best = i; }
    });
    g.color = PALETTE[best]; usage[best]++;
    done.push(g);
  }
}

async function regroup({ confirm = true } = {}) {
  const located = state.data.clients.filter(hasLoc);
  if (!located.length) { toast('No client is on the map yet, so there is nothing to group.', { error: true }); return; }
  if (confirm && state.data.groups.length) {
    const ok = await confirmDialog('Regroup all clients?', `The current ${state.data.groups.length} groups will be replaced by new ones (up to ${S().maxSize} clients each, all within ${S().maxSpanKm} km). Group names you chose yourself will be lost. Visit history is kept.`, 'Regroup');
    if (!ok) return;
  }
  showProgress('Grouping clients by proximity…', null);
  await new Promise(r => setTimeout(r, 30));
  try {
    const res = Cluster.groupByTownAndDistance(located.map(c => ({ lat: c.lat, lng: c.lng, town: townOf(c) })),
      { maxSize: S().maxSize, flexSize: S().flexSize, maxSpanKm: S().maxSpanKm });
    const groups = Array.from({ length: res.groups }, (_, i) => ({ id: uid(), number: i + 1, name: '', color: '', lat: null, lng: null }));
    const members = groups.map(() => []);
    for (const c of state.data.clients) c.groupId = null;
    located.forEach((c, i) => { c.groupId = groups[res.labels[i]].id; members[res.labels[i]].push(c); });
    groups.forEach((g, i) => {
      g.lat = members[i].reduce((a, c) => a + c.lat, 0) / members[i].length;
      g.lng = members[i].reduce((a, c) => a + c.lng, 0) / members[i].length;
    });
    assignColors(groups);
    groups.forEach(g => { delete g.lat; delete g.lng; });
    state.data.groups = groups;
    state.selectedGroupId = null; state.selectedClientId = null;
    state.tab = 'groups';
    save(); renderAll(); renderDetail(); fitAll();
    const notes = [];
    if (res.oversized) notes.push(`${res.oversized} ${res.oversized === 1 ? 'is' : 'are'} a bit bigger to keep a town together`);
    if (res.splitTowns.length) notes.push(`${res.splitTowns.map(titleCase).join(', ')} had too many clients for one group and ${res.splitTowns.length === 1 ? 'was' : 'were'} split by neighbourhood`);
    toast(`${res.groups} group${res.groups === 1 ? '' : 's'} created, each within ${S().maxSpanKm} km${notes.length ? ' — ' + notes.join('; ') : ''}.${homeOf() ? ' Group 1 is the nearest to home.' : ''}`);
  } finally { hideProgress(); }
}

function assignToNearest(list, { quiet } = {}) {
  derive();
  const groups = [...state.derived.byGroup.values()].map(i => ({ info: i, members: i.members.filter(hasLoc) }));
  let created = 0, added = 0;
  for (const c of list) {
    if (!hasLoc(c)) continue;
    const town = norm(townOf(c));
    let best = null, bestScore = Infinity;
    for (const g of groups) {
      if (!g.members.length) continue;
      const far = g.members.reduce((m, x) => Math.max(m, Cluster.distanceKm(c, x)), 0);
      if (far > S().maxSpanKm) continue;                          // would break the distance rule
      const allSameTown = town && g.members.every(x => norm(townOf(x)) === town);
      const limit = allSameTown ? S().flexSize : S().maxSize;     // a town may go a bit over to stay together
      if (g.members.length >= limit) continue;
      const sameTown = town && g.members.some(x => norm(townOf(x)) === town);
      const score = far - (sameTown ? 1000 : 0);                  // prefer the group of the same town
      if (score < bestScore) { bestScore = score; best = g; }
    }
    if (!best) {
      // Nothing close enough with room: start a new group.
      const number = state.data.groups.reduce((m, g) => Math.max(m, g.number), 0) + 1;
      const g = { id: uid(), number, name: '', color: PALETTE[(number - 1) % PALETTE.length] };
      state.data.groups.push(g);
      best = { info: { group: g }, members: [] };
      groups.push(best);
      created++;
    }
    c.groupId = best.info.group.id;
    best.members.push(c);
    added++;
  }
  if (!quiet && added) toast(`${added} client${added > 1 ? 's' : ''} added to the nearest group${created ? `; ${created} new group${created > 1 ? 's' : ''} started because no group within ${S().maxSpanKm} km had room` : ''}.`);
}

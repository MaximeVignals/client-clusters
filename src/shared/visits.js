// Visit rules shared by the Windows app and the Android companion. DOM-free; `today` (ISO date) and `uid` are passed in.
// A visit is { id, date, note, status: 'done' | 'planned' | 'cancelled', type: 'visit' | 'call', outcome, order? }.
// Only done in-person visits where someone was met count as the "last visit".
// A planned visit whose date has passed stays planned ("not confirmed") until it is marked done or cancelled.
(function (root) {
  'use strict';

  const VISIT_TYPES = { visit: 'Visit', call: 'Phone call' };
  const OUTCOMES = { '': 'No outcome', ok: 'Went well', order: 'Order taken', followup: 'Follow-up needed', absent: 'Nobody available', closed: 'Closed on arrival' };
  const NO_MEETING = new Set(['absent', 'closed']);

  const vStatus = (v, today) => v.status || (v.date > today ? 'planned' : 'done');
  const countsAsVisit = (v, today) => vStatus(v, today) === 'done' && (v.type || 'visit') === 'visit' && !NO_MEETING.has(v.outcome);

  function normalizeVisits(c, today, uid) {
    c.visits = (c.visits || []).filter(v => v && v.date);
    for (const v of c.visits) {
      if (!v.id) v.id = uid();
      if (!v.status) v.status = v.date > today ? 'planned' : 'done';
      if (!v.type) v.type = 'visit';
      if (v.outcome === undefined) v.outcome = '';
      if (v.note === undefined) v.note = '';
    }
    return c;
  }

  function lastVisit(c, today) {
    let best = null;
    for (const v of c.visits || []) if (countsAsVisit(v, today) && v.date <= today && (!best || v.date > best)) best = v.date;
    return best;
  }

  const plannedOf = (c, today) => (c.visits || []).filter(v => vStatus(v, today) === 'planned');

  function nextPlannedVisit(c, today) {
    let best = null;
    for (const v of plannedOf(c, today)) if (v.date >= today && (!best || v.date < best)) best = v.date;
    return best;
  }

  // Records a visit. A visit marked done on a day when one was planned confirms that planned visit.
  function recordVisit(c, { date, note = '', type = 'visit', outcome = '', status, order } = {}, today, uid) {
    c.visits = c.visits || [];
    const st = status || (date > today ? 'planned' : 'done');
    if (st === 'done' && type === 'visit') { // a phone call doesn't confirm a planned visit
      const p = c.visits.find(v => vStatus(v, today) === 'planned' && v.date === date && (v.type || 'visit') === type);
      if (p) { Object.assign(p, { status: 'done', note: note || p.note || '', type, outcome, confirmedFrom: 'planned' }); return p; }
    }
    if (st === 'planned') {
      const p = c.visits.find(v => vStatus(v, today) === 'planned' && v.date === date && (v.type || 'visit') === type);
      if (p) { if (note) p.note = note; return p; }
    }
    const v = { id: uid(), date, note, type, outcome, status: st };
    if (order !== undefined) v.order = order;
    c.visits.push(v);
    return v;
  }

  // Undo "mark done": a confirmed planned visit goes back to planned, any other is removed.
  function undoDone(c, v) {
    if (v.confirmedFrom === 'planned') { v.status = 'planned'; v.outcome = ''; delete v.confirmedFrom; }
    else c.visits = c.visits.filter(x => x !== v);
  }

  const api = { VISIT_TYPES, OUTCOMES, NO_MEETING, vStatus, countsAsVisit, normalizeVisits, lastVisit, plannedOf, nextPlannedVisit, recordVisit, undoDone };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Visits = api;
})(typeof window !== 'undefined' ? window : globalThis);

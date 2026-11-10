// Sync operations: hybrid logical clock, diff -> change records, last-writer-wins resolution, apply.
// Shared by Windows and Android (UMD: require() in Node, global SyncOps in a page).
(function (root) {
  const Model = (typeof module !== 'undefined' && module.exports) ? require('./sync-model') : root.SyncModel;
  const { FIELDS, COLLECTION, GBP_FIELDS, VISIT_STATUS, VISIT_TYPES, VISIT_OUTCOMES, PROSPECT_STATUS } = Model;
  const TOMBSTONE_MS = 90 * 24 * 3600 * 1000;
  const MAX_AHEAD_MS = 10 * 60 * 1000;     // an op stamped further in the future than this is clamped to it
  const MAX_STR = 10000;                   // longest string inside a visit
  const MAX_VALUE_JSON = 500000;           // biggest set/add value
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const validId = s => typeof s === 'string' && ID_RE.test(s) && s !== '__proto__';
  const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  const clone = x => (x === undefined ? null : JSON.parse(JSON.stringify(x)));
  const canon = x => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.keys(v).sort().reduce((o, key) => { o[key] = v[key]; return o; }, {}) : v));
  const same = (a, b) => canon(a === undefined ? null : a) === canon(b === undefined ? null : b);

  // ---- Clock: t = max(now, last + 1); observe(t) never lets us fall behind what we have seen.
  function createClock(deviceId, lastT = 0, nowFn = Date.now) {
    let last = lastT || 0;
    return {
      deviceId,
      now() { last = Math.max(nowFn(), last + 1); return last; },
      // Only believable timestamps move the clock: a peer cannot push it into the far future.
      observe(t) { if (Number.isSafeInteger(t) && t > last && t <= nowFn() + MAX_AHEAD_MS) last = t; },
      get last() { return last; },
    };
  }

  // (t, d) lexicographic; an identical stamp is not newer (duplicate delivery is a no-op).
  const newer = (a, b) => !b || a.t > b.t || (a.t === b.t && a.d > b.d);

  const clSnapshot = c => ({ name: c.name, address: c.address, postcode: c.postcode, city: c.city, country: c.country, lat: c.lat, lng: c.lng });

  // ---- validation of ops that arrive from the relay. Returns a fresh, whitelisted op, or null.
  const CL_STR = ['name', 'address', 'postcode', 'city', 'country'];
  function cleanCl(cl) {
    if (!isObj(cl)) return null;
    const out = {};
    for (const f of CL_STR) {
      const v = cl[f] === undefined || cl[f] === null ? '' : cl[f];
      if (typeof v !== 'string' || v.length > MAX_STR) return null;
      out[f] = v;
    }
    for (const f of ['lat', 'lng']) {
      const v = cl[f] === undefined ? null : cl[f];
      if (v !== null && !(typeof v === 'number' && Number.isFinite(v))) return null;
      out[f] = v;
    }
    return out;
  }
  const isStr = (v, max = MAX_STR) => typeof v === 'string' && v.length <= max;
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const idOrNull = v => v === null || validId(v);
  const isDate = v => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(v + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  };
  const jsonLen = v => { try { return JSON.stringify(v).length; } catch { return Infinity; } };
  const validExtra = v => isObj(v) && Object.keys(v).length <= 500 && jsonLen(v) <= 200000
    && Object.values(v).every(x => x === null || typeof x === 'boolean' || isNum(x) || isStr(x));
  const urlish = v => v === null || (isStr(v, 2000) && (v === '' || /^https?:\/\//i.test(v)));
  const validGbp = v => v === null || (isObj(v) && Object.keys(v).every(k => GBP_FIELDS.includes(k))
    && (v.hours === undefined || v.hours === null || ((isObj(v.hours) || Array.isArray(v.hours)) && jsonLen(v.hours) <= 20000))
    && (v.phone === undefined || v.phone === null || isStr(v.phone, 200))
    && (v.website === undefined || urlish(v.website)) && (v.url === undefined || urlish(v.url)));
  // One checker per synced field name (the names do not clash between entities).
  const FIELD_OK = {
    name: v => isStr(v), address: v => isStr(v), postcode: v => isStr(v), city: v => isStr(v), country: v => isStr(v), notes: v => isStr(v),
    lat: v => v === null || (isNum(v) && Math.abs(v) <= 90), lng: v => v === null || (isNum(v) && Math.abs(v) <= 180),
    groupId: idOrNull,
    // A prospect's group is its number ("Group by proximity" numbers them 1, 2, 3…), not the id of a client group.
    group: v => idOrNull(v) || (Number.isSafeInteger(v) && v > 0 && v < 1e6),
    tier: v => v === null || v === '' || (typeof v === 'string' && /^[A-Za-z0-9]{1,8}$/.test(v)),
    extra: validExtra, gbp: validGbp,
    status: v => PROSPECT_STATUS.includes(v),
    number: v => v === null || (Number.isSafeInteger(v) && v >= 0 && v < 1e6),
    color: v => v === null || isStr(v, 64),
    home: v => v === null || (isObj(v) && jsonLen(v) <= 5000 && (v.lat === undefined || isNum(v.lat)) && (v.lng === undefined || isNum(v.lng))),
    tiers: v => isObj(v) && jsonLen(v) <= 5000 && Object.values(v).every(t => isObj(t) && Object.values(t).every(x => isNum(x) || isStr(x, 64))),
    dueDays: v => isNum(v) && v >= 0 && v <= 10000, overdueDays: v => isNum(v) && v >= 0 && v <= 10000, visitMin: v => isNum(v) && v >= 0 && v <= 10000,
    dayStart: v => typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v), dayEnd: v => typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v),
  };
  // A missing text field travels as null; receivers get an empty string, never null.
  const STR_FIELDS = ['name', 'address', 'postcode', 'city', 'country', 'notes'];
  const textOrNull = (f, v) => (v === null ? (STR_FIELDS.includes(f) ? '' : f === 'extra' ? {} : v) : v);
  const fieldOk = (f, v) => hasOwn(FIELD_OK, f) && FIELD_OK[f](v);

  // Rebuilds a visit from the whitelist of keys, checking each value; null when anything is off.
  function cleanVisit(v, id) {
    if (!isObj(v) || v.id !== id || !isDate(v.date)) return null;
    const out = { id, date: v.date };
    if (v.note !== undefined) { if (!isStr(v.note)) return null; out.note = v.note; }
    if (v.status !== undefined) { if (!VISIT_STATUS.includes(v.status)) return null; out.status = v.status; }
    if (v.type !== undefined) { if (!VISIT_TYPES.includes(v.type)) return null; out.type = v.type; }
    if (v.outcome !== undefined) { if (!VISIT_OUTCOMES.includes(v.outcome)) return null; out.outcome = v.outcome; }
    if (v.order !== undefined) { if (!isNum(v.order)) return null; out.order = v.order; }
    if (v.confirmedFrom !== undefined) { if (v.confirmedFrom !== 'planned') return null; out.confirmedFrom = 'planned'; }
    return out;
  }
  function validateOp(op, fromDeviceId, nowMs) {
    if (!isObj(op) || typeof fromDeviceId !== 'string' || !fromDeviceId) return null;
    const now = nowMs === undefined ? Date.now() : nowMs;
    if (!Number.isSafeInteger(op.t) || op.t < 0) return null;
    const { k, e } = op;
    // A device whose clock runs fast must not lose its edits: clamp instead of rejecting,
    // so a stamp can never land more than MAX_AHEAD_MS in the receiver's future.
    const out = { k, e, t: Math.min(op.t, now + MAX_AHEAD_MS), d: fromDeviceId };
    if (k === 'visit') {
      if (e !== 'visit' || !validId(op.id) || !validId(op.c)) return null;
      const v = cleanVisit(op.v, op.id);
      if (!v) return null;
      out.id = op.id; out.c = op.c; out.v = v;
      const cl = op.cl === undefined ? null : cleanCl(op.cl);
      if (cl) out.cl = cl;
      return out;
    }
    if (k === 'del') {
      if (!['group', 'client', 'prospect', 'visit'].includes(e) || !validId(op.id)) return null;
      out.id = op.id;
      if (e === 'visit') { if (!validId(op.c)) return null; out.c = op.c; }
      return out;
    }
    if (k === 'set') {
      if (!hasOwn(FIELDS, e) || !FIELDS[e].includes(op.f)) return null;
      if (e === 'settings' ? op.id !== 'settings' : !validId(op.id)) return null;
      const v = textOrNull(op.f, op.v === undefined ? null : op.v);
      if (!fieldOk(op.f, v) || jsonLen(v) > MAX_VALUE_JSON) return null;
      out.id = op.id; out.f = op.f; out.v = clone(v);
      return out;
    }
    if (k === 'add') {
      if (!['group', 'client', 'prospect'].includes(e) || !validId(op.id) || !isObj(op.v)) return null;
      const v = {};
      for (const f of FIELDS[e]) {
        if (!hasOwn(op.v, f)) continue;
        const fv = textOrNull(f, op.v[f]);
        if (!fieldOk(f, fv)) return null;
        v[f] = fv;
      }
      if (jsonLen(v) > MAX_VALUE_JSON) return null;
      out.id = op.id; out.v = clone(v);
      return out;
    }
    return null;
  }

  // ---- diff: Proj -> Op[]
  function diff(prev, next, clock) {
    prev = prev || {}; next = next || {};
    const ops = [];
    const mk = o => { ops.push({ ...o, t: clock.now(), d: clock.deviceId }); };
    for (const e of ['group', 'client', 'prospect']) {
      const coll = COLLECTION[e];
      const a = prev[coll] || {}, b = next[coll] || {};
      for (const id of Object.keys(b)) {
        const n = b[id], p = a[id];
        if (!p) {
          const v = {};
          for (const f of FIELDS[e]) v[f] = clone(n[f]);
          mk({ k: 'add', e, id, v });
          if (e === 'client') for (const vid of Object.keys(n.visits || {})) mk({ k: 'visit', e: 'visit', id: vid, c: id, v: clone(n.visits[vid]), cl: clSnapshot(n) });
          continue;
        }
        for (const f of FIELDS[e]) if (!same(p[f], n[f])) mk({ k: 'set', e, id, f, v: clone(n[f]) });
        if (e === 'client') {
          const pv = p.visits || {}, nv = n.visits || {};
          for (const vid of Object.keys(nv)) if (!pv[vid] || !same(pv[vid], nv[vid])) mk({ k: 'visit', e: 'visit', id: vid, c: id, v: clone(nv[vid]), cl: clSnapshot(n) });
          for (const vid of Object.keys(pv)) if (!nv[vid]) mk({ k: 'del', e: 'visit', id: vid, c: id });
        }
      }
      for (const id of Object.keys(a)) {
        if (b[id]) continue;
        // Visits first, so a receiver sees the client empty when the client itself is deleted.
        if (e === 'client') for (const vid of Object.keys(a[id].visits || {})) mk({ k: 'del', e: 'visit', id: vid, c: id });
        mk({ k: 'del', e, id });
      }
    }
    const ps = prev.settings || {}, ns = next.settings || {};
    for (const f of FIELDS.settings) if (ns[f] !== undefined && !same(ps[f], ns[f])) mk({ k: 'set', e: 'settings', id: 'settings', f, v: clone(ns[f]) });
    return ops;
  }

  // ---- resolve: last writer wins per key. Updates `stamps` in place; returns the winning ops.
  // Keys: `e:id:f` (field), `e:id` (entity add/delete), `visit:id` (visit upsert/delete).
  function resolve(ops, stamps, opts) {
    const fromPhone = !!(opts && opts.fromPhone);
    // opts.exists(e, id): does this device know the entity? A phone op about an unknown one is dropped without leaving a stamp.
    const exists = opts && opts.exists;
    const unknown = (e, id) => fromPhone && exists && !exists(e, id);
    const win = [];
    let ignored = 0;
    for (const op of ops || []) {
      if (fromPhone && !Model.phoneMayWrite(op)) { ignored++; continue; }
      const st = { t: op.t, d: op.d };
      if (op.k === 'set') {
        const key = `${op.e}:${op.id}:${op.f}`;
        if (op.e !== 'settings' && unknown(op.e, op.id) && !(stamps[`${op.e}:${op.id}`] && stamps[`${op.e}:${op.id}`].del === false)) continue;
        if (!newer(op, stamps[key])) continue;
        stamps[key] = { ...st, v: op.v }; win.push(op); // value kept: an `add` arriving later needs it
      } else if (op.k === 'add') {
        const key = `${op.e}:${op.id}`;
        if (!newer(op, stamps[key])) continue;
        // A field already written by something newer (a `set` that arrived first) keeps that value.
        const v = {};
        for (const f of Object.keys(op.v || {})) {
          const fk = `${key}:${f}`, cur = stamps[fk];
          if (newer(op, cur)) { v[f] = op.v[f]; stamps[fk] = st; }
          else if ('v' in cur) v[f] = cur.v;
        }
        stamps[key] = { ...st, del: false };
        win.push({ ...op, v });
      } else if (op.k === 'del' && op.e === 'visit') {
        if (unknown('client', op.c)) continue;
        const key = `visit:${op.id}`;
        if (!newer(op, stamps[key])) continue;
        stamps[key] = { ...st, del: true }; win.push(op);
      } else if (op.k === 'del') {
        const key = `${op.e}:${op.id}`;
        if (!newer(op, stamps[key])) continue;
        stamps[key] = { ...st, del: true }; win.push(op);
      } else if (op.k === 'visit') {
        const key = `visit:${op.id}`;
        const tomb = stamps[`client:${op.c}`];
        if (unknown('client', op.c) && !(tomb && tomb.del === true)) continue;
        if (!newer(op, stamps[key])) continue;
        // The client was deleted here: the visit (field work) brings it back, using the client snapshot in `cl`.
        const ct = stamps[`client:${op.c}`];
        stamps[key] = { ...st, del: false }; win.push(ct && ct.del === true ? { ...op, restore: true } : op);
      }
    }
    return { win, ignored };
  }

  function pruneStamps(stamps, nowMs) {
    let n = 0;
    for (const k of Object.keys(stamps)) {
      if (stamps[k] && stamps[k].del && stamps[k].t < nowMs - TOMBSTONE_MS) { delete stamps[k]; n++; }
    }
    return n;
  }

  // ---- apply: one core over two storage adapters (projection, Windows data).
  const BLANK = {
    client: () => ({ name: '', address: '', postcode: '', city: '', country: '', lat: null, lng: null, groupId: null, tier: null, notes: '', extra: {} }),
    prospect: () => ({ name: '', address: '', postcode: '', city: '', country: '', lat: null, lng: null, status: 'todo', notes: '', group: null, extra: {} }),
    group: () => ({ number: null, name: '', color: null }),
  };

  // Apply one winning op through adapter `st`. Returns a kind string when something changed, else null.
  function applyOp(st, op, res) {
    if (op.k === 'set') {
      if (op.e === 'settings') { st.setSetting(op.f, op.v); return 'other'; }
      const ent = st.get(op.e, op.id);
      if (!ent) return null; // deleted (or not known yet): never resurrect from a set
      st.setField(op.e, ent, op.f, op.v);
      if (op.e === 'client' && op.f === 'notes') return 'notes';
      if (op.e === 'prospect') return 'prospects';
      return 'other';
    }
    if (op.k === 'add') {
      const ent = st.get(op.e, op.id);
      if (ent) { for (const f of Object.keys(op.v || {})) st.setField(op.e, ent, f, op.v[f]); }
      else st.create(op.e, op.id, op.v || {});
      return op.e === 'prospect' ? 'prospects' : 'other';
    }
    if (op.k === 'del' && op.e === 'visit') {
      const c = st.get('client', op.c);
      if (!c || !st.getVisit(c, op.id)) return null;
      st.delVisit(c, op.id);
      return 'visits';
    }
    if (op.k === 'del') {
      const ent = st.get(op.e, op.id);
      if (!ent) return null;
      // A client that still has live visits (e.g. one just logged on the phone) is kept: field work is never dropped.
      if (op.e === 'client' && st.visitCount(ent) > 0) return null;
      st.remove(op.e, op.id);
      return op.e === 'prospect' ? 'prospects' : 'other';
    }
    if (op.k === 'visit') {
      if (!op.v || typeof op.v !== 'object') return null;
      let c = st.get('client', op.c);
      if (!c) {
        // Only a client this device saw being deleted comes back (op.restore is set by resolve, never by the wire).
        const f = op.restore ? cleanCl(op.cl) : null;
        if (!f) return null;
        c = st.create('client', op.c, f);
        res.restored.push(f.name || op.c);
      }
      st.putVisit(c, op.v);
      return 'visits';
    }
    return null;
  }

  function applyAll(st, winOps) {
    const res = { restored: [], counts: { visits: 0, notes: 0, prospects: 0, other: 0 } };
    for (const op of winOps || []) {
      const kind = applyOp(st, op, res);
      if (kind) res.counts[kind]++;
    }
    return res;
  }

  function projAdapter(proj) {
    for (const k of ['clients', 'groups', 'prospects']) proj[k] = proj[k] || {};
    proj.settings = proj.settings || {};
    return {
      get: (e, id) => (hasOwn(proj[COLLECTION[e]], id) ? proj[COLLECTION[e]][id] : undefined),
      create(e, id, fields) {
        const ent = { id, ...BLANK[e](), ...clone(fields), id };
        if (e === 'client') { ent.visits = {}; if (ent.gbp === undefined) ent.gbp = null; }
        Object.defineProperty(proj[COLLECTION[e]], id, { value: ent, enumerable: true, writable: true, configurable: true });
        return ent;
      },
      remove: (e, id) => { delete proj[COLLECTION[e]][id]; },
      setField: (e, ent, f, v) => { ent[f] = clone(v); },
      setSetting: (f, v) => { proj.settings[f] = clone(v); },
      getVisit: (c, vid) => (c.visits && hasOwn(c.visits, vid) ? c.visits[vid] : undefined),
      putVisit: (c, v) => {
        c.visits = c.visits || {};
        Object.defineProperty(c.visits, v.id, { value: clone(v), enumerable: true, writable: true, configurable: true });
      },
      delVisit: (c, vid) => { delete c.visits[vid]; },
      visitCount: c => Object.keys(c.visits || {}).length,
    };
  }

  function dataAdapter(data) {
    data.clients = data.clients || [];
    data.groups = data.groups || [];
    data.settings = data.settings || {};
    const ensureProspecting = () => {
      if (!data.prospecting) data.prospecting = { fileName: '', importedAt: null, prospects: [], areas: [] };
      if (!data.prospecting.prospects) data.prospecting.prospects = [];
      return data.prospecting.prospects;
    };
    const list = e => (e === 'client' ? data.clients : e === 'group' ? data.groups : ensureProspecting());
    const index = {
      client: new Map(data.clients.map(x => [x.id, x])),
      group: new Map(data.groups.map(x => [x.id, x])),
      prospect: new Map(((data.prospecting && data.prospecting.prospects) || []).map(x => [x.id, x])),
    };
    return {
      get: (e, id) => index[e].get(id),
      create(e, id, fields) {
        const ent = { id, ...BLANK[e](), ...clone(fields), id };
        if (e === 'client') { ent.visits = []; if (ent.gbp === null) delete ent.gbp; }
        list(e).push(ent); index[e].set(id, ent);
        return ent;
      },
      remove(e, id) {
        const arr = list(e), i = arr.findIndex(x => x.id === id);
        if (i >= 0) arr.splice(i, 1);
        index[e].delete(id);
      },
      setField(e, ent, f, v) {
        if (f === 'gbp') {
          // Only the projected Google fields; internal ones (match info, timestamps) stay as they are.
          if (v && typeof v === 'object') { ent.gbp = ent.gbp || {}; for (const g of GBP_FIELDS) if (g in v) ent.gbp[g] = clone(v[g]); }
          return;
        }
        ent[f] = clone(v);
      },
      setSetting: (f, v) => { data.settings[f] = clone(v); },
      getVisit: (c, vid) => (c.visits || []).find(x => x.id === vid),
      putVisit(c, v) {
        c.visits = c.visits || [];
        const i = c.visits.findIndex(x => x.id === v.id);
        if (i >= 0) c.visits[i] = clone(v); else c.visits.push(clone(v));
      },
      delVisit: (c, vid) => { c.visits = (c.visits || []).filter(x => x.id !== vid); },
      visitCount: c => (c.visits || []).length,
    };
  }

  function applyToProj(proj, winOps) { return applyAll(projAdapter(proj), winOps); }
  // data = Windows state.data. Fields outside the projection are left untouched.
  function applyToData(data, winOps) { return applyAll(dataAdapter(data), winOps); }

  const api = { createClock, diff, resolve, validateOp, validId, applyToProj, applyToData, pruneStamps, TOMBSTONE_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SyncOps = api;
})(typeof window !== 'undefined' ? window : globalThis);

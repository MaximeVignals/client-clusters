// Sync engine: capture local changes, exchange encrypted bundles through the relay, resolve and apply.
// Shared by Windows (main process) and Android (UMD: require() in Node, global SyncEngine in a page).
// The engine never knows the relay URL or token: `transport(action, body)` is injected. It must return the parsed
// JSON, or throw an Error with `.status` (HTTP code) or `.network = true`. The transport throws unless the HTTP
// status is 2xx AND the body is JSON with `ok === true`; the engine still checks the fields it relies on.
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const Ops = isNode ? require('./sync-ops') : root.SyncOps;
  const Model = isNode ? require('./sync-model') : root.SyncModel;
  const Crypto = isNode ? require('./sync-crypto') : root.SyncCrypto;

  const AAD_BUNDLE = 'cc-bundle-v2';
  const AAD_SNAPSHOT = 'cc-snapshot-v2';
  const MAX_PLAIN_BYTES = 1000000;       // plaintext per bundle; base64 + wrapper stays under 1.5 MB
  const SNAPSHOT_EVERY = 100;            // bundles
  const SNAPSHOT_MS = 24 * 3600 * 1000;
  const KEY_MISMATCH_AFTER = 3;          // phone: trailing undecryptable bundles that make it check the key on the snapshot
  const MAX_PAGES = 1000;
  const MAX_INFLATED = 16 * 1024 * 1024; // inflated plaintext of one bundle or snapshot
  const APPLY_FAILS = 3;                 // same incoming batch refused this many times: quarantine it
  const BREAKER = { clients: 5, prospects: 5, visits: 20 }; // a capture deleting more than this waits for the user

  const clone = x => JSON.parse(JSON.stringify(x));
  const utf8 = new TextEncoder();

  // ---- gzip helpers: plaintext JSON is gzipped, base64'd into {z}, then encrypted.
  async function pipeBytes(bytes, stream) {
    const out = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(out).arrayBuffer());
  }
  async function inflateCapped(bytes, max) {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const chunks = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) { try { await reader.cancel(); } catch { /* already closed */ } throw new Error('inflated data too large'); }
      chunks.push(value);
    }
    const out = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }
  function toB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function fromB64(str) {
    const bin = atob(str), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function sealObj(key, obj, aad) {
    const gz = await pipeBytes(utf8.encode(JSON.stringify(obj)), new CompressionStream('gzip'));
    return JSON.stringify(await Crypto.encrypt(key, { z: toB64(gz) }, aad));
  }
  async function openObj(key, text, aad) {
    const w = await Crypto.decrypt(key, JSON.parse(text), aad);
    if (!w || typeof w.z !== 'string') throw new Error('bad envelope');
    const raw = await inflateCapped(fromB64(w.z), MAX_INFLATED);
    return JSON.parse(new TextDecoder().decode(raw));
  }

  function blankState() {
    return {
      cursor: 0, epoch: null, applyFail: null, skipSeqs: [], shadow: null, stamps: {}, clockT: 0, outbox: [],
      lastSnapshotSeq: 0, lastSnapshotAt: 0, bundlesSinceSnapshot: 0, lastSyncAt: 0,
    };
  }

  function codeError(code, message) { const e = new Error(message || code); e.code = code; return e; }

  function create(opts) {
    const { role, config, transport, store } = opts;
    const nowFn = opts.now || Date.now;
    if (role !== 'pc' && role !== 'phone') throw new Error('role must be pc or phone');
    if (!config.deviceId) throw new Error('config.deviceId is required (relay device id; get it from claim / addDevice / whoami)');
    if (role === 'phone' && !config.pcDeviceId) throw new Error('config.pcDeviceId is required on the phone');

    let state = null;
    let clock = null;
    let chain = Promise.resolve();
    let running = null;
    let pending = null;   // deletions held back by the circuit breaker: { ops, counts }
    const listeners = new Set();

    const engine = {
      role, status: 'idle', lastError: null, skippedBundles: 0, invalidOps: 0,
      // Deletions waiting for the user, { clients, prospects, visits }, or null.
      get needsConfirm() { return pending ? { ...pending.counts } : null; },
      get lastSyncAt() { return state ? state.lastSyncAt : 0; },
      get deviceId() { return selfId(); },
      onStatus(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    };

    const selfId = () => config.deviceId;
    const pcId = () => (role === 'pc' ? selfId() : config.pcDeviceId);

    function setStatus(status, err) {
      engine.status = status;
      engine.lastError = err || null;
      for (const cb of [...listeners]) { try { cb({ status, lastError: engine.lastError }); } catch { /* listener errors never break sync */ } }
    }

    async function load() {
      if (state) return;
      const saved = await store.load();
      state = Object.assign(blankState(), saved || {});
      clock = Ops.createClock(selfId(), state.clockT, nowFn);
    }

    const persist = async () => { state.clockT = clock.last; await store.save(state); };
    const enqueue = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
    const call = (action, body) => transport(action, body || {});

    // ---- sealing / opening
    const sealBundle = (ops, from) => sealObj(config.key, { ops, from, role }, AAD_BUNDLE);

    // Returns { ops, invalid } for a bundle sent by `b.device`, or throws. Binds the ops to the authenticated sender.
    // Ops that fail validation are dropped one by one: never the whole bundle, never a wedge.
    async function openBundle(b) {
      if (typeof b.bundle !== 'string') throw new Error('bad bundle');
      const p = await openObj(config.key, b.bundle, AAD_BUNDLE);
      if (!p || !Array.isArray(p.ops)) throw new Error('bad bundle');
      if (p.from !== b.device) throw new Error('sender mismatch');
      const now = nowFn(), ops = [];
      let invalid = 0;
      for (const raw of p.ops) {
        const op = Ops.validateOp(raw, b.device, now);
        if (op) ops.push(op); else invalid++;
      }
      return { ops, invalid };
    }

    // ---- relay answers: same relay as before (epoch)? same shape as promised?
    function track(st, r, need) {
      if (!r || typeof r !== 'object') throw codeError('bad-response', 'The server sent an unexpected answer');
      if (typeof r.epoch === 'string' && r.epoch) {
        if (!st.epoch) st.epoch = r.epoch;
        else if (st.epoch !== r.epoch) throw codeError('relay-reset', 'The sync server was reset or replaced');
      } else if (need) throw codeError('bad-response', 'The server sent an unexpected answer');
      return r;
    }
    async function pullPage(st, since) {
      const r = track(st, await call('pull', { since }), true);
      if (!Array.isArray(r.bundles) || !Number.isSafeInteger(r.last)) throw codeError('bad-response', 'The server sent an unexpected answer');
      if (r.last < st.cursor || r.last < since) throw codeError('relay-rollback', 'The sync server went back in time');
      return r;
    }

    // ---- capture
    // Everything the user could regret is held: clients, prospects, groups and visits. Only clients, prospects and
    // visits count toward the threshold; a visit that goes away with its deleted client is not counted twice.
    const isHeldDelete = op => op.k === 'del' && (op.e === 'client' || op.e === 'prospect' || op.e === 'group' || op.e === 'visit');
    function countDeletes(ops) {
      const c = { clients: 0, prospects: 0, groups: 0, visits: 0 };
      const gone = new Set(ops.filter(o => o.k === 'del' && o.e === 'client').map(o => o.id));
      for (const op of ops) {
        if (op.k !== 'del') continue;
        if (op.e === 'client') c.clients++;
        else if (op.e === 'prospect') c.prospects++;
        else if (op.e === 'group') c.groups++;
        else if (op.e === 'visit' && !gone.has(op.c)) c.visits++;
      }
      return c;
    }
    const tripped = c => c.clients > BREAKER.clients || c.prospects > BREAKER.prospects || c.visits > BREAKER.visits;

    function queue(ops) {
      const { win } = Ops.resolve(ops, state.stamps, { fromPhone: false });
      Ops.applyToProj(state.shadow, win);
      for (const op of win) state.outbox.push(op);
      return win.length;
    }

    // mode 'rebase': deletions are never sent. Otherwise the breaker applies on the PC.
    // Returns { n, held }: ops queued, and the deletions kept back.
    function captureNow(proj, mode) {
      if (!state.shadow || !proj) return { n: 0, held: [] }; // nothing to diff against until initPc / bootstrap
      let ops = Ops.diff(state.shadow, proj, clock);
      if (role === 'phone') ops = ops.filter(Model.phoneMayWrite);
      let held = [];
      const counts = countDeletes(ops);
      if (mode === 'rebase' || (role === 'pc' && tripped(counts))) {
        held = ops.filter(isHeldDelete);
        ops = ops.filter(op => !isHeldDelete(op));
      }
      pending = mode !== 'rebase' && held.length ? { ops: held, counts } : null;
      return { n: queue(ops), held };
    }

    // What the shadow has but the host lost, as ops the host can apply to get it back (adds first).
    function restoreOps(held) {
      const adds = [], visits = [];
      const sh = state.shadow;
      for (const op of held) {
        if (op.k !== 'del' || !sh) continue;
        if (op.e === 'client' || op.e === 'prospect' || op.e === 'group') {
          const coll = sh[Model.COLLECTION[op.e]];
          const ent = Object.prototype.hasOwnProperty.call(coll, op.id) ? coll[op.id] : null;
          if (!ent) continue;
          const v = {};
          for (const f of Model.FIELDS[op.e]) v[f] = clone(ent[f] === undefined ? null : ent[f]);
          adds.push({ k: 'add', e: op.e, id: op.id, v, t: 0, d: 'restore' });
        } else {
          const c = sh.clients[op.c], v = c && c.visits && c.visits[op.id];
          if (v) visits.push({ k: 'visit', e: 'visit', id: op.id, c: op.c, v: clone(v), t: 0, d: 'restore' });
        }
      }
      return adds.concat(visits);
    }

    // Returns how many ops were queued (the deletions held by the breaker are not among them; see needsConfirm).
    engine.capture = proj => enqueue(async () => {
      await load();
      const { n } = captureNow(proj);
      if (n) await persist();
      return n;
    });

    // The user decided about the held deletions. true: send them. false: drop them; `restore` holds ops that put the
    // entities back into the host data (apply them like incoming ops).
    engine.confirmDeletes = ok => enqueue(async () => {
      await load();
      const p = pending; pending = null;
      if (!p || !state.shadow) return { queued: 0, restore: [] };
      if (ok) { const n = queue(p.ops); await persist(); return { queued: n, restore: [] }; }
      return { queued: 0, restore: restoreOps(p.ops) };
    });

    // After the host replaced its data on purpose (recovery, Replace restore, start empty): what the shadow still has but
    // the host lost comes back as `ops` and is never sent as a deletion; everything else is captured normally.
    engine.rebase = proj => enqueue(async () => {
      await load();
      if (!state.shadow || !proj) return { ops: [], queued: 0 };
      const { n, held } = captureNow(proj, 'rebase');
      await persist();
      return { ops: restoreOps(held), queued: n };
    });

    // ---- snapshots
    async function uploadSnapshot(st) {
      const bundle = await sealObj(config.key, { proj: st.shadow, stamps: st.stamps, clockT: clock.last, seq: st.cursor }, AAD_SNAPSHOT);
      track(st, await call('putSnapshot', { seq: st.cursor, bundle }), false);
      st.lastSnapshotSeq = st.cursor;
      st.lastSnapshotAt = nowFn();
      st.bundlesSinceSnapshot = 0;
    }

    // First enable on the PC (also after a key reset): adopt `proj` as the shadow, skip whatever is on the relay, upload a snapshot.
    engine.initPc = proj => enqueue(async () => {
      if (role !== 'pc') throw new Error('initPc is for the PC');
      await load();
      try {
        if (!proj) throw codeError('no-data', 'There is no data to start from');
        let cursor = 0, pages = 0, r;
        const st = { cursor: 0, epoch: null }; // a new start: whatever relay answers now is the one we follow
        do {
          r = await pullPage(st, cursor);
          for (const b of r.bundles) cursor = Math.max(cursor, b.seq);
          if (!r.bundles.length) cursor = Math.max(cursor, (r.oldest || 1) - 1, r.last);
        } while (r.more && ++pages < MAX_PAGES);
        pending = null;
        Object.assign(state, { shadow: clone(proj), stamps: {}, outbox: [], cursor, epoch: st.epoch });
        await uploadSnapshot(state);
        await persist();
        setStatus('idle');
        return state.cursor;
      } catch (e) { setError(e); throw e; }
    });

    async function bootstrap(st) {
      const r = track(st, await call('getSnapshot', {}), false);
      if (!r || r.seq === null || r.seq === undefined || !r.bundle) throw codeError('no-snapshot', 'The relay has no snapshot yet; open the Windows app first');
      let snap;
      try { snap = await openObj(config.key, r.bundle, AAD_SNAPSHOT); } catch { throw codeError('key-mismatch'); }
      if (!snap || !snap.proj || typeof snap.proj !== 'object' || snap.seq !== r.seq) throw codeError('key-mismatch');
      clock.observe(snap.clockT);
      // Local edits not yet sent survive: replay the outbox over the snapshot (LWW decides per key).
      const outbox = st.outbox;
      st.shadow = snap.proj;
      st.stamps = snap.stamps || {};
      st.cursor = snap.seq;
      st.lastSnapshotSeq = snap.seq;
      const { win } = Ops.resolve(outbox, st.stamps, { fromPhone: false });
      Ops.applyToProj(st.shadow, win);
    }

    // The phone saw several bundles it could not read. A wrong key is proven by the snapshot not opening either.
    async function checkKeyOnSnapshot(st) {
      const r = track(st, await call('getSnapshot', {}), false);
      if (!r || r.seq === null || r.seq === undefined || !r.bundle) return;
      try { await openObj(config.key, r.bundle, AAD_SNAPSHOT); } catch { throw codeError('key-mismatch'); }
    }

    // Relay storage for this device is full (507): the PC writes a snapshot of what it has applied and compacts the
    // relay up to it, which frees the old bundles. Only own echoes are skipped over; others' bundles wait for a normal sync.
    async function relieveQuota() {
      const me = selfId();
      const st = state;
      for (let i = 0; i < MAX_PAGES; i++) {
        const r = await pullPage(st, st.cursor);
        let stop = false;
        for (const b of r.bundles) { if (b.device !== me) { stop = true; break; } st.cursor = b.seq; }
        if (stop || !r.more) break;
      }
      await uploadSnapshot(st);
      await call('compact', { upTo: st.lastSnapshotSeq });
    }

    // ---- sync
    function setError(e) {
      if (e && e.network) setStatus('offline', 'offline');
      else if (e && e.status === 401) setStatus('error', 'disconnected');
      else if (e && e.code === 'key-mismatch') setStatus('error', 'key-mismatch');
      else if (e && e.status === 507) setStatus('error', 'relay-full');
      else if (e && e.status === 413) setStatus('error', 'too-large');
      else setStatus('error', (e && (e.code || e.message)) || 'error');
    }

    function takeChunk(outbox) {
      let size = 0, n = 0;
      for (const op of outbox) {
        const s = utf8.encode(JSON.stringify(op)).length + 1;
        if (n > 0 && size + s > MAX_PLAIN_BYTES) break;
        size += s; n++;
      }
      return outbox.slice(0, n);
    }

    async function doSync(o) {
      const res = { pushed: 0, bundles: 0, pulled: 0, applied: 0, ignored: 0, skipped: 0, invalid: 0, quarantined: 0, status: null, needsConfirm: null };
      await load();
      setStatus('syncing');
      try {
        if (o.getProj) captureNow(o.getProj());
        const me = selfId();
        const st = clone(state);
        let r = await pullPage(st, st.cursor);
        let booted = false;

        if (!st.shadow || (role === 'phone' && r.snapshot && st.cursor < (r.oldest || 0) - 1)) {
          if (role !== 'phone') throw codeError('not-initialised', 'Sync is not initialised on this PC');
          await bootstrap(st);
          booted = true;
          r = await pullPage(st, st.cursor);
        }

        // Pull pages: decrypt, verify sender, validate, resolve, apply to shadow. Garbage is skipped, never blocking.
        const win = [], batch = [];
        let streak = 0, counted = 0;
        for (let page = 0; page < MAX_PAGES; page++) {
          for (const b of r.bundles) {
            if (!b || !Number.isSafeInteger(b.seq) || b.seq <= st.cursor) throw codeError('bad-response', 'The server sent an unexpected answer');
            if (b.device === me) { st.cursor = b.seq; counted++; continue; } // our own echo
            if (st.skipSeqs.includes(b.seq)) { // refused too often by the window: kept aside, not applied
              res.skipped++; res.quarantined++; engine.skippedBundles++;
              if (store.quarantine) { try { await store.quarantine(b.bundle); } catch { /* diagnostics only */ } }
              st.cursor = b.seq; counted++;
              continue;
            }
            let opened;
            try { opened = await openBundle(b); } catch {
              res.skipped++; engine.skippedBundles++; streak++;
              st.cursor = b.seq; counted++;
              continue;
            }
            streak = 0;
            st.cursor = b.seq; counted++;
            res.invalid += opened.invalid; engine.invalidOps += opened.invalid;
            let out;
            try {
              for (const op of opened.ops) clock.observe(op.t);
              out = Ops.resolve(opened.ops, st.stamps, { fromPhone: b.device !== pcId(), exists: (e, id) => Object.prototype.hasOwnProperty.call(st.shadow[Model.COLLECTION[e]] || {}, id) });
              Ops.applyToProj(st.shadow, out.win);
            } catch {
              res.skipped++; res.quarantined++; engine.skippedBundles++;
              if (store.quarantine) { try { await store.quarantine(b.bundle); } catch { /* diagnostics only */ } }
              continue;
            }
            res.pulled++;
            res.ignored += out.ignored;
            if (out.win.length) batch.push(b.seq);
            for (const w of out.win) win.push(w);
          }
          if (!r.more) break;
          r = await pullPage(st, st.cursor);
        }
        if (role === 'phone' && streak >= KEY_MISMATCH_AFTER && res.pulled === 0) await checkKeyOnSnapshot(st);
        st.bundlesSinceSnapshot += counted;
        Ops.pruneStamps(st.stamps, nowFn());

        // Hand the result to the host app, then commit. A throwing host (or one that never acknowledges) leaves the
        // persisted state untouched, so the same bundles are pulled again next time.
        if (booted) {
          if (!o.applySnapshot) throw new Error('applySnapshot hook required');
          await o.applySnapshot(clone(st.shadow));
          res.applied = win.length;
        } else if (win.length) {
          if (o.applyWin) {
            try { await o.applyWin(win); } catch (e) {
              // The same batch refused again and again must not wedge sync: the third time it is set aside (quarantined).
              if (!(e && e.message === 'window-not-ready')) {
                const key = batch.join(',');
                const n = state.applyFail && state.applyFail.key === key ? state.applyFail.n + 1 : 1;
                state.applyFail = { key, n };
                if (n >= APPLY_FAILS) { state.skipSeqs = batch.slice(); state.applyFail = null; }
              }
              throw e;
            }
          }
          res.applied = win.length;
        }
        st.skipSeqs = []; st.applyFail = null;
        st.clockT = clock.last;
        state = st;
        await persist();

        // Push the outbox; ops leave it only after the relay confirmed with a sequence number.
        let relieved = false;
        while (state.outbox.length) {
          const chunk = takeChunk(state.outbox);
          const sealed = await sealBundle(chunk, me);
          let pr;
          try { pr = await call('push', { bundle: sealed }); } catch (e) {
            if (!(e && e.status === 507 && role === 'pc' && !relieved)) throw e;
            relieved = true;
            try { await relieveQuota(); } catch { throw e; }
            pr = await call('push', { bundle: sealed });
          }
          track(state, pr, true);
          if (!Number.isSafeInteger(pr.seq)) throw codeError('bad-response', 'The server sent an unexpected answer');
          state.outbox.splice(0, chunk.length);
          res.pushed += chunk.length; res.bundles++;
          await persist();
        }

        if (role === 'pc' && !r.more && (state.bundlesSinceSnapshot > SNAPSHOT_EVERY || nowFn() - state.lastSnapshotAt > SNAPSHOT_MS)) {
          try {
            await uploadSnapshot(state);
            const upTo = state.lastSnapshotSeq;
            if (upTo > 0) { try { await call('compact', { upTo }); } catch (e) { res.compactError = (e && e.message) || String(e); } }
          } catch (e) { res.snapshotError = (e && e.message) || String(e); }
        }
        state.lastSyncAt = nowFn();
        await persist();
        setStatus('idle');
      } catch (e) {
        setError(e);
        if (state) { try { await persist(); } catch { /* keep the sync error */ } }
      }
      res.status = engine.status;
      res.error = engine.lastError;
      res.needsConfirm = engine.needsConfirm;
      return res;
    }

    // Calls made while a sync runs share its promise.
    engine.sync = (o) => {
      if (running) return running;
      running = enqueue(() => doSync(o || {})).finally(() => { running = null; });
      return running;
    };

    // Test/diagnostic access to persisted state.
    engine.getState = () => state;
    return engine;
  }

  const api = { create, AAD_BUNDLE, AAD_SNAPSHOT, sealObj, openObj };
  if (isNode) module.exports = api;
  else root.SyncEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);

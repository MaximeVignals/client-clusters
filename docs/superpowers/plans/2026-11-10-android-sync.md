# Android companion and self-hosted sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Field-companion Android app (Capacitor) that syncs with the Windows app through an end-to-end-encrypted PHP relay anyone can self-host.

**Architecture:** DOM-free shared modules (`src/shared/`) hold visit rules, projection, diff/apply with last-writer-wins, crypto and the sync engine. On Windows the engine runs in the main process (key and tokens never reach the renderer) and captures changes by diffing each saved data file against a shadow; winning incoming changes are sent to the renderer, which applies them with the same shared code. The phone stores the projection itself as its data.

**Tech Stack:** Node 26 / Electron 44, WebCrypto (AES-256-GCM), PHP 8 (relay, files only), Capacitor 8 (Android, JDK 21), Leaflet 1.9, npm `qrcode`.

**Spec:** `docs/superpowers/specs/2026-11-10-android-sync-design.md`

## Global Constraints
- Shared modules use the existing UMD pattern of `src/renderer/cluster.js`: IIFE, `module.exports` when present, else a global (`Visits`, `SyncModel`, `SyncOps`, `SyncCrypto`, `SyncEngine`).
- No server address, token, key or personal data in the repo. Tests use made-up data only.
- Sync off by default; with sync off, Windows behaviour and data file are identical to 1.9.2.
- Phone may write only: visits (upsert/delete), `client.notes`, `prospect.status`, `prospect.notes`.
- Bundle limit 2 MB; pull page 200 bundles; relay storage cap 50 MB default; prune > 60 days when covered by a snapshot; tombstones kept 90 days.
- Windows version 1.10.0; Android 1.0.0. Do not commit; the lead decides commits.
- Run `npm test` after every task; all existing tests must still pass.

## Review Focus
1. A phone offline for weeks, then syncing after the relay pruned old bundles → must bootstrap from snapshot and still upload its outbox (Task 5 test `stale phone rebootstraps and keeps its outbox`).
2. The same note edited on both devices while offline → identical result on both after sync (Task 2 convergence test).
3. A visit logged on the phone for a client deleted on the PC → client restored, visit kept (Task 2 test `visit for deleted client restores it`).
4. Relay given a wrong/revoked token, oversized bundle, or path-like input → 401/413/400, never a file outside `data/` (Task 4 tests).
5. Windows saving while incoming changes are applied → no echo of incoming changes back as local changes (Task 6 test `applied incoming ops are not re-captured`).

---

### Task 1: Extract visit rules to `src/shared/visits.js`
**Files:** Create `src/shared/visits.js`; Modify `src/renderer/state.js` (visit section), `src/index.html` or the renderer HTML that loads scripts (add the script before `state.js`); Test `test/visits.test.cjs`.
**Interfaces — Produces:** global/`module.exports` `Visits` = `{ VISIT_TYPES, OUTCOMES, NO_MEETING, vStatus(v, today), countsAsVisit(v, today), normalizeVisits(c, today, uid), lastVisit(c, today), plannedOf(c, today), nextPlannedVisit(c, today), recordVisit(c, opts, today, uid), undoDone(c, v) }`. `today` is an ISO date string; `uid` a function. `state.js` keeps its current function names as thin wrappers passing `todayISO()`/`uid`, so no other renderer file changes.
- [ ] Test: move existing semantics into tests: `recordVisit` done on a planned day confirms the planned visit (`confirmedFrom: 'planned'`); a call does not confirm; `undoDone` reverts a confirmed visit and removes a fresh one; `countsAsVisit` false for outcome `absent`.
- [ ] Run `npm test` → new tests fail. Implement. Run `npm test`, `npm run test:smoke` → pass.

### Task 2: Projection and change records — `src/shared/sync-model.js`, `src/shared/sync-ops.js`
**Files:** Create both; Test `test/sync-ops.test.cjs`.
**Interfaces — Produces:**
- `SyncModel.project(data) -> Proj` where `Proj = { clients: {[id]: {...fields, visits: {[vid]: visit}}}, groups: {[id]: {id, number, name, color}}, prospects: {[id]: {...}}, settings: {...} }` with exactly the spec's projected fields (`gbp` reduced to `{hours, phone, website, url}`).
- `SyncModel.phoneMayWrite(op) -> boolean` (spec's write permissions).
- `SyncOps.createClock(deviceId, lastT = 0) -> { now() -> number, observe(t) -> void, get last() }` hybrid logical clock.
- `SyncOps.diff(prev: Proj, next: Proj, clock) -> Op[]`; `Op = { k: 'set'|'add'|'del'|'visit', e: 'client'|'prospect'|'group'|'settings'|'visit', id, c?, f?, v?, t, d }`.
- `SyncOps.resolve(ops, stamps, { fromPhone }) -> { win: Op[], ignored: number }` — LWW per key (`e:id:f`, `visit:id`, entity tombstones `e:id`), tie by `d`; updates `stamps` in place for winners.
- `SyncOps.applyToProj(proj, winOps)` and `SyncOps.applyToData(data, winOps) -> { restored: string[], counts: {visits, notes, prospects, other} }` (data = Windows `state.data` shape). `applyToData` restores a deleted client when a `visit` op targets it, using the client fields carried on the op (`visit` ops from the phone carry `cl: {name, address, postcode, city, country, lat, lng}` snapshot).
- `SyncOps.pruneStamps(stamps, nowMs)` drops tombstones older than 90 days.
- [ ] Tests: diff of identical projections is `[]`; note edit → one `set`; new visit → one `visit`; removed visit → `del`; `phoneMayWrite` rejects `set client.name`; concurrent note edits with t=10 (A) and t=12 (B) → both devices end with B's value regardless of apply order; `visit for deleted client restores it`; property test: 200 random interleavings of edits on two devices exchanged in random order converge to deep-equal projections.
- [ ] Implement; `npm test` passes.

### Task 3: Crypto and pairing codes — `src/shared/sync-crypto.js`
**Files:** Create; Test `test/sync-crypto.test.cjs`.
**Interfaces — Produces:** `SyncCrypto = { generateKey() -> Promise<string base64url 32 bytes>, randomToken() -> string base64url 32 bytes, encrypt(keyB64, obj, aad: string) -> Promise<{ iv, ct }>, decrypt(keyB64, env, aad) -> Promise<obj>, encodePairing({ url, token, key, name }) -> string 'CCSYNC1.' + base64url(JSON), decodePairing(str) -> obj (throws 'Not a Client Clusters pairing code') }`. Uses `globalThis.crypto.subtle`.
- [ ] Tests: round trip; wrong key rejects; wrong AAD rejects; tampered `ct` rejects; IV differs between two encryptions; pairing round trip; garbage code throws.
- [ ] Implement; `npm test` passes.

### Task 4: PHP relay — `server/`
**Files:** Create `server/index.php`, `server/.htaccess`, `server/config.sample.php`, `server/README.md`; Test `test/relay.test.cjs` (skips with a message when `php` is not on PATH; set `PHP_BIN` env to override).
**Interfaces — Produces:** `POST index.php`, JSON `{ action, ...}`, `Authorization: Bearer <token>`. Actions and auth exactly as in the spec table. Responses `{ ok: true, ... }` or `{ ok: false, error }` with HTTP 400/401/403/409/413/429/507. `push {bundle: string}` → `{seq}`; `pull {since}` → `{bundles: [{seq, device, bundle}], more: bool, snapshot: {seq} | null, oldest: seq}`; `putSnapshot {seq, bundle}`; `getSnapshot` → `{seq, bundle}`; `claim {setupCode}` → `{adminToken}`; `addDevice {name}` → `{deviceId, token}`; `listDevices` → `{devices: [{deviceId, name, addedAt, lastSeen}]}`; `revokeDevice {deviceId}`. Device id for bundles comes from the token, not the request.
- [ ] Tests (via `php -S 127.0.0.1:<port> -t server`): hello before/after claim; claim twice → 409; wrong setup code → 403; push/pull ordering and paging at 200; revoked token → 401; 2 MB+1 bundle → 413; `data/` not served (GET `data/…` → 403/404); `since` given as `"../x"` → 400.
- [ ] Implement with `flock`, temp+rename writes, `hash_equals`, integer file names, `config.php` defaults (`DATA_DIR`, `SETUP_CODE`, `MAX_BUNDLE`, `MAX_TOTAL`).
- [ ] `server/README.md`: the five self-hosting steps from the design conversation.

### Task 5: Sync engine — `src/shared/sync-engine.js`
**Files:** Create; Test `test/sync-engine.test.cjs` with an in-memory fake relay implementing Task 4's protocol in JS.
**Interfaces — Consumes:** Tasks 2–3. **Produces:** `SyncEngine.create({ role: 'pc'|'phone', config: { url, token, key, deviceId }, transport: (action, body) -> Promise<json>, store: { load() -> Promise<state|null>, save(state) -> Promise }, now?: () => ms }) -> engine` with:
- `engine.capture(proj) -> Promise<number>` — diff vs shadow, append to outbox, update shadow/stamps, persist.
- `engine.sync({ getProj, applyWin }) -> Promise<{ pushed, pulled, applied, status }>` — push outbox in bundles (encrypted, AAD = `deviceId`), pull since cursor, decrypt, skip own device, `resolve` (fromPhone = sender is not the PC), `applyToProj` on shadow, call `applyWin(winOps)`, advance cursor; bootstrap from snapshot when cursor < `oldest`; PC role: `putSnapshot` when >100 bundles since last or 24 h.
- `engine.status` ∈ `'off'|'idle'|'syncing'|'offline'|'error'`, `engine.lastError`, `engine.lastSyncAt`.
- Errors: network → `offline`, keep outbox; 401 → `error` `'disconnected'`; decrypt failure → skip bundle, count; 3 in a row → `error` `'key-mismatch'`.
- [ ] Tests: two engines converge; `stale phone rebootstraps and keeps its outbox`; 401 sets disconnected; corrupted bundle skipped; snapshot written after 101 bundles.

### Task 6: Windows main process — `src/main/sync.js`
**Files:** Create `src/main/sync.js`; Modify `src/main.js` (require), `src/preload.js` (expose `sync*`), `src/main/files.js` (`data:save` calls `sync.onSaved(data)`), `src/main/backup.js` (confirm `sync.json` excluded); Test `test/main.test.cjs` additions or `test/sync-main.test.cjs`.
**Interfaces — Produces:** `sync.json` in userData `{ url, deviceId, enc: safeStorage(JSON{ adminToken, key }), engineStateFile }`; engine state in `sync-state.json`. IPC: `sync:status`, `sync:test(url)`, `sync:enable({url, setupCode})`, `sync:disable()`, `sync:addPhone(name) -> { code, qrDataUrl }`, `sync:listPhones`, `sync:revokePhone(id)`, `sync:now`; event `sync:incoming(winOps)` to renderer, `sync:status-changed`. HTTP via `net.fetch`. Timers: start, every 5 min, 5 s after save. Recovery mode: renderer tells main `sync:pause(bool)`.
- [ ] Test `applied incoming ops are not re-captured`: apply win ops to shadow, then `onSaved(data with ops applied)` captures 0 ops.
- [ ] Add `qrcode` dependency (check Context7 for its `toDataURL` API).

### Task 7: Windows renderer — Sync settings and incoming changes
**Files:** Create `src/renderer/sync.js`; Modify the renderer HTML (script tags for shared `sync-model.js`, `sync-ops.js`, `sync.js`), `src/renderer/settings.js` (Sync section), styles; Test: extend `test/desktop-ui.cjs` with a Sync section check using a stubbed `window.api`.
**Interfaces — Consumes:** Task 6 IPC, Task 2 `applyToData`. On `sync:incoming`: flush pending save, `SyncOps.applyToData(state.data, ops)`, `renderAll()`, `save()`, one toast summarising counts and restored clients. Status chip in top bar when enabled. Recovery: call `window.api.syncPause(true)` while `state.recovery`.
- [ ] `npm test`, `npm run test:smoke`, `npm run test:ui` pass.

### Task 8: Android app — `android/`
**Files:** Create `android/package.json`, `android/capacitor.config.json` (appId `com.clientclusters.companion`), `android/www/index.html`, `android/www/phone.css`, `android/www/phone.js` (+ small modules if >400 lines), `android/scripts/copy-shared.cjs` (copies `src/shared/*`, `src/renderer/hours.js`, `cluster.js`, `planning.js`, Leaflet into `www/lib/`), native project via `npx cap add android`; Test: `android/test/phone-ui.test.cjs` loads `www` in Electron (already a dev dependency) with a fake Capacitor bridge and checks Today, Client, log visit, prospect status, pairing paste.
**Interfaces — Consumes:** Tasks 1, 2, 3, 5. Storage via Capacitor Filesystem (`Directory.Data`, temp + rename), secrets via a secure-storage plugin, QR via barcode scanner plugin, HTTP via `CapacitorHttp`.
- [ ] `node android/scripts/copy-shared.cjs && npx cap sync android` succeeds; `gradlew assembleDebug` when JDK 21 is available.

### Task 9: Docs and release metadata
**Files:** `README.md` (Sync and Android section, self-hosting link), `CHANGELOG.md` (1.10.0), `package.json` version 1.10.0, `.gitignore` (`android/android/app/build`, keystores, `server/config.php`, `server/data/`).

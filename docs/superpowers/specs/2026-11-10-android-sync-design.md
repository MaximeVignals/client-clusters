# Android companion and self-hosted sync — design

Date: 2026-11-10 · Target: Windows 1.10.0 + Android 1.0.0

## Goal

Use Client Clusters on an Android phone in the field, kept in sync with the Windows app, through a relay
anyone can host on cheap PHP web hosting. The relay never sees readable data.

### Agreed with the owner
- The phone is a **field companion**: see today's plan, groups on a map, client details; log visits,
  mark planned visits done / didn't happen, edit client notes, change prospect status and notes.
- Everything else (import, grouping, Google hours, exports, backups, planning, priorities) stays on Windows.
- Sync goes through a small **PHP relay** (the owner uses OVH free hosting), **end-to-end encrypted**.
- **Anyone** who downloads the app can host their own relay: no server address, token or key in the repo.
- Android app built with **Capacitor**, reusing the existing renderer code where it is DOM-free.
- Sync is **off by default**: an unpaired Windows app behaves exactly as 1.9.2.

### Assumptions (owner can correct)
- One relay serves one person (one PC + their phones). No multi-user relay.
- The Windows app is the only device that can pair or revoke phones.
- The phone does not edit a client's address, name, group, tier, or planned dates.
- Phone numbers shown on the phone come from the imported columns (`extra`) and the Google page (`gbp.phone`);
  no new phone/contact field is added to the data model.

## Architecture

```
client-clusters-public/
  src/shared/        rules used by both apps (UMD: require() in Node, globals in a page)
    sync-model.js    which data the phone sees, which fields it may change
    sync-ops.js      diff → change records, apply records, last-writer-wins, clock
    sync-crypto.js   AES-256-GCM via WebCrypto, key/QR encoding
    sync-engine.js   outbox, cursor, push/pull loop; storage and HTTP are injected
  src/main/sync.js   Windows: settings + secrets (safeStorage), HTTP to relay, IPC
  src/renderer/sync.js  Windows: Settings → Sync UI, status, apply incoming changes
  server/            PHP relay: index.php, .htaccess, config.sample.php, README section
  android/           Capacitor app: www/ (phone UI), native project, build script
```

Shared modules follow the pattern already used by `cluster.js`/`hours.js`/`planning.js`:
an IIFE that exports with `module.exports` when available, otherwise sets a global.

### Change capture by diff, not by hooking every edit
Each device keeps a **shadow**: the synced projection of its data as of the last time it captured changes.
After every save (Windows: in `flushSave`; phone: after each edit) the engine diffs the current projection
against the shadow and turns differences into change records, then updates the shadow.
Incoming records are applied to both the data and the shadow, so they are never echoed back.
This keeps the existing renderer untouched except for one call after saving and one function to apply
incoming data.

### Projection (what the phone sees)
- `clients`: id, name, address, postcode, city, country, lat, lng, groupId, tier, notes, extra,
  gbp.{hours, phone, website, url} (no Google internals), visits.
- `groups`: id, number, name, color.
- `prospects`: id, name, address, postcode, city, country, lat, lng, status, notes, group, extra.
  Areas are not sent (YAGNI for v1).
- `settings`: home, tiers, dueDays, overdueDays, visitMin, dayStart, dayEnd (read-only on the phone).
Never sent: Google key, geocoding caches, import metadata, backup info.

### Change records
`{ k: kind, id, f: field?, v: value?, t: clock, d: deviceId }`, kinds:
- `set` — entity field value (`client`, `prospect`, `group`, `settings`)
- `visit` — whole visit object upsert (`id` = visit id, `c` = client id)
- `del` — entity deletion (client, prospect, group, visit) → tombstone kept in sync state for 90 days
- `add` — new entity with all fields (client, prospect, group)

**Validation (both sides, before anything is applied):** `SyncOps.validateOp(op, senderDeviceId)` keeps only
well-formed ops: ids match `^[A-Za-z0-9_-]{1,64}$` (and are not `__proto__`), `k`/`e`/`f` come from known lists
(`f` from the entity's field list), a visit op's `v` is an object with `v.id === op.id` and strings of at most
10 000 characters, and `t` is a safe integer at most 24 h ahead of now. `op.d` is overwritten with the sender's
relay device id. Invalid ops are dropped one by one and counted; they never block the rest of the bundle or later
bundles. Collections are read with own-property checks so odd ids cannot touch prototypes. A bundle that still
throws while being applied is skipped, counted, and kept (encrypted) in `sync-quarantine/` on Windows.
The inflated plaintext of a bundle or snapshot is capped at 64 MB.

**Write permissions:** the PC applies phone records only for `visit`, `del` of a visit,
`set client.notes`, `set prospect.status`, `set prospect.notes`. Anything else from a phone is ignored
and counted in the sync log. The phone applies everything from the PC.

### Conflict rules
- Per field (or per visit), **last writer wins** by clock `t`, tie broken by device id.
- Clock is a hybrid logical clock: `t = max(now_ms, last_seen_t + 1)`, so a device with a slow clock
  still orders its edits after what it has already seen.
- A visit logged on the phone for a client the PC deleted **restores the client** on the PC with a notice
  (no field-work is ever silently dropped). This happens only when the receiver still holds the delete tombstone
  for that client; the client is rebuilt from a fixed list of fields in the visit's `cl` snapshot (type-checked),
  and its id is always the visit's `c`, never taken from `cl`.
- A prospect converted to a client on the PC: the PC deletes the prospect; phone edits to it arrive late
  and are ignored, except notes, which are appended to the new client's notes with a notice.
- Marking a planned visit done on the phone reuses the existing `recordVisit` rule (moved to shared code).

## Relay protocol (server/)

Plain PHP 8, files only, one directory `data/` outside the web root when possible, else protected by
`.htaccess` (deny all). All requests are `POST index.php` with JSON, over HTTPS.

| action | auth | does |
|---|---|---|
| `hello` | none | returns `{ app: "client-clusters-relay", version, claimed }` (used by Test connection) |
| `claim` | setup code from `config.php` | first PC registers: stores hash of a new admin token and a random `epoch`; only once (409 afterwards, without looking at the code) |
| `addDevice` | admin token | stores hash of a new device token with a name; returns nothing secret |
| `listDevices` / `revokeDevice` | admin token | manage phones |
| `push` | device or admin token | stores an opaque bundle (≤ 2 MB), assigns `seq`, returns it |
| `pull` | device or admin token | returns bundles with `seq > since` (≤ 200 per call), the latest snapshot info, `oldest` and `last` (highest seq ever assigned) |
| `putSnapshot` / `getSnapshot` | admin to put, any to get | one encrypted full snapshot + the `seq` it covers |
| `compact {upTo}` | admin token | deletes bundles with `seq ≤ upTo`, only if the stored snapshot covers `upTo`; the PC calls it after each snapshot |
| `rekey` | admin token | deletes the snapshot and all bundles and revokes every device token (used by "Reset sync key") |

Every authenticated response carries `epoch` (random, created at claim). Clients treat anything other than HTTP 2xx
with a JSON body containing `ok: true` as an error, and the engine additionally requires `epoch` and `last` on pulls
and an integer `seq` on pushes (`bad-response` otherwise; the outbox is kept). A changed `epoch` stops sync with
`relay-reset`, a `last` lower than the local cursor stops it with `relay-rollback`.

- Tokens: 32 random bytes, sent in both `Authorization: Bearer` and `X-CC-Token` (some hosts drop the first);
  the relay stores only SHA-256 hashes and compares with `hash_equals`. `hello` and `claim` are sent without any
  token header. The token is checked before the request body is read.
- Limits: bundle size, total storage cap (default 50 MB), per-device stored-bytes quota (default 10 MB), failed-auth rate limit.
- Pruning: bundles older than 60 days and covered by the latest snapshot are deleted.
- File writes use `flock` + write-to-temp-then-rename.
- No user input ever reaches a file path; file names are generated from integers.

## Encryption and pairing
- One random 256-bit **sync key**, created on the PC when sync is set up.
- Every bundle and snapshot is `AES-256-GCM(key, random 96-bit IV, gzip(JSON))`. The additional data is a constant
  per kind (`cc-bundle-v2`, `cc-snapshot-v2`). Sender binding is different: the bundle's plaintext carries `from`,
  and the receiver rejects the bundle unless `from` equals the device id the relay attached to it, so a bundle
  cannot be replayed under another device.
- Windows stores the key and admin token with Electron `safeStorage`, like the Google key, in
  `sync.json`; excluded from `.ccbackup`.
- **Pairing a phone:** Windows → Settings → Sync → *Add a phone* creates a device token via `addDevice` and
  shows a QR code (and the same text as a copyable code) containing `{ url, token, key, deviceName }`.
  The phone scans it (camera) or the code is pasted. The phone stores it in app-private storage.
- **Revoking:** Windows calls `revokeDevice`; the phone gets 401 and shows "This phone was disconnected".
  A revoked phone still holds the key, so for a lost or stolen phone Windows offers **Reset sync key**
  right after disconnecting (and in the Sync section): new key, relay `rekey`, new snapshot; every phone re-pairs.
  The Windows pairing text never enters the window: only the QR picture does, and "Copy code" runs in the main
  process and clears the clipboard after 60 s if it was not replaced.

## Windows app (1.10.0)
- Settings → **Sync** section: server address, setup code, *Test connection*, *Turn on sync*,
  paired phones list with *Add a phone* (QR) and *Disconnect*, *Sync now*, last sync time, *Turn off*.
- Status chip in the top bar when sync is on: synced / syncing / offline / error (with message).
- Sync runs: at start, every 5 minutes while open, 5 s after a save, and on *Sync now*.
- After applying phone changes: one toast summarising (“3 visits and 1 note from your phone”).
- Uploads a new snapshot when >100 bundles since the last one, or daily.
- QR code generated locally (npm `qrcode`, no network).

## Android app (1.0.0)
- Screens: **Today** (today's planned visits in order, with open/closed status), **Map** (groups,
  clients, prospects; same tiles as Windows), **Client** (details, phone numbers tap-to-call,
  *Navigate* opens Google Maps / any maps app, notes, visit history, *Log a visit*, *Done* / *Didn't happen*
  on planned visits), **Prospects** (list by status, change status, notes), **Settings** (pair, sync status,
  appearance, unpair).
- Works fully offline; data in app storage (Capacitor Filesystem, write temp + rename);
  sync when online, on app open/resume, after an edit, and on pull-to-refresh.
- Plugins: `@capacitor/filesystem`, `@capacitor/app`, `@capacitor/barcode-scanner` for the QR,
  `CapacitorHttp` for relay calls. The key and token live in app-private storage next to the data
  (which is itself readable client data), with `android:allowBackup="false"`; a Keystore plugin would
  add a third-party dependency without protecting more than the data already beside it.
- Distributed as a signed APK attached to GitHub Releases; signing key kept outside the repo.

## Error handling
- Relay unreachable → stay offline, keep outbox, retry with backoff; status shows *Offline*.
- 401 → stop syncing, show *Disconnected* (phone) or *Server rejected the token* (PC).
- Decryption failure on a bundle → skip and count it; never blocks (the PC), and on a phone three in a row make it
  try the snapshot: only if that cannot be decrypted either is it reported as *Sync key mismatch — pair again*.
- Relay replaced, reset or restored from an older copy (`relay-reset` / `relay-rollback`) → sync stops with a message;
  on Windows "Reset sync key" starts again.
- Relay storage full → status error with the relay's message.
- Any merge exception → that bundle is skipped and kept in `sync-quarantine/` for diagnosis.
- **Windows saves before it commits:** incoming changes go to the window, which merges and saves, and only then
  acknowledges (`sync:applied`); the engine moves its cursor/copy forward after that (15 s timeout, then retried).
- **Delete circuit breaker (Windows):** one capture deleting more than 5 clients, 5 prospects or 20 visits is not
  queued; the window asks "Also remove … from your phones?" (*Remove from phones too* / *Keep them (restore here)*).
- **Rebase:** after recovery (any of its three exits) and after a Replace restore, what the phones still have
  and the window lost is brought back into the window instead of being deleted on the phones.
- Recovery mode (damaged data file) pauses sync like it pauses saving; unreadable data means sync does nothing.

## Testing
- `node --test`: shared diff/apply/LWW/clock/crypto round-trip, permissions filter, deleted-client restore,
  two simulated devices converging under random interleavings (property-style test).
- Relay: PHP tests driven from Node against `php -S` (when PHP is available), covering auth, claim-once,
  limits, pull paging, revocation.
- Windows: existing smoke/UI suites still pass; a new UI check for the Sync settings section with a
  fake relay.
- Android: shared tests cover logic; the phone UI is checked in a desktop browser with a fake bridge and,
  when the toolchain is present, `gradlew assembleDebug`.

## Out of scope (v1)
Multi-user relays, areas on the phone, planning on the phone, push notifications, iOS, automatic APK updates.

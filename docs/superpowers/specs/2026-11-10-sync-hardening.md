# Sync hardening — after security review (2026-11-10)

Companion to `2026-11-10-android-sync-design.md`. Three owners work in parallel:
**R** = relay (`server/**`, `test/relay.test.cjs`), **W** = shared + Windows (`src/**`, `test/**` except relay test),
**A** = Android (`android/**`). This file is the contract between them.

## Decisions (owner's defaults)
- A lost or stolen phone IS in the threat model.
- Restoring an older backup / recovery on the PC must NOT delete newer data that the phones or the
  sync copy still have: the PC merges it back instead of pushing deletions.
- Non-Apache hosts are allowed, so relay data must not be reachable by guessable URLs.

## Protocol changes (R implements, W and A consume)
1. Every authenticated response includes `epoch` (random 16-hex string created at claim, stored in state).
   `pull` also returns `last` (highest seq ever assigned). `claim` returns `epoch` too.
2. Token: clients send BOTH `Authorization: Bearer <t>` and `X-CC-Token: <t>`; relay accepts either
   (Authorization first). Drop the JSON-body `token` fallback.
3. Auth before body: for every action except `hello` and `claim`, the relay verifies the header token
   BEFORE reading the body. Anonymous reads are capped at 8 KB. The 20 MB cap applies only when the
   header token is the admin token (putSnapshot). `configured()` is checked first.
4. New admin action `compact {upTo}`: deletes every bundle with seq ≤ upTo, allowed only if the stored
   snapshot seq ≥ upTo. Returns `{ok, oldest, epoch}`.
5. New admin action `rekey`: deletes snapshot and all bundles and revokes all device tokens (admin token stays),
   resets nothing else. Used by "Reset sync key" on Windows before uploading a new snapshot.
6. Per-device byte quota (default 10 MB of stored bundles per device, config `DEVICE_QUOTA`) → 507.
7. Failed-auth limiter: look the token up first; count only failures; block only failures (a valid token
   is never refused by the IP limiter). Keep the IP limiter on `claim`.
8. Data folder default: `__DIR__ . '/data-' . substr(hash('sha256', SETUP_CODE . 'cc-data'), 0, 24)`,
   created 0700 under `umask(0077)`; `.htaccess` deny stays. Response to `hello` includes nothing about it.
9. `claim` after the relay is claimed → 409 without checking the setup code.
10. Remove CORS headers and the OPTIONS handler (no browser clients).
11. Rate-limit files: no file for check-only; cleanup on any request at most hourly; no dead code.

## Engine / shared changes (W)
- **Transport contract** (both apps): throw unless HTTP 2xx AND body parses AND `j.ok === true`.
  Engine checks `Number.isSafeInteger(r.seq)` after push and `Array.isArray(r.bundles)` after pull,
  else treats as error `bad-response` (outbox kept).
- **Epoch / rollback**: engine stores `epoch` on first success; mismatch → error `relay-reset`;
  `last < cursor` → error `relay-rollback`. Both pause sync with a clear message.
- **Op validation** (`SyncOps.validateOp(op, fromDeviceId)` used when opening a bundle): ids are strings
  matching `^[A-Za-z0-9_-]{1,64}$`; `e`, `k`, `f` from known lists (`f` in SyncModel.FIELDS for its entity);
  `visit` ops: `v` is an object, `v.id === op.id`, `c` valid id, string fields ≤ 10 000 chars;
  `t` is a safe integer ≤ now + 24 h; `op.d` is overwritten with the sender's relay device id.
  Invalid ops are dropped one by one and counted; a bundle that still throws during apply is skipped,
  counted, and its raw text written to quarantine via the store (`store.quarantine?(text)`).
- **No prototype pollution**: collections in projections/stamps use `Object.create(null)` or `Object.hasOwn`.
- **Restore from `cl`**: only when `stamps['client:'+c]` is a delete tombstone; fields from the fixed
  snapshot list with type checks; id never taken from `cl`.
- **Undecryptable bundles**: PC skips and counts them (never blocks); real key mismatch detected by failing to
  decrypt the snapshot. Phone: same, plus the snapshot check.
- **Gunzip cap**: inflated plaintext ≤ 64 MB, else bundle rejected.
- **Delete circuit breaker**: `capture` returns `{ops, deletes}`; if a single capture would delete more than
  5 clients or prospects, or more than 20 visits, the ops are NOT queued; the engine holds them as
  `pendingDeletes` and returns `needsConfirm: {clients, prospects, visits}`. Host confirms with
  `engine.confirmDeletes(true)` (queue them) or `false` (drop them and re-add the deleted entities from the shadow
  via `applyWin`-style ops back to the host so the data is restored).
- **Rebase after recovery / Replace restore / start empty**: host calls `engine.rebase(proj)` instead of
  `capture`: entities present in the shadow but missing from `proj` are returned as ops to re-add to the host
  data (never pushed as deletes); then the shadow is set to the merged result.
- **Ack before commit (Windows)**: `applyWin` resolves only after the renderer acknowledges that the merged
  data was saved (`sync:applied` IPC carrying a request id, sent after `data:save` resolves); 15 s timeout → reject
  (engine retries later).
- **Re-key**: Windows "Reset sync key" (shown as the follow-up of disconnecting a phone and in the Sync section):
  new key → relay `rekey` → `initPc` (new snapshot) → all phones must re-pair. Disconnect dialog text must say:
  "The phone can no longer sync. If it was lost or stolen, also reset the sync key so it can't read future data."
- **Pairing code**: never shown in the renderer DOM longer than needed; clipboard copy cleared after 60 s if
  unchanged; fix the comment in `src/renderer/sync.js` that claims the key never reaches the renderer.
- **Windows HTTP**: `net.fetch(..., { redirect: 'error' })`; URLs validated with `new URL` (https, or http with
  hostname exactly `localhost`/`127.0.0.1`), same in `SyncCrypto.decodePairing`.
- **Null data**: `currentData()` returning null aborts capture/sync; never `|| {}`.
- **Data-folder exposure check**: after enable, Windows GETs `<base>/data/` and `<base>` + nothing else is
  guessable; if a GET of `<base>/index.php` with method GET returns 405 JSON as expected, fine. (The real data
  folder name is unguessable, so this is informational only — skip if it adds complexity.)
- Fix the design doc: AAD is constant; sender binding is via `from` inside the ciphertext checked against the
  relay's device id.

## Android changes (A)
- Transport contract as above; send both token headers.
- Handle new engine errors (`relay-reset`, `relay-rollback`, `bad-response`) with messages.
- 401: show "This phone was disconnected" but KEEP local data and unsent changes; offer "Pair again" (scan/paste)
  which keeps the outbox and pushes it after re-pairing if the new code's `pcDeviceId` matches, and
  "Remove data from this phone" separately.
- `dataExtractionRules` + `fullBackupContent` excluding everything (Android 12+ device transfer).
- Bootstrap race: no capture runs while a sync is in progress; edits during sync are queued and captured after.
- Phone circuit breaker is not needed (the phone can't delete entities except visits; the PC rejects others).

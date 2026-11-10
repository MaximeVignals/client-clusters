# Client Clusters sync relay

A very small PHP program that lets your Windows app and your Android phone exchange changes.
You host it yourself, on any cheap web hosting. It only ever stores **encrypted** data: the
encryption key lives on your PC and your phones and is never sent to the relay, so the relay
(and anyone who gets into it) cannot read your clients, visits or notes.

## Set it up

1. **Get PHP 8 hosting with HTTPS.** Any shared host works (OVH, for example). You need PHP 8.0 or
   newer and a web address that starts with `https://`. No database is needed.
2. **Create your config.** Copy `config.sample.php` to `config.php` and set `SETUP_CODE` to a long
   secret of your own (at least 16 characters; 30 or more is better). Keep it private. Until it is
   set, the relay answers "Relay not configured".
3. **Upload the `server` folder by FTP**, for example to `/cc-sync/` on your site. Upload
   `index.php`, `.htaccess` and `config.php`. The relay creates its data folder by itself (see "The data folder" below) on first use.
4. **Connect the Windows app.** Open Settings, then Sync. Enter
   `https://your-site/cc-sync/index.php` and your setup code, press **Test connection**, then
   **Turn on sync**.
5. **Add a phone.** In Settings, then Sync, press **Add a phone**. Scan the QR code with the
   Client Clusters Android app (or paste the code shown below it).

## Good to know

- **Encrypted end to end.** Bundles are encrypted with AES-256-GCM before they leave your PC or phone.
  The relay stores opaque text and never has the key.
- **Tokens.** The relay keeps only hashes of access tokens. Disconnecting a phone in the Windows
  app makes its token stop working immediately.
- **Limits.** One bundle is at most 2 MB, one snapshot at most 20 MB (`MAX_SNAPSHOT`, accepted only
  from the Windows app's admin token), total storage 50 MB (`MAX_TOTAL`), 10 MB of stored bundles per
  device (`DEVICE_QUOTA`; beyond it that device gets HTTP 507), 120 requests per minute per device.
  Requests without a token are capped at 8 KB. Old bundles are cleaned up after 60 days once a full
  snapshot covers them (the Windows app can also compact them). All limits can be changed in `config.php`.
- **`post_max_size`.** PHP's own `post_max_size` (many hosts default to 8 MB) must be larger than
  `MAX_SNAPSHOT` (plus a little), or big snapshots are refused by PHP before the relay sees them.
  Raise it in `php.ini` or `.user.ini`.
- **Failed logins.** After `FAIL_LIMIT` (30) wrong tokens or setup codes in 10 minutes an IP address is
  blocked. A valid token is never blocked by this.
- **No browser access.** The relay sends no CORS headers; only the apps talk to it.
- **One relay, one person.** The first Windows app to enter the setup code owns the relay; once it is
  claimed, any further claim is refused whatever the code. To start over, delete the data folder on the server.
- **The data folder.** It is named `data-` followed by 24 characters derived from your `SETUP_CODE`
  (for example `data-3fa9...`), so its address is not guessable even on hosts that ignore `.htaccess`.
  It is created with owner-only permissions. `.htaccess` (Apache) blocks the web from reading anything
  except `index.php`, and the folder has its own "deny all" file. If your host does not use Apache,
  also block access to `data-*` and `config.php` in your server settings, or set `DATA_DIR` in
  `config.php` to a folder outside the web root. Even if exposed, it holds only encrypted bundles and
  token hashes. Changing `SETUP_CODE` after claiming changes this folder name, so the relay would start empty.
- **Some hosts hide the Authorization header** from PHP. The `.htaccess` file works around this, and
  the apps also send the same token in an `X-CC-Token` header, which the relay accepts instead. The
  relay checks the token before it reads the request body. A token in the JSON body is no longer accepted.

## For developers

`npm test` includes `test/relay.test.cjs`, which starts `php -S` against a temporary data folder. It
is skipped when no `php` is found on PATH; set `PHP_BIN` to a php executable to override. The built-in
PHP server ignores `.htaccess`, so the Apache protection itself is not covered by those tests.

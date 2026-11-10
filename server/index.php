<?php
/**
 * Client Clusters sync relay.
 *
 * A tiny file-based relay that stores opaque, end-to-end encrypted bundles.
 * It never sees readable data. Plain PHP 8, no database, no dependencies.
 *
 * Every request is `POST index.php` with a JSON body { "action": "...", ... }
 * and (except hello/claim) a token sent as `Authorization: Bearer <token>` and/or `X-CC-Token: <token>`.
 * The token is checked BEFORE the body is read. See README.md for setup.
 */

declare(strict_types=1);

// Never leak PHP warnings/notices to the client.
ini_set('display_errors', '0');
ini_set('html_errors', '0');
error_reporting(E_ALL);

const RELAY_VERSION = '1.1.0';
const BODY_OVERHEAD = 4096;          // JSON wrapper allowed on top of MAX_BUNDLE
const ANON_MAX_BODY = 8192;          // cap for requests without a token (hello, claim)
const PULL_PAGE = 200;               // max bundles per pull
const PULL_MAX_BYTES = 8 * 1024 * 1024; // soft cap on one pull response
const MAX_DEVICES = 20;

$EPOCH = null; // set once a caller is authenticated; echoed in every response after that

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

function send_headers(): void
{
    if (headers_sent()) {
        return;
    }
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    // No CORS headers on purpose: the clients are apps, not browser pages.
}

function respond(int $code, array $body)
{
    global $EPOCH;
    if (is_string($EPOCH) && $EPOCH !== '' && !isset($body['epoch'])) {
        $body['epoch'] = $EPOCH;
    }
    http_response_code($code);
    send_headers();
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(int $code, string $message)
{
    respond($code, ['ok' => false, 'error' => $message]);
}

set_exception_handler(function (Throwable $e): void {
    error_log('cc-relay: ' . $e->getMessage());
    if (!headers_sent()) {
        fail(500, 'Server error');
    }
});
set_error_handler(function (int $no, string $str): bool {
    if (!(error_reporting() & $no)) {
        return false; // @-suppressed call
    }
    // Turn warnings into exceptions so nothing half-works silently.
    throw new ErrorException($str, 0, $no);
});
register_shutdown_function(function (): void {
    $e = error_get_last();
    if ($e !== null && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        if (!headers_sent()) {
            http_response_code(500);
            send_headers();
            echo '{"ok":false,"error":"Server error"}';
        }
    }
});

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function load_config(): array
{
    $cfg = [
        'SETUP_CODE'    => '',
        'DATA_DIR'      => '',      // empty = derived from SETUP_CODE (see below)
        'MAX_BUNDLE'    => 2 * 1024 * 1024,
        'MAX_SNAPSHOT'  => 20 * 1024 * 1024, // putSnapshot only, admin token only
        'MAX_TOTAL'     => 50 * 1024 * 1024,
        'DEVICE_QUOTA'  => 10 * 1024 * 1024, // stored bundle bytes per device
        'RATE_LIMIT'    => 120,     // authenticated requests per minute per token
        'FAIL_LIMIT'    => 30,      // failed auth attempts per 10 minutes per IP
        'PRUNE_DAYS'    => 60,
        'PRUNE_EVERY'   => 3600,    // seconds between opportunistic prune runs
    ];
    $file = null;
    $env = getenv('CC_RELAY_CONFIG');
    // The env override is honoured ONLY under the PHP built-in server (tests).
    if (PHP_SAPI === 'cli-server' && is_string($env) && $env !== '') {
        $file = $env;
    } elseif (is_file(__DIR__ . '/config.php')) {
        $file = __DIR__ . '/config.php';
    }
    if ($file !== null) {
        $user = (static function (string $f) {
            return require $f;
        })($file);
        if (is_array($user)) {
            foreach ($cfg as $k => $_) {
                if (array_key_exists($k, $user)) {
                    $cfg[$k] = $user[$k];
                }
            }
        }
    }
    $cfg['MAX_BUNDLE'] = max(1024, (int)$cfg['MAX_BUNDLE']);
    $cfg['MAX_SNAPSHOT'] = max(1024, (int)$cfg['MAX_SNAPSHOT']);
    $cfg['MAX_TOTAL'] = max(1024, (int)$cfg['MAX_TOTAL']);
    $cfg['DEVICE_QUOTA'] = max(1024, (int)$cfg['DEVICE_QUOTA']);
    $cfg['RATE_LIMIT'] = max(1, (int)$cfg['RATE_LIMIT']);
    $cfg['FAIL_LIMIT'] = max(1, (int)$cfg['FAIL_LIMIT']);
    $cfg['PRUNE_DAYS'] = max(0, (float)$cfg['PRUNE_DAYS']);
    $cfg['PRUNE_EVERY'] = max(0, (int)$cfg['PRUNE_EVERY']);
    $cfg['DATA_DIR'] = rtrim((string)$cfg['DATA_DIR'], '/\\');
    if ($cfg['DATA_DIR'] === '' && is_string($cfg['SETUP_CODE']) && $cfg['SETUP_CODE'] !== '') {
        // Not guessable by URL, which matters on hosts that ignore .htaccess.
        $cfg['DATA_DIR'] = __DIR__ . '/data-' . substr(hash('sha256', $cfg['SETUP_CODE'] . 'cc-data'), 0, 24);
    }
    return $cfg;
}

function cfg(string $key)
{
    global $CFG;
    return $CFG[$key];
}

function configured(): bool
{
    $code = cfg('SETUP_CODE');
    return is_string($code) && strlen($code) >= 16 && cfg('DATA_DIR') !== '';
}

/* ------------------------------------------------------------------ */
/* Storage helpers (file names are only ever built from integers/hex)  */
/* ------------------------------------------------------------------ */

function data_path(string $rel): string
{
    return cfg('DATA_DIR') . '/' . $rel;
}

function ensure_data_dir(): void
{
    $root = cfg('DATA_DIR');
    umask(0077);
    foreach ([$root, "$root/b", "$root/rl"] as $dir) {
        if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new RuntimeException('Cannot create data directory');
        }
    }
    $guard = "# Client Clusters relay data: never serve directly.\n"
        . "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n"
        . "<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n";
    if (!is_file("$root/.htaccess")) {
        write_atomic("$root/.htaccess", $guard);
    }
    foreach ([$root, "$root/b", "$root/rl"] as $dir) {
        if (!is_file("$dir/index.html")) {
            write_atomic("$dir/index.html", '');
        }
    }
}

/** Write to a temp file in the same directory, then rename over the target. */
function write_atomic(string $path, string $data): void
{
    $tmp = dirname($path) . '/.tmp-' . bin2hex(random_bytes(6));
    if (file_put_contents($tmp, $data, LOCK_EX) === false) {
        @unlink($tmp);
        throw new RuntimeException('Write failed');
    }
    if (!rename($tmp, $path)) {
        @unlink($tmp);
        throw new RuntimeException('Rename failed');
    }
}

/** Run $fn while holding the global exclusive lock (state, counter, snapshot, bundles). */
function with_lock(callable $fn)
{
    $fh = fopen(data_path('lock'), 'c');
    if ($fh === false || !flock($fh, LOCK_EX)) {
        throw new RuntimeException('Cannot lock');
    }
    try {
        return $fn();
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
    }
}

function read_json_file(string $path, $default)
{
    if (!is_file($path)) {
        return $default;
    }
    $raw = file_get_contents($path);
    if ($raw === false || $raw === '') {
        return $default;
    }
    $v = json_decode($raw, true);
    return is_array($v) ? $v : $default;
}

function load_state(): array
{
    $s = read_json_file(data_path('state.json'), []);
    if (!isset($s['devices']) || !is_array($s['devices'])) {
        $s['devices'] = [];
    }
    if (!array_key_exists('admin', $s)) {
        $s['admin'] = null;
    }
    return $s;
}

function save_state(array $s): void
{
    write_atomic(data_path('state.json'), json_encode($s));
}

function last_seq(): int
{
    $p = data_path('seq.txt');
    if (!is_file($p)) {
        return 0;
    }
    $n = trim((string)file_get_contents($p));
    return ctype_digit($n) ? (int)$n : 0;
}

/** @return int[] sorted ascending list of stored bundle sequence numbers */
function list_bundle_seqs(): array
{
    $out = [];
    $dh = opendir(data_path('b'));
    if ($dh === false) {
        return $out;
    }
    while (($f = readdir($dh)) !== false) {
        if (preg_match('/^([1-9][0-9]{0,14})\.json$/', $f, $m)) {
            $out[] = (int)$m[1];
        }
    }
    closedir($dh);
    sort($out, SORT_NUMERIC);
    return $out;
}

function bundle_path(int $seq): string
{
    return data_path('b/' . $seq . '.json');
}

function total_bytes(): int
{
    $total = 0;
    foreach (list_bundle_seqs() as $seq) {
        $total += (int)@filesize(bundle_path($seq));
    }
    $total += (int)@filesize(data_path('snapshot.json'));
    return $total;
}

/**
 * Bytes of stored bundles pushed by one device. A record starts with {"seq":N,"device":"ID",...}
 * so only the first bytes of each file are read.
 */
function device_bytes(string $deviceId): int
{
    $total = 0;
    foreach (list_bundle_seqs() as $seq) {
        $p = bundle_path($seq);
        $fh = @fopen($p, 'rb');
        if ($fh === false) {
            continue;
        }
        $head = (string)fread($fh, 160);
        fclose($fh);
        if (preg_match('/^\{"seq":\d+,"device":"([^"]*)"/', $head, $m) && $m[1] === $deviceId) {
            $total += (int)@filesize($p);
        }
    }
    return $total;
}

/* ------------------------------------------------------------------ */
/* Rate limiting (file based)                                          */
/* ------------------------------------------------------------------ */

/**
 * Fixed-window counter. With $inc the call counts as one hit and returns false once the limit is
 * exceeded; without it, it only reports whether more hits are allowed (and never creates a file).
 */
function rate_check(string $key, int $limit, int $window, bool $inc): bool
{
    $path = data_path('rl/' . substr(hash('sha256', $key), 0, 32) . '.json');
    if (!$inc && !is_file($path)) {
        return true;
    }
    $fh = fopen($path, 'c+');
    if ($fh === false) {
        return true; // fail open rather than lock everyone out
    }
    try {
        flock($fh, LOCK_EX);
        $raw = stream_get_contents($fh);
        $d = $raw ? json_decode($raw, true) : null;
        $now = time();
        if (!is_array($d) || !isset($d['w'], $d['c']) || $now - (int)$d['w'] >= $window) {
            $d = ['w' => $now, 'c' => 0];
        }
        if ($inc) {
            $d['c'] = (int)$d['c'] + 1;
            ftruncate($fh, 0);
            rewind($fh);
            fwrite($fh, json_encode($d));
            fflush($fh);
        }
        return $inc ? $d['c'] <= $limit : $d['c'] < $limit;
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
    }
}

/** Delete expired rate-limit counters. Runs on any request, at most once an hour. */
function cleanup_rate_files(): void
{
    $marker = data_path('rl.stamp');
    $now = time();
    if (is_file($marker) && $now - (int)filemtime($marker) < 3600) {
        return;
    }
    @touch($marker);
    $dh = @opendir(data_path('rl'));
    if ($dh === false) {
        return;
    }
    while (($f = readdir($dh)) !== false) {
        $p = data_path('rl/' . $f);
        if (preg_match('/^[a-f0-9]{32}\.json$/', $f) && is_file($p) && $now - (int)@filemtime($p) > 3600) {
            @unlink($p);
        }
    }
    closedir($dh);
}

function client_ip(): string
{
    return (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

/* ------------------------------------------------------------------ */
/* Authentication                                                      */
/* ------------------------------------------------------------------ */

function new_token(): string
{
    return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
}

function token_hash(string $token): string
{
    return hash('sha256', $token);
}

/**
 * Token from `Authorization: Bearer` (first) or `X-CC-Token`. Returns null when no token was sent.
 * A malformed Authorization header with no X-CC-Token yields an unusable string so it counts as a failed login.
 */
function header_token(): ?string
{
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if ($h === '' && function_exists('getallheaders')) {
        foreach (getallheaders() as $k => $v) {
            if (strcasecmp((string)$k, 'Authorization') === 0) {
                $h = (string)$v;
            }
        }
    }
    if (is_string($h) && preg_match('/^Bearer\s+(\S+)$/i', trim($h), $m)) {
        return $m[1];
    }
    $x = $_SERVER['HTTP_X_CC_TOKEN'] ?? '';
    if (is_string($x) && trim($x) !== '') {
        return trim($x);
    }
    return is_string($h) && trim($h) !== '' ? '-' : null;
}

/** A failed authentication: the only thing the per-IP limiter ever counts and blocks. */
function auth_failure()
{
    $ip = client_ip();
    if (!rate_check('fail:' . $ip, (int)cfg('FAIL_LIMIT'), 600, false)) {
        fail(429, 'Too many failed attempts, try again later');
    }
    rate_check('fail:' . $ip, (int)cfg('FAIL_LIMIT'), 600, true);
    fail(401, 'Invalid or revoked token');
}

/**
 * Identify the caller from the header token. Returns ['id' => deviceId, 'admin' => bool, 'name' => string, 'hash' => hash].
 * The token is looked up first; a valid token is never refused by the IP limiter.
 * Responds 401 / 429 itself on failure.
 */
function authenticate(string $token): array
{
    global $EPOCH;
    $caller = null;
    $state = load_state();
    if (preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) {
        $h = token_hash($token);
        // Check every record without early exit so timing does not reveal which matched.
        if (is_array($state['admin']) && isset($state['admin']['hash'])
            && hash_equals((string)$state['admin']['hash'], $h)) {
            $caller = ['id' => (string)$state['admin']['id'], 'admin' => true, 'name' => 'Windows app', 'hash' => $h];
        }
        foreach ($state['devices'] as $id => $dev) {
            if (isset($dev['hash']) && hash_equals((string)$dev['hash'], $h)) {
                $caller = ['id' => (string)$id, 'admin' => false, 'name' => (string)($dev['name'] ?? ''), 'hash' => $h];
            }
        }
    }
    if ($caller === null) {
        auth_failure();
    }
    if (!rate_check('tok:' . $caller['hash'], (int)cfg('RATE_LIMIT'), 60, true)) {
        fail(429, 'Rate limit exceeded');
    }
    if (!isset($state['epoch']) || !is_string($state['epoch']) || $state['epoch'] === '') {
        // Relay claimed before epochs existed: create and persist one (under the lock, re-checked).
        $state['epoch'] = with_lock(function (): string {
            $s = load_state();
            if (!isset($s['epoch']) || !is_string($s['epoch']) || $s['epoch'] === '') {
                $s['epoch'] = bin2hex(random_bytes(8));
                save_state($s);
            }
            return $s['epoch'];
        });
    }
    $EPOCH = $state['epoch'];
    touch_last_seen($caller, $state);
    return $caller;
}

function touch_last_seen(array $caller, array $state): void
{
    $now = time();
    $rec = $caller['admin'] ? ($state['admin'] ?? null) : ($state['devices'][$caller['id']] ?? null);
    if (!is_array($rec) || $now - (int)($rec['lastSeen'] ?? 0) < 60) {
        return;
    }
    with_lock(function () use ($caller, $now): void {
        $s = load_state();
        if ($caller['admin']) {
            if (is_array($s['admin'])) {
                $s['admin']['lastSeen'] = $now;
            }
        } elseif (isset($s['devices'][$caller['id']])) {
            $s['devices'][$caller['id']]['lastSeen'] = $now;
        }
        save_state($s);
    });
}

function require_admin(array $caller): void
{
    if (!$caller['admin']) {
        fail(403, 'Admin token required');
    }
}

/* ------------------------------------------------------------------ */
/* Pruning                                                             */
/* ------------------------------------------------------------------ */

/** Delete bundles older than PRUNE_DAYS that the latest snapshot already covers. Caller holds the lock. */
function prune(bool $force = false): void
{
    $marker = data_path('prune.stamp');
    $now = time();
    if (!$force && is_file($marker) && $now - (int)filemtime($marker) < (int)cfg('PRUNE_EVERY')) {
        return;
    }
    @touch($marker);
    $snap = read_json_file(data_path('snapshot.json'), null);
    if (is_array($snap) && isset($snap['seq']) && is_int($snap['seq'])) {
        $cut = (int)round((float)cfg('PRUNE_DAYS') * 86400);
        foreach (list_bundle_seqs() as $seq) {
            if ($seq > $snap['seq']) {
                break;
            }
            $p = bundle_path($seq);
            $mt = @filemtime($p);
            if ($mt !== false && $now - $mt > $cut) {
                @unlink($p);
            }
        }
    }
    // Housekeeping: stale temp files.
    foreach (['.', 'b'] as $sub) {
        $dh = @opendir(data_path($sub));
        if ($dh === false) {
            continue;
        }
        while (($f = readdir($dh)) !== false) {
            $p = data_path($sub . '/' . $f);
            if (str_starts_with($f, '.tmp-') && is_file($p) && $now - (int)@filemtime($p) > 3600) {
                @unlink($p);
            }
        }
        closedir($dh);
    }
}

/* ------------------------------------------------------------------ */
/* Request parsing                                                     */
/* ------------------------------------------------------------------ */

/** Method and content type only; the body is not touched. */
function check_request_headers(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        header('Allow: POST');
        fail(405, 'Use POST');
    }
    $ctype = strtolower((string)($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? ''));
    if (!preg_match('#^application/json\s*(;|$)#', $ctype)) {
        fail(415, 'Content-Type must be application/json');
    }
}

/**
 * Read and parse the JSON body. $cap is the largest body accepted at all; $small is the largest
 * accepted unless the action is putSnapshot (only meaningful when $cap > $small).
 */
function read_body(int $cap, int $small): array
{
    $len = $_SERVER['CONTENT_LENGTH'] ?? null;
    if (is_string($len) && ctype_digit($len) && (int)$len > $cap) {
        fail(413, 'Request too large');
    }
    // Read at most cap+1 bytes so an oversized body is detected without loading it all.
    $raw = file_get_contents('php://input', false, null, 0, $cap + 1);
    if ($raw === false || strlen($raw) > $cap) {
        fail(413, 'Request too large');
    }
    if (strlen($raw) > $small && !preg_match('/"action"\s*:\s*"putSnapshot"/', substr($raw, 0, 512))) {
        fail(413, 'Request too large');
    }
    try {
        $body = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        fail(400, 'Invalid JSON');
    }
    if (!is_array($body) || ($body && array_keys($body) === range(0, count($body) - 1))) {
        fail(400, 'JSON object expected');
    }
    if (strlen($raw) > $small && ($body['action'] ?? null) !== 'putSnapshot') {
        fail(413, 'Request too large');
    }
    return $body;
}

/** Parse a non-negative integer given as int or digit string; anything else is rejected. */
function nonneg_int($v): ?int
{
    if (is_int($v)) {
        return $v >= 0 ? $v : null;
    }
    if (is_string($v) && preg_match('/^(0|[1-9][0-9]{0,14})$/', $v)) {
        return (int)$v;
    }
    return null;
}

function bundle_string(array $body, ?int $max = null): string
{
    if (!isset($body['bundle']) || !is_string($body['bundle']) || $body['bundle'] === '') {
        fail(400, 'bundle must be a non-empty string');
    }
    if (strlen($body['bundle']) > ($max ?? (int)cfg('MAX_BUNDLE'))) {
        fail(413, 'Bundle too large');
    }
    return $body['bundle'];
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function act_hello()
{
    $state = is_dir(cfg('DATA_DIR')) ? load_state() : ['admin' => null];
    respond(200, [
        'ok' => true,
        'app' => 'client-clusters-relay',
        'version' => RELAY_VERSION,
        'claimed' => is_array($state['admin']),
    ]);
}

function act_claim(array $body)
{
    $ip = client_ip();
    if (!rate_check('fail:' . $ip, (int)cfg('FAIL_LIMIT'), 600, false)) {
        fail(429, 'Too many failed attempts, try again later');
    }
    // Already claimed: refuse without looking at the setup code.
    if (is_array(load_state()['admin'])) {
        fail(409, 'This relay is already claimed');
    }
    $given = $body['setupCode'] ?? null;
    if (!is_string($given) || !hash_equals(hash('sha256', (string)cfg('SETUP_CODE')), hash('sha256', $given))) {
        rate_check('fail:' . $ip, (int)cfg('FAIL_LIMIT'), 600, true);
        fail(403, 'Wrong setup code');
    }
    $token = new_token();
    $deviceId = bin2hex(random_bytes(16));
    $epoch = bin2hex(random_bytes(8));
    $claimed = with_lock(function () use ($token, $deviceId, $epoch): bool {
        $s = load_state();
        if (is_array($s['admin'])) {
            return false;
        }
        $s['admin'] = ['id' => $deviceId, 'hash' => token_hash($token), 'createdAt' => time(), 'lastSeen' => 0];
        $s['epoch'] = $epoch;
        save_state($s);
        return true;
    });
    if (!$claimed) {
        fail(409, 'This relay is already claimed');
    }
    respond(200, ['ok' => true, 'adminToken' => $token, 'deviceId' => $deviceId, 'epoch' => $epoch]);
}

function act_whoami(array $caller)
{
    respond(200, ['ok' => true, 'deviceId' => $caller['id'], 'admin' => $caller['admin']]);
}

function act_addDevice(array $caller, array $body)
{
    require_admin($caller);
    $name = $body['name'] ?? '';
    if (!is_string($name)) {
        fail(400, 'name must be a string');
    }
    $name = trim(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $name) ?? '');
    if ($name === '' || strlen($name) > 120) {
        fail(400, 'name must be 1 to 60 characters (valid UTF-8)');
    }
    $token = new_token();
    $id = bin2hex(random_bytes(16));
    $ok = with_lock(function () use ($id, $name, $token): bool {
        $s = load_state();
        if (count($s['devices']) >= MAX_DEVICES) {
            return false;
        }
        $s['devices'][$id] = ['name' => $name, 'hash' => token_hash($token), 'addedAt' => time(), 'lastSeen' => 0];
        save_state($s);
        return true;
    });
    if (!$ok) {
        fail(409, 'Too many devices, disconnect one first');
    }
    respond(200, ['ok' => true, 'deviceId' => $id, 'token' => $token]);
}

function act_listDevices(array $caller)
{
    require_admin($caller);
    $out = [];
    foreach (load_state()['devices'] as $id => $d) {
        $out[] = [
            'deviceId' => (string)$id,
            'name' => (string)($d['name'] ?? ''),
            'addedAt' => (int)($d['addedAt'] ?? 0),
            'lastSeen' => (int)($d['lastSeen'] ?? 0),
        ];
    }
    respond(200, ['ok' => true, 'devices' => $out]);
}

function act_revokeDevice(array $caller, array $body)
{
    require_admin($caller);
    $id = $body['deviceId'] ?? null;
    if (!is_string($id) || !preg_match('/^[a-f0-9]{32}$/', $id)) {
        fail(400, 'Invalid deviceId');
    }
    $found = with_lock(function () use ($id): bool {
        $s = load_state();
        if (!isset($s['devices'][$id])) {
            return false;
        }
        unset($s['devices'][$id]);
        save_state($s);
        return true;
    });
    if (!$found) {
        fail(400, 'Unknown device');
    }
    respond(200, ['ok' => true]);
}

function act_push(array $caller, array $body)
{
    $bundle = bundle_string($body);
    $result = with_lock(function () use ($caller, $bundle) {
        $need = strlen($bundle) + 256;
        if (total_bytes() + $need > (int)cfg('MAX_TOTAL')) {
            return null;
        }
        if (device_bytes($caller['id']) + $need > (int)cfg('DEVICE_QUOTA')) {
            return null;
        }
        $seq = last_seq() + 1;
        $record = json_encode(['seq' => $seq, 'device' => $caller['id'], 'bundle' => $bundle]);
        write_atomic(bundle_path($seq), $record);
        write_atomic(data_path('seq.txt'), (string)$seq);
        prune();
        return $seq;
    });
    if ($result === null) {
        fail(507, 'Relay storage is full');
    }
    respond(200, ['ok' => true, 'seq' => $result]);
}

function act_pull(array $body)
{
    $since = array_key_exists('since', $body) ? nonneg_int($body['since']) : 0;
    if ($since === null) {
        fail(400, 'since must be a non-negative integer');
    }
    $last = last_seq(); // read first: anything above it may be a half-finished push
    $seqs = array_values(array_filter(list_bundle_seqs(), fn(int $s): bool => $s <= $last));
    $oldest = $seqs ? $seqs[0] : $last + 1;
    $bundles = [];
    $bytes = 0;
    $more = false;
    foreach ($seqs as $seq) {
        if ($seq <= $since) {
            continue;
        }
        if (count($bundles) >= PULL_PAGE) {
            $more = true;
            break;
        }
        $rec = read_json_file(bundle_path($seq), null);
        if (!is_array($rec) || !isset($rec['bundle'], $rec['device'])) {
            continue; // pruned or damaged between listing and reading
        }
        $size = strlen((string)$rec['bundle']);
        if ($bundles && $bytes + $size > PULL_MAX_BYTES) {
            $more = true;
            break;
        }
        $bytes += $size;
        $bundles[] = ['seq' => $seq, 'device' => (string)$rec['device'], 'bundle' => (string)$rec['bundle']];
    }
    $snap = read_json_file(data_path('snapshot.json'), null);
    respond(200, [
        'ok' => true,
        'bundles' => $bundles,
        'more' => $more,
        'snapshot' => is_array($snap) && isset($snap['seq']) ? ['seq' => (int)$snap['seq']] : null,
        'oldest' => $oldest,
        'last' => $last,
    ]);
}

function act_putSnapshot(array $caller, array $body)
{
    require_admin($caller);
    $seq = nonneg_int($body['seq'] ?? null);
    if ($seq === null) {
        fail(400, 'seq must be a non-negative integer');
    }
    $bundle = bundle_string($body, (int)cfg('MAX_SNAPSHOT'));
    $res = with_lock(function () use ($seq, $bundle): int {
        if ($seq > last_seq()) {
            return 400;
        }
        $old = (int)@filesize(data_path('snapshot.json'));
        $record = json_encode(['seq' => $seq, 'bundle' => $bundle]);
        if (total_bytes() - $old + strlen($record) > (int)cfg('MAX_TOTAL')) {
            return 507;
        }
        write_atomic(data_path('snapshot.json'), $record);
        prune(true);
        return 200;
    });
    if ($res === 400) {
        fail(400, 'seq is beyond the latest bundle');
    }
    if ($res === 507) {
        fail(507, 'Relay storage is full');
    }
    respond(200, ['ok' => true]);
}

function act_getSnapshot()
{
    $snap = read_json_file(data_path('snapshot.json'), null);
    if (!is_array($snap) || !isset($snap['seq'], $snap['bundle'])) {
        respond(200, ['ok' => true, 'seq' => null, 'bundle' => null]);
    }
    respond(200, ['ok' => true, 'seq' => (int)$snap['seq'], 'bundle' => (string)$snap['bundle']]);
}

/** Admin: delete every bundle with seq <= upTo, only when the stored snapshot already covers upTo. */
function act_compact(array $caller, array $body)
{
    require_admin($caller);
    $upTo = nonneg_int($body['upTo'] ?? null);
    if ($upTo === null) {
        fail(400, 'upTo must be a non-negative integer');
    }
    $oldest = with_lock(function () use ($upTo): ?int {
        $snap = read_json_file(data_path('snapshot.json'), null);
        if (!is_array($snap) || !isset($snap['seq']) || (int)$snap['seq'] < $upTo) {
            return null;
        }
        foreach (list_bundle_seqs() as $seq) {
            if ($seq <= $upTo) {
                @unlink(bundle_path($seq));
            }
        }
        $left = list_bundle_seqs();
        return $left ? $left[0] : last_seq() + 1;
    });
    if ($oldest === null) {
        fail(409, 'The stored snapshot does not cover upTo');
    }
    respond(200, ['ok' => true, 'oldest' => $oldest]);
}

/** Admin: delete the snapshot and every bundle and revoke all device tokens. Admin token, epoch and counter stay. */
function act_rekey(array $caller)
{
    require_admin($caller);
    with_lock(function (): void {
        @unlink(data_path('snapshot.json'));
        foreach (list_bundle_seqs() as $seq) {
            @unlink(bundle_path($seq));
        }
        $s = load_state();
        $s['devices'] = [];
        save_state($s);
    });
    respond(200, ['ok' => true]);
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

$CFG = load_config();
check_request_headers();

$token = header_token();
$caller = null;
if ($token !== null) {
    // Auth before body: a token holder gets the normal caps, a failed login never has its body read.
    if (!configured()) {
        fail(500, 'Relay not configured');
    }
    ensure_data_dir();
    cleanup_rate_files();
    $caller = authenticate($token);
    $small = (int)cfg('MAX_BUNDLE') + BODY_OVERHEAD;
    $cap = $caller['admin'] ? max($small, (int)cfg('MAX_SNAPSHOT') + BODY_OVERHEAD) : $small;
    $body = read_body($cap, $small);
} else {
    $body = read_body(ANON_MAX_BODY, ANON_MAX_BODY);
}

$action = $body['action'] ?? null;
if (!is_string($action) || !preg_match('/^[A-Za-z]{1,32}$/', $action)) {
    fail(400, 'Missing action');
}

if ($action === 'hello') {
    act_hello();
}

$known = ['claim', 'addDevice', 'listDevices', 'revokeDevice', 'push', 'pull', 'putSnapshot', 'getSnapshot', 'whoami', 'compact', 'rekey'];
if (!in_array($action, $known, true)) {
    fail(400, 'Unknown action');
}
if (!configured()) {
    fail(500, 'Relay not configured');
}
ensure_data_dir();
cleanup_rate_files();

if ($action === 'claim') {
    act_claim($body);
}
if ($caller === null) {
    auth_failure(); // anonymous call to an action that needs a token
}

switch ($action) {
    case 'whoami':        act_whoami($caller);
    case 'addDevice':     act_addDevice($caller, $body);
    case 'listDevices':   act_listDevices($caller);
    case 'revokeDevice':  act_revokeDevice($caller, $body);
    case 'push':          act_push($caller, $body);
    case 'pull':          act_pull($body);
    case 'putSnapshot':   act_putSnapshot($caller, $body);
    case 'getSnapshot':   act_getSnapshot();
    case 'compact':       act_compact($caller, $body);
    case 'rekey':         act_rekey($caller);
}

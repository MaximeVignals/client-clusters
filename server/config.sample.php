<?php
/**
 * Client Clusters relay configuration.
 *
 * Copy this file to config.php (same folder) and edit it. config.php is optional:
 * without it the relay uses the defaults below, but SETUP_CODE has no default, so
 * you must create config.php before the relay will accept anything.
 * Never share config.php; it is denied to web visitors by .htaccess.
 */
return [
    // REQUIRED. A long secret of your choice, at least 16 characters (use 30 or more).
    // You type it once in the Windows app (Settings > Sync) to claim this relay.
    // Until it is set, every action except "hello" returns 500 "Relay not configured".
    'SETUP_CODE' => '',

    // Where encrypted bundles are stored. Default: a folder next to index.php named "data-" plus
    // 24 characters derived from SETUP_CODE, so its address cannot be guessed (it also has an
    // .htaccess "Require all denied"). If your host lets you, point this to a folder OUTSIDE the
    // web root, e.g. '/home/you/cc-sync-data'.
    // Changing SETUP_CODE later changes the default folder name, so the relay would start empty.
    // 'DATA_DIR' => '/home/you/cc-sync-data',

    // Largest single bundle accepted, in bytes (default 2 MB).
    // 'MAX_BUNDLE' => 2 * 1024 * 1024,

    // Largest snapshot (full compressed data set, uploaded by the Windows app with its admin token;
    // other callers are limited to MAX_BUNDLE) accepted, in bytes (default 20 MB).
    // PHP's own post_max_size (often 8 MB by default) must be at least this large too, or
    // big snapshots fail on the host; raise it in php.ini or .user.ini.
    // 'MAX_SNAPSHOT' => 20 * 1024 * 1024,

    // Total storage cap in bytes (default 50 MB). Pushes beyond it get HTTP 507.
    // 'MAX_TOTAL' => 50 * 1024 * 1024,

    // Stored bundle bytes allowed per device (default 10 MB). Beyond it that device gets HTTP 507
    // until bundles are compacted. Stops one device from filling the whole relay.
    // 'DEVICE_QUOTA' => 10 * 1024 * 1024,

    // Requests allowed per minute for each token (default 120). Beyond it: HTTP 429.
    // 'RATE_LIMIT' => 120,

    // Failed logins (wrong token / setup code) allowed per 10 minutes per IP address.
    // A valid token is never blocked by this limit.
    // 'FAIL_LIMIT' => 30,

    // Bundles older than this many days that a snapshot already covers are deleted.
    // 'PRUNE_DAYS' => 60,
];

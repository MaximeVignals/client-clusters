// Loads android/www in Electron with a fake Capacitor bridge and checks the phone screens. Made-up data only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const copy = spawnSync(process.execPath, [path.join(root, 'scripts/copy-shared.cjs')], { encoding: 'utf8' });
const tmpRoot = path.join(root, '.test-tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const profile = fs.mkdtempSync(path.join(tmpRoot, 'electron-'));
const env = { ...process.env, PHONE_UI_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
const electron = require(path.resolve(root, '../node_modules/electron'));
const run = spawnSync(electron, [path.join(__dirname, 'phone-ui-runner.cjs')], { env, encoding: 'utf8', timeout: 120000 });
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

const lines = (run.stdout || '').split(/\r?\n/).filter(l => /^(PASS|FAIL) /.test(l));

test('copy-shared succeeds', () => assert.equal(copy.status, 0, copy.stderr));
test('Electron ran the phone UI', () => assert.ok(lines.length > 0, `no results. stderr: ${run.stderr}\n${run.error || ''}`));
for (const l of lines) test(l.replace(/^(PASS|FAIL) /, ''), () => assert.ok(l.startsWith('PASS'), l));
test('runner exited cleanly', () => assert.equal(run.status, 0, (run.stdout || '').slice(-1500)));

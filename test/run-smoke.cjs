const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const tmpRoot = path.resolve(__dirname, '../.test-tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const profile = fs.mkdtempSync(path.join(tmpRoot, 'electron-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CLIENT_CLUSTERS_TEST_PROFILE = profile;
const result = spawnSync(require('electron'), [path.join(__dirname, 'electron-smoke.cjs')], {
  env, stdio: 'inherit', timeout: 60000,
});
if (result.error) console.error(result.error.message);
if (path.dirname(profile) !== tmpRoot) throw new Error('Invalid test profile path');
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
if (result.status && !result.stderr) console.error(`Electron exited with status ${result.status}.`);
process.exit(result.status ?? 1);

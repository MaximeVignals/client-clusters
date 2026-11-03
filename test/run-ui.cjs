const { spawnSync } = require('node:child_process');
const path = require('node:path');
for (const scale of [1, 1.25, 1.5, 1.75, 2]) {
  console.log(`\nDesktop UI verification at ${scale * 100}% scale`);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, 'run-smoke.cjs')], {
    env: { ...process.env, CLIENT_CLUSTERS_UI_SCALE: String(scale) }, stdio: 'inherit', timeout: 180000,
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}

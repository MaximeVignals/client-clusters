// Copies the shared rules and Leaflet into www/lib (gitignored). Run before `cap sync`.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(__dirname, '../www/lib');
const files = [
  'src/shared/visits.js', 'src/shared/sync-model.js', 'src/shared/sync-ops.js', 'src/shared/sync-crypto.js', 'src/shared/sync-engine.js',
  'src/renderer/hours.js', 'src/renderer/cluster.js', 'src/renderer/planning.js',
];
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of files) {
  const src = path.join(root, f);
  if (!fs.existsSync(src)) { console.error(`Missing ${f}`); process.exitCode = 1; continue; }
  fs.copyFileSync(src, path.join(out, path.basename(f)));
}
const leaflet = path.join(root, 'node_modules/leaflet/dist');
fs.mkdirSync(path.join(out, 'leaflet'), { recursive: true });
for (const f of ['leaflet.js', 'leaflet.css']) fs.copyFileSync(path.join(leaflet, f), path.join(out, 'leaflet', f));
fs.cpSync(path.join(leaflet, 'images'), path.join(out, 'leaflet/images'), { recursive: true });
console.log(`Copied ${files.length} shared files and Leaflet to www/lib`);

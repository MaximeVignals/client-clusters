// Windows build: a folder install (zip of the whole app) plus a small update package.
// The update package holds only resources/app.asar, so most updates are a few hundred KB.
// It can only replace app.asar on an install with the same Electron version; the updater checks that.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const JSZip = require('jszip');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
const dist = path.join(root, 'dist');

// 1) Electron version, shipped next to app.asar so the updater can compare.
fs.writeFileSync(path.join(root, 'build', 'electron-version.txt'), electronVersion);

// 2) Build the folder and its zip.
execSync('npx electron-builder --win', { cwd: root, stdio: 'inherit' });

(async () => {
  // 3) Update package: app.asar + update.json (version, Electron version, SHA-256 of app.asar).
  const asar = fs.readFileSync(path.join(dist, 'win-unpacked', 'resources', 'app.asar'));
  const info = {
    app: 'Client Clusters', version: pkg.version, electron: electronVersion,
    sha256: crypto.createHash('sha256').update(asar).digest('hex'), createdAt: new Date().toISOString(),
  };
  const zip = new JSZip();
  zip.file('app.asar', asar);
  zip.file('update.json', JSON.stringify(info, null, 1));
  const out = path.join(dist, `ClientClusters-${pkg.version}-update.zip`);
  fs.writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const kb = n => Math.round(n / 1024) + ' KB';
  console.log(`\nFull install: dist/ClientClusters-${pkg.version}-win-x64.7z`);
  console.log(`Update only:  ${path.relative(root, out)} (${kb(fs.statSync(out).size)}), Electron ${electronVersion}`);
})();

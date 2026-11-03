// Data folder, atomic writes, daily backups, and the main window shared by the other modules.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_UA = 'ClientClusters/1.0 (desktop app; client visit planner)';
const ui = { win: null }; // set once the window exists; used as the parent of file dialogs

function dataDir() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const dataFile = () => path.join(dataDir(), 'clients.json');
const backupDir = () => {
  const d = path.join(dataDir(), 'backups');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

// Text is written as UTF-8; buffers as they are.
function writeAtomic(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// One backup per day, keep the 14 most recent.
function dailyBackup() {
  try {
    if (!fs.existsSync(dataFile())) return;
    const day = new Date().toISOString().slice(0, 10);
    const target = path.join(backupDir(), `clients-${day}.json`);
    if (!fs.existsSync(target)) fs.copyFileSync(dataFile(), target);
    const files = fs.readdirSync(backupDir()).filter(f => /^clients-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (files.length > 14) fs.unlinkSync(path.join(backupDir(), files.shift()));
  } catch (e) { console.error('Backup failed', e); }
}

module.exports = { APP_UA, ui, dataDir, dataFile, backupDir, writeAtomic, dailyBackup };

// Client data on disk, importing (Excel / CSV / KMZ / KML / GeoJSON) and exporting (KMZ, Excel).
const { ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const JSZip = require('jszip');
const sync = require('./sync');
const { ui, dataDir, dataFile, backupDir, writeAtomic, DAILY_RE } = require('./paths');

// ---------- Data ----------
// Daily backups that still parse and hold a client list, newest first (offered when the data file is damaged).
function usableDailyBackups() {
  const out = [];
  try {
    for (const file of fs.readdirSync(backupDir()).filter(f => DAILY_RE.test(f)).sort().reverse()) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(backupDir(), file), 'utf8'));
        if (!data || !Array.isArray(data.clients)) continue;
        const visits = data.clients.reduce((n, c) => n + (c && Array.isArray(c.visits) ? c.visits.length : 0), 0);
        out.push({ file, date: file.slice(8, 18), clients: data.clients.length, visits });
      } catch { /* damaged backup: left out */ }
    }
  } catch { /* no backups folder to read */ }
  return out;
}

ipcMain.handle('data:load', () => {
  try {
    if (!fs.existsSync(dataFile())) return null;
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
  } catch (e) {
    // The window starts empty after this, and the next save replaces the file: keep what is there first.
    let kept = '';
    try {
      const copy = path.join(backupDir(), `unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.copyFileSync(dataFile(), copy);
      kept = ` A copy was kept as backups\\${path.basename(copy)} in the data folder.`;
    } catch { /* nothing more can be done */ }
    return { __error: 'Could not read the data file: ' + e.message + '.' + kept, backups: usableDailyBackups() };
  }
});

// Only a plain daily backup name is accepted, so the window can never make this read another path.
ipcMain.handle('data:restoreDaily', (_e, file) => {
  if (typeof file !== 'string' || !DAILY_RE.test(file)) throw new Error('That is not a daily backup file name.');
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(backupDir(), file), 'utf8')); }
  catch { throw new Error('That backup could not be read.'); }
  if (!data || !Array.isArray(data.clients)) throw new Error('That backup does not contain a client list.');
  return data;
});

ipcMain.handle('data:save', (_e, data) => {
  writeAtomic(dataFile(), JSON.stringify(data, null, 1));
  try { sync.onSaved(data); } catch (e) { console.error('Sync hook failed', e); } // never lets sync break saving
  return true;
});

ipcMain.handle('data:openFolder', () => shell.openPath(dataDir()));

// ---------- Import ----------
function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.slice(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Excel on French Windows saves CSV in Windows-1252
    return new TextDecoder('windows-1252').decode(buf);
  }
}

function parseCsv(text) {
  const firstLine = text.split(/\r?\n/).find(l => l.trim()) || '';
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  const [best, bestCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const sep = bestCount > 0 ? best : ',';
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function cellToString(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    if (isNaN(v)) return '';
    // SheetJS returns dates at local midnight; shift by 12h to avoid timezone day slips
    const d = new Date(v.getTime() + 12 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

async function openTableOrMap(title, filter) {
  const r = await dialog.showOpenDialog(ui.win, {
    title,
    filters: [filter, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return readTableOrMap(r.filePaths[0]);
}

ipcMain.handle('import:open', () => openTableOrMap('Choose your client list',
  { name: 'Excel, CSV or Google Earth (KMZ/KML)', extensions: ['xlsx', 'xlsm', 'xls', 'ods', 'csv', 'txt', 'kmz', 'kml'] }));

// Prospecting map: same formats, plus GeoJSON (parsed in the window).
ipcMain.handle('prospect:open', () => openTableOrMap('Choose your prospecting file',
  { name: 'Excel, CSV, KMZ/KML or GeoJSON', extensions: ['xlsx', 'xlsm', 'xls', 'ods', 'csv', 'txt', 'kmz', 'kml', 'geojson', 'json'] }));

async function readTableOrMap(file) {
  const ext = path.extname(file).toLowerCase();
  const buf = fs.readFileSync(file);
  const fileName = path.basename(file);
  if (ext === '.geojson' || ext === '.json') return { fileName, geojson: decodeText(buf) };
  // KMZ = zipped KML. The KML (XML) is parsed in the window, which has an XML parser.
  if (ext === '.kml') return { fileName, kml: decodeText(buf) };
  if (ext === '.kmz' || (buf[0] === 0x50 && buf[1] === 0x4b && !/\.(xlsx|xlsm|ods)$/.test(ext))) {
    const zip = await JSZip.loadAsync(buf);
    const kmls = Object.values(zip.files).filter(f => !f.dir && /\.kml$/i.test(f.name));
    const main = kmls.find(f => /(^|\/)doc\.kml$/i.test(f.name)) || kmls[0];
    if (!main) throw new Error('No KML found inside this KMZ file.');
    return { fileName, kml: await main.async('string') };
  }
  let sheets = [];
  if (ext === '.csv' || ext === '.txt') {
    sheets = [{ name: fileName, rows: parseCsv(decodeText(buf)) }];
  } else {
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    sheets = wb.SheetNames.map(name => ({
      name,
      rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' })
        .map(row => row.map(cellToString)),
    }));
  }
  sheets = sheets
    .map(s => ({ name: s.name, rows: s.rows.filter(row => row.some(c => String(c).trim() !== '')) }))
    .filter(s => s.rows.length > 0);
  return { fileName, sheets };
}

// ---------- Export ----------
ipcMain.handle('export:kmz', async (_e, { kml, defaultName }) => {
  const r = await dialog.showSaveDialog(ui.win, {
    title: 'Export for Google Earth / My Maps',
    defaultPath: defaultName || 'clients.kmz',
    filters: [{ name: 'Google Earth (KMZ)', extensions: ['kmz'] }, { name: 'KML', extensions: ['kml'] }],
  });
  if (r.canceled || !r.filePath) return null;
  if (/\.kml$/i.test(r.filePath)) fs.writeFileSync(r.filePath, kml, 'utf8');
  else {
    const zip = new JSZip();
    zip.file('doc.kml', kml);
    fs.writeFileSync(r.filePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  }
  shell.showItemInFolder(r.filePath);
  return r.filePath;
});

ipcMain.handle('export:xlsx', async (_e, { sheets, defaultName }) => {
  const r = await dialog.showSaveDialog(ui.win, {
    title: 'Export to Excel',
    defaultPath: defaultName || 'clients.xlsx',
    filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    // ISO dates become real Excel dates so they can be sorted and filtered.
    const rows = s.rows.map(r => r.map(v => {
      const m = typeof v === 'string' && v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : v;
    }));
    const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true, dateNF: 'dd/mm/yyyy' });
    ws['!cols'] = (s.widths || []).map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  XLSX.writeFile(wb, r.filePath);
  shell.showItemInFolder(r.filePath);
  return r.filePath;
});

module.exports = { decodeText, parseCsv };

// Runs the real sandboxed renderer and preload with isolated data and offline IPC fixtures.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
const profile = process.env.CLIENT_CLUSTERS_TEST_PROFILE;
const captureDocs = process.env.CLIENT_CLUSTERS_CAPTURE_DOCS === '1';
if (!profile || path.dirname(profile) !== path.resolve(__dirname, '../.test-tmp')) throw new Error('Run via test/run-smoke.cjs');
app.setPath('userData', profile);
app.disableHardwareAcceleration();
let saved;
let failed = 0;
const errors = [];
ipcMain.handle('data:load', () => null);
ipcMain.handle('data:save', (_e, data) => { saved = data; return true; });
ipcMain.handle('data:restoreDaily', (_e, file) => {
  if (file !== 'clients-2026-11-08.json') throw new Error('No such backup');
  return { clients: [
    { id: 'r1', name: 'Fictional one', visits: [{ id: 'rv', date: '2026-01-01', status: 'done', type: 'visit' }] },
    { id: 'r2', name: 'Fictional two' },
  ], groups: [] };
});
ipcMain.handle('sync:status', () => ({ enabled: false, state: 'off', error: null, lastSyncAt: 0, paused: false }));
const syncLog = []; // order of sync calls from the window: recovery must compare with the phones (rebase) before sync resumes
ipcMain.handle('sync:pause', (_e, p) => { syncLog.push('pause:' + p); return { enabled: false, state: 'off', paused: !!p }; });
ipcMain.handle('sync:rebase', () => { syncLog.push('rebase'); return { ok: true, skipped: true, restored: 0 }; });
ipcMain.handle('sync:applied', () => true);
ipcMain.handle('sync:confirmDeletes', () => ({ ok: true }));
ipcMain.handle('google:keyStatus', () => ({ hasKey: false, masked: '' }));
ipcMain.handle('geo:town', () => ({ city: 'Test town', postcode: '69001' }));
ipcMain.handle('geo:geocode', (_e, { query }) => (/nowhere/i.test(query) ? { error: 'Address not found' } : { lat: 45.76, lng: 4.84, city: 'Lyon', score: 1 }));
ipcMain.handle('import:open', () => ({ fileName: 'Fictional clients.xlsx', sheets: [{ name: 'Clients', rows: [
  ['Name', 'Address', 'Postcode', 'City', 'Latitude', 'Longitude'], ['Example client', '1 Example street', '69001', 'Lyon', 45.76, 4.84],
] }] }));

app.whenReady().then(async () => {
  // Avoid network access and tile failures while exercising Leaflet and the actual page.
  if (!captureDocs) session.defaultSession.protocol.handle('https', () => new Response(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e5ebec"/><path d="M0 0H256V256" fill="none" stroke="#dbe2e4"/></svg>',
    { headers: { 'content-type': 'image/svg+xml' } }));
  else session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://tile.openstreetmap.org/*', 'https://data.geopf.fr/*'] },
    (details, callback) => { details.requestHeaders['User-Agent'] = 'ClientClusters/1.9 (desktop app; demo documentation capture)'; callback({ requestHeaders: details.requestHeaders }); });
  const win = new BrowserWindow({ show: false, width: 1400, height: 880,
    webPreferences: { preload: path.resolve(__dirname, '../src/preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: !!process.env.CLIENT_CLUSTERS_UI_SCALE || captureDocs } });
  win.webContents.on('console-message', event => {
    if (event.level === 'error') errors.push(event.message);
  });
  await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
  const js = code => win.webContents.executeJavaScript(code);
  async function check(name, code) {
    try {
      const result = await js(`(async () => { const check = (ok, message) => { if (!ok) throw new Error(message); }; ${code} return true; })()`);
      assert.equal(result, true);
      console.log(`PASS ${name}`);
    } catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  await check('empty startup', `
    for (let i = 0; i < 100 && !state.derived; i++) await new Promise(r => setTimeout(r, 20));
    check(state.derived && state.data.clients.length === 0, 'startup did not finish');
    check(!$('#empty').hidden, 'empty state missing');
  `);
  await check('demo, clustering, tabs, details and planning dialog', `
    loadDemo();
    for (let i = 0; i < 100 && !state.data.groups.length; i++) await new Promise(r => setTimeout(r, 20));
    check(state.data.clients.length === 43 && state.data.groups.length > 0, 'demo failed');
    for (const tab of document.querySelectorAll('.tab')) tab.click();
    state.tab = 'clients'; renderAll(); selectClient(state.data.clients[0].id);
    check(!$('#detail').hidden && $('#detail [data-f="name"]').value === state.data.clients[0].name, 'detail missing');
    planDayDialog(); check(!$('#modal').hidden, 'planner missing'); modalCtx.close();
    settingsDialog(); check(!$('#modal').hidden, 'settings missing'); modalCtx.close();
  `);
  if (captureDocs) {
    if (failed) throw new Error('Demo initialization failed; documentation capture cancelled.');
    await require('./capture-docs.cjs')(win, js);
    win.destroy(); app.exit(0); return;
  }
  if (process.env.CLIENT_CLUSTERS_UI_SCALE) await require('./desktop-ui.cjs')(win, check, js);
  await check('a planned call does not absorb a separate in-person visit', `
    const c = { visits: [] }, date = addDaysISO(todayISO(), 1);
    recordVisit(c, { date, status: 'planned', type: 'call' });
    recordVisit(c, { date, status: 'planned', type: 'visit' });
    check(c.visits.length === 2, 'planned visit was lost');
    recordVisit(c, { date, status: 'done', type: 'visit' });
    check(c.visits.find(v => v.type === 'call').status === 'planned', 'call was confirmed as a visit');
    check(c.visits.find(v => v.type === 'visit').status === 'done', 'visit was not confirmed');
  `);
  await check('a closed dialog cannot touch its replacement, and a confirmation keeps what was typed', `
    let lateClose, lateRerender;
    showModal({ title: 'First', render: () => '<input id="first">', buttons: [{ label: 'Close', action: 'close' }],
      onClick(e, box, close, rerender) { lateClose = close; lateRerender = rerender; } });
    $('#modal-box .modal-body').click();
    modalCtx.close();
    showModal({ title: 'Second', render: () => '<input id="second">', buttons: [{ label: 'Close', action: 'close' }] });
    $('#second').value = 'typed';
    lateRerender(); lateClose();
    check(!$('#modal').hidden && $('#second')?.value === 'typed', 'a closed dialog changed the one on screen');
    const answer = confirmDialog('Sure?', 'Fictional question');
    check(!$('#second'), 'confirmation not shown');
    modalCtx.close();
    check((await answer) === false && $('#second')?.value === 'typed', 'typed text was lost behind the confirmation');
    modalCtx.close();
    check($('#modal').hidden && !modalCtx, 'dialog did not close after the confirmation');
  `);
  await check('a failed address search keeps a pin placed by hand', `
    const c = { name: 'Fictional', address: 'Nowhere street', geo: { source: 'manual' }, lat: 45, lng: 4 };
    check((await geocodeOne(c)) === false && c.lat === 45 && c.geo.source === 'manual', 'hand-placed pin was removed');
    const d = { name: 'Fictional', address: 'Nowhere street', geo: { status: 'ok', source: 'IGN' }, lat: 45, lng: 4 };
    check((await geocodeOne(d)) === false && d.lat === undefined && d.geo.status === 'failed', 'an address that is no longer found kept its old position');
  `);
  await check('combining backups preserves calls and visits on the same day', `
    loadData({ clients: [{ id: 'c', name: 'Client', visits: [{ id: 'v1', date: '2026-01-01', type: 'visit', status: 'done', note: '' }] }] });
    mergeBackup({ clients: [{ id: 'c', name: 'Client', visits: [{ id: 'v2', date: '2026-01-01', type: 'call', status: 'done', note: '' }] }] });
    check(state.data.clients[0].visits.length === 2, 'phone call was lost');
    mergeBackup({ clients: [{ id: 'c', name: 'Client', visits: [{ id: 'v3', date: '2026-01-01', type: 'visit', status: 'done', note: '' }] }] });
    check(state.data.clients[0].visits.length === 2, 'identical visit was duplicated');
  `);
  await check('marking visited today preserves phone calls and unsuccessful visits', `
    loadData({ clients: [{ id: 'c', name: 'Client', visits: [
      { id: 'call', date: todayISO(), type: 'call', status: 'done' },
      { id: 'absent', date: todayISO(), type: 'visit', status: 'done', outcome: 'absent' }
    ] }] });
    const c = state.data.clients[0];
    check(!doneToday(c), 'a call or unsuccessful visit counted as visited');
    toggleVisitedToday(c.id);
    check(doneToday(c) && c.visits.length === 3, 'today’s visit was not added');
    toggleVisitedToday(c.id);
    check(!doneToday(c) && c.visits.length === 2 && c.visits.some(v => v.id === 'call'), 'undo removed existing history');
  `);
  await check('prospect demo, grouping and GeoJSON/KML imports', `
    loadProspectDemo(); groupProspects();
    check(P().prospects.length === 25 && P().prospects.every(p => p.group), 'prospect demo failed');
    const geo = readGeoJsonProspects(JSON.stringify({ type: 'Feature', properties: { name: 'Test' }, geometry: { type: 'Point', coordinates: [4, 45] } }));
    check(geo.points.length === 1 && geo.points[0].lat === 45, 'GeoJSON point failed');
    const kml = readKmlProspects('<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>Test</name><Point><coordinates>4,45,0</coordinates></Point></Placemark></kml>');
    check(kml.points.length === 1 && kml.points[0].lng === 4, 'KML point failed');
  `);
  await check('combining prospects deduplicates incoming records', `
    loadData({});
    const area = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[4, 45], [4.1, 45.1]] } };
    mergeProspecting({ prospects: [{ id: 'p1', name: 'Same', address: 'A' }, { id: 'p2', name: 'Same', address: 'A', status: 'visited', statusAt: '2026-01-01' }], areas: [area, area] });
    check(P().prospects.length === 1, 'duplicate prospect was added');
    check(P().prospects[0].status === 'visited', 'latest status was lost');
    check(P().areas.length === 1, 'duplicate area was added');
  `);
  await check('recovery screen opens and pauses saving', `
    startRecovery({ __error: 'Fictional error', backups: [{ file: 'clients-2026-11-08.json', date: '2026-11-08', clients: 2, visits: 1 }] });
    check(!$('#modal').hidden && $('#modal-title').textContent === 'Your data could not be read', 'recovery dialog missing');
    check($('#banners [data-b="recover"]'), 'recovery banner missing');
  `);
  saved = undefined;
  await js('save(); flushSave();');
  await new Promise(r => setTimeout(r, 350));
  if (saved !== undefined) { failed++; console.error('FAIL saving is not paused during recovery'); }
  else console.log('PASS saving is paused during recovery');
  await check('closing the recovery dialog keeps recovery pending, the banner reopens it', `
    modalCtx.close();
    check($('#modal').hidden && state.recovery, 'recovery ended by closing');
    check($('#banners [data-b="recover"]'), 'banner disappeared');
    $('#banners [data-b="recover"]').click();
    check(!$('#modal').hidden, 'banner did not reopen the dialog');
  `);
  saved = undefined; syncLog.length = 0;
  await check('restoring the daily backup ends recovery and resumes saving', `
    $('#modal-box [data-mb="2"]').click();
    for (let i = 0; i < 100 && state.recovery; i++) await new Promise(r => setTimeout(r, 20));
    check(state.recovery === null && state.data.clients.length === 2, 'backup not restored');
    check($('#modal').hidden, 'dialog still open');
  `);
  await new Promise(r => setTimeout(r, 350));
  if (!saved || saved.clients.length !== 2) { failed++; console.error('FAIL restored backup was not saved'); }
  else console.log('PASS restored backup was saved');
  for (let i = 0; i < 100 && !syncLog.includes('rebase'); i++) await new Promise(r => setTimeout(r, 20));
  // (the UI suite swaps the pause stub, so only the order is checked: rebase first, never a resume before it)
  if (syncLog[0] !== 'rebase') { failed++; console.error('FAIL recovery restore must rebase, then resume sync: ' + syncLog.join()); }
  else console.log('PASS recovery restore rebases before sync resumes');
  await check('client import updates existing clients and preserves visit history', `
    loadData({ clients: [{ id: 'c1', name: 'Test', address: 'A', postcode: '69001', city: 'Lyon', lat: 45, lng: 4,
      visits: [{ id: 'visit', date: '2026-01-01', status: 'done', type: 'visit' }] }], groups: [{ id: 'g', number: 1, name: 'Lyon', color: '#2563eb' }] });
    runImport({ headers: ['Name', 'Address', 'Postcode', 'City', 'Lat', 'Lng'], data: [['Test', 'A', '69001', 'Lyon', '45', '4']] },
      { name: 0, address: 1, postcode: 2, city: 3, lat: 4, lng: 5 }, 'merge');
    check(state.data.clients.length === 1 && state.data.clients[0].visits[0].id === 'visit', 'import lost history or duplicated client');
    flushSave();
  `);
  await new Promise(r => setTimeout(r, 50));
  if (!saved || saved.clients.length !== 1) { failed++; console.error('FAIL persistence IPC'); }
  if (errors.length) { failed++; console.error('Renderer errors:', errors.join('\n')); }
  console.log(`Smoke checks completed: ${failed} failure(s).`);
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch(error => { console.error(error); app.exit(1); });

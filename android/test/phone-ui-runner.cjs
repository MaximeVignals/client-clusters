// Run by Electron (see phone-ui.test.cjs). Loads android/www/index.html with a fake Capacitor and prints PASS/FAIL lines.
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const profile = process.env.PHONE_UI_PROFILE;
if (!profile) throw new Error('Run via phone-ui.test.cjs');
app.setPath('userData', profile);
app.disableHardwareAcceleration();

process.on('uncaughtException', e => { console.log('FAIL uncaught: ' + (e && e.stack || e)); app.exit(1); });
process.on('unhandledRejection', e => { console.log('FAIL unhandled: ' + (e && e.stack || e)); app.exit(1); });
let failed = 0;
const consoleErrors = [];

app.whenReady().then(async () => {
  // No network: tiles and the relay are fake or blocked.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_d, cb) => cb({ cancel: true }));
  const win = new BrowserWindow({
    show: false, width: 390, height: 800,
    webPreferences: { preload: path.join(__dirname, 'fake-capacitor.cjs'), contextIsolation: false, sandbox: false, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', e => {
    if (e.level === 'error' && !/Failed to load resource|ERR_BLOCKED|net::/.test(e.message)) consoleErrors.push(`${e.message} (${String(e.sourceId).split('/').pop()}:${e.lineNumber})`);
  });
  await win.loadFile(path.resolve(__dirname, '../www/index.html'));
  const js = code => win.webContents.executeJavaScript(code);

  const prelude = `
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const until = async (fn, what) => { for (let i = 0; i < 150; i++) { let v; try { v = await fn(); } catch (e) { v = false; } if (v) return v; await sleep(30); } throw new Error('Timed out: ' + what); };
    const click = sel => { const el = document.querySelector(sel); if (!el) throw new Error('No element ' + sel); el.click(); };
    const text = () => document.querySelector('#view').innerText;
    const mode = () => document.body.dataset.mode;
    const outbox = () => { const f = __test.files.get('engine.json'); return f ? JSON.parse(f).outbox : []; };
  `;
  async function check(name, code) {
    try {
      const result = await js(`(async () => { ${prelude} ${code}\n return true; })()`);
      if (result !== true) throw new Error('did not complete');
      console.log(`PASS ${name}`);
    } catch (error) { failed++; console.log(`FAIL ${name}: ${error.message}`); }
  }

  await check('welcome screen when unpaired', `
    await until(() => App.ready, 'app start');
    check(mode() === 'welcome', 'mode is ' + mode());
    check(/Settings/.test(text()) && /Add a phone/.test(text()), 'welcome text missing: ' + text());
    check(getComputedStyle(document.querySelector('#tabs')).display === 'none', 'tab bar visible while unpaired');
  `);

  await check('a bad pairing code is refused', `
    document.querySelector('#paste').value = 'hello';
    click('[data-act=paste-pair]');
    await until(() => !document.querySelector('#toast').hidden, 'toast');
    check(/pairing code/i.test(document.querySelector('#toast').textContent), document.querySelector('#toast').textContent);
    check(mode() === 'welcome', 'should stay unpaired');
  `);

  await check('paste a pairing code pairs and downloads the data', `
    await __test.seedPc();
    document.querySelector('#paste').value = __test.pairingCode();
    click('[data-act=paste-pair]');
    await until(() => mode() === 'app', 'paired');
    await until(() => Object.keys(App.proj.clients).length === 2, 'clients downloaded');
    check(JSON.parse(__test.files.get('pairing.json')).pcDeviceId === 'pc-dev', 'pairing.json not stored with device ids');
    check(__test.files.has('data.json') && __test.files.has('engine.json'), 'data.json / engine.json missing');
    await until(() => document.querySelector('#chip').textContent === 'Synced', 'chip Synced, got ' + document.querySelector('#chip').textContent);
    check(!__test.files.has('data.json.tmp'), 'temp file left behind');
  `);

  await check('Today lists planned visits in order with open status, and unconfirmed ones', `
    await until(() => document.querySelectorAll('#view .row').length >= 3, 'rows');
    const rows = [...document.querySelectorAll('#view .row')];
    check(/Boulangerie Exemple/.test(rows[0].textContent) && /Garage Fictif/.test(rows[1].textContent), 'order wrong: ' + rows.map(r => r.textContent.trim()).join(' | '));
    check(/Open 24h/.test(rows[0].textContent), 'open tag missing: ' + rows[0].textContent);
    check(/unconfirmed \\(1\\)/i.test(text()), 'unconfirmed header missing');
    check(/Boulangerie/.test(rows[2].textContent), 'past planned visit missing');
  `);

  await check('Client: phone link, navigate, notes, hours', `
    click('#view .row');
    await until(() => document.querySelector('#title').textContent === 'Boulangerie Exemple', 'client opens');
    const tels = document.querySelectorAll('[data-act=call]');
    check(tels.length === 1 && tels[0].dataset.url === 'tel:0478000001', 'tel button: ' + [...tels].map(t => t.dataset.url));
    tels[0].click();
    await until(() => __opened.includes('tel:0478000001'), 'AppLauncher not called with tel:');
    document.querySelector('[data-act=navigate]').click();
    await until(() => __opened.includes('https://www.google.com/maps/dir/?api=1&destination=45.767,4.835'), 'AppLauncher not called with maps url: ' + __opened);
    check(/Open 24 hours/.test(text()), 'hours missing');
    check(document.querySelector('#notes').value === 'Likes baguettes', 'notes not shown');
  `);

  await check('Client: notes edit is saved on blur and queued for sync', `
    const el = document.querySelector('#notes');
    el.value = 'Likes baguettes and croissants';
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await until(() => outbox().some(o => o.k === 'set' && o.e === 'client' && o.f === 'notes' && /croissants/.test(o.v)), 'notes op');
    check(App.proj.clients.c1.notes === 'Likes baguettes and croissants', 'projection not updated');
    check(JSON.parse(__test.files.get('data.json')).clients.c1.notes === 'Likes baguettes and croissants', 'data.json not updated');
  `);

  await check('Client: log a visit appears in history and creates a visit op', `
    click('[data-act=log-open]');
    await until(() => document.querySelector('#lv-note'), 'form');
    document.querySelector('#lv-note').value = 'Met the owner, new order';
    document.querySelector('#lv-outcome').value = 'order';
    click('[data-act=log-save]');
    await until(() => /Met the owner, new order/.test(document.querySelector('#history').textContent), 'history entry');
    check(/Order taken/.test(document.querySelector('#history').textContent), 'outcome missing');
    check(!document.querySelector('#logform'), 'form should close');
    const ops = outbox().filter(o => o.k === 'visit');
    check(ops.length >= 1, 'no visit op in outbox: ' + JSON.stringify(outbox()));
    // Same day as the planned visit: it is confirmed (done), not duplicated.
    const visits = Object.values(App.proj.clients.c1.visits);
    check(visits.length === 2 && visits.filter(v => v.status === 'done').length === 1 && visits.find(v => v.id === 'v1').status === 'done', 'planned visit not confirmed: ' + JSON.stringify(visits));
  `);

  await check('Client: Undo on a confirmed visit puts it back to planned', `
    click('[data-act=visit-undo]');
    await until(() => App.proj.clients.c1.visits.v1.status === 'planned', 'back to planned');
    await until(() => document.querySelector('[data-act=visit-done][data-vid=v1]'), 'row redrawn');
    click('[data-act=visit-done][data-vid=v1]');
    await until(() => App.proj.clients.c1.visits.v1.status === 'done', 'done again');
  `);

  await check("Client: Done, Didn't happen and Undo on planned visits", `
    click('[data-act=back]');
    await until(() => document.querySelector('#title').textContent === 'Today', 'back to Today');
    await until(() => document.querySelectorAll('#view .row').length === 2, 'rows after done: ' + text());
    const row = [...document.querySelectorAll('#view .row')].find(r => /Garage/.test(r.textContent));
    row.click();
    await until(() => document.querySelector('#title').textContent === 'Garage Fictif', 'garage opens');
    document.querySelector('#toast').hidden = true;
    click('[data-act=visit-done]');
    await until(() => !document.querySelector('#toast').hidden && /Marked done/.test(document.querySelector('#toast').textContent), 'toast');
    check(App.proj.clients.c2.visits.v2.status === 'done', 'not done');
    click('#toast [data-act=toast-action]');
    await until(() => App.proj.clients.c2.visits.v2.status === 'planned', 'undo toast');
    await until(() => document.querySelector('[data-act=visit-cancel]'), 'row redrawn');
    click('[data-act=visit-cancel]');
    await until(() => App.proj.clients.c2.visits.v2.status === 'cancelled', 'cancelled');
    check(/Didn't happen/.test(document.querySelector('#history').textContent), 'label missing');
    check(outbox().filter(o => o.k === 'visit' && o.id === 'v2').length >= 1, 'no op for v2');
  `);

  await check('Map: client markers by group colour, prospect toggle, home marker, tap opens client', `
    click('[data-act=back]'); click('#tabs [data-tab=map]');
    await until(() => !document.querySelector('#mapview').hidden && document.querySelectorAll('#map path.leaflet-interactive').length === 2, 'two client markers');
    const fills = [...document.querySelectorAll('#map path.leaflet-interactive')].map(p => p.getAttribute('fill'));
    check(fills.every(f => f === '#d9480f'), 'group colour: ' + fills);
    check(document.querySelector('#map .hm'), 'home marker missing');
    check(!document.querySelector('#map .pm'), 'prospects must be hidden by default');
    const box = document.querySelector('#show-prospects'); box.checked = true; box.dispatchEvent(new Event('change'));
    await until(() => document.querySelector('#map .pm'), 'prospect marker');
    document.querySelector('#map path.leaflet-interactive').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    await until(() => /Boulangerie|Garage/.test(document.querySelector('#title').textContent), 'marker tap opens client');
    click('[data-act=back]');
  `);

  await check('Prospects: grouped by status, search, status change and notes', `
    click('#tabs [data-tab=prospects]');
    await until(() => /to contact \\(1\\)/i.test(text()), 'grouped list: ' + text());
    const s = document.querySelector('#psearch'); s.value = 'zzz'; s.dispatchEvent(new Event('input', { bubbles: true }));
    check(/No prospects/.test(text()), 'search should filter');
    s.value = 'cafe'; s.dispatchEvent(new Event('input', { bubbles: true }));
    click('[data-act=open-prospect]');
    await until(() => document.querySelector('#title').textContent === 'Cafe Prospect', 'prospect opens');
    click('[data-act=pstatus][data-status=visited]');
    await until(() => App.proj.prospects.p1.status === 'visited', 'status changed');
    await until(() => document.querySelector('[data-status=visited].on'), 'status button highlighted');
    check(outbox().some(o => o.k === 'set' && o.e === 'prospect' && o.f === 'status' && o.v === 'visited'), 'no status op');
    const n = document.querySelector('#pnotes'); n.value = 'Call back Monday';
    n.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await until(() => outbox().some(o => o.e === 'prospect' && o.f === 'notes' && o.v === 'Call back Monday'), 'notes op');
    click('[data-act=back]');
    await until(() => /visited \\(1\\)/i.test(text()), 'moved to Visited');
  `);

  await check('Sync now pushes the outbox and the PC receives the phone changes', `
    click('#tabs [data-tab=settings]');
    await until(() => /Test PC/.test(text()), 'settings');
    click('[data-act=sync-now]');
    await until(() => outbox().length === 0 && __test.relay.bundles.some(b => b.device === 'phone-dev'), 'outbox pushed');
    const { applied } = await __test.pcSync();
    const kinds = applied.map(o => o.k + ':' + (o.f || o.e)).sort();
    check(kinds.includes('visit:visit') && kinds.some(k => /set:(notes|status)/.test(k)), 'PC applied: ' + kinds);
    check(/Last sync: (?!never)/.test(text()), 'last sync time missing: ' + text());
  `);

  await check('PC changes arrive on the phone (resume triggers a sync)', `
    __test.pcData.clients[1].notes = 'Updated on the PC';
    await __test.pc.sync({ getProj: () => SyncModel.project(__test.pcData) });
    for (const f of __test.appListeners.resume) f();
    await until(() => App.proj.clients.c2.notes === 'Updated on the PC', 'note from PC');
  `);

  await check('offline shows Offline and keeps the edit', `
    __test.relay.offline = true;
    click('#tabs [data-tab=prospects]');
    click('[data-act=open-prospect]');
    click('[data-act=pstatus][data-status=converted]');
    await until(() => App.proj.prospects.p1.status === 'converted', 'edit while offline');
    click('[data-act=sync-now]');
    await until(() => document.querySelector('#chip').textContent === 'Offline', 'chip Offline: ' + document.querySelector('#chip').textContent);
    check(outbox().some(o => o.f === 'status' && o.v === 'converted'), 'edit lost while offline');
    __test.relay.offline = false;
    click('[data-act=sync-now]');
    await until(() => outbox().length === 0 && document.querySelector('#chip').textContent === 'Synced', 'resynced');
    click('[data-act=back]');
  `);

  await check('both token headers are sent', `
    check(__test.relay.badHeaders === 0, 'requests without matching Authorization and X-CC-Token: ' + __test.relay.badHeaders);
  `);

  await check('a rolled-back relay pauses sync with a clear message and keeps data', `
    click('#tabs [data-tab=settings]');
    const seq = __test.relay.seq, bundles = __test.relay.bundles.slice();
    __test.relay.seq = 0; __test.relay.bundles = [];
    click('[data-act=sync-now]');
    await until(() => /went back to an older state/i.test(document.querySelector('#chip').textContent), 'rollback chip: ' + document.querySelector('#chip').textContent);
    check(Object.keys(App.proj.clients).length === 2 && __test.files.has('data.json'), 'data lost');
    __test.relay.seq = seq; __test.relay.bundles = bundles;
    click('[data-act=sync-now]');
    await until(() => document.querySelector('#chip').textContent === 'Synced', 'recovers: ' + document.querySelector('#chip').textContent);
  `);

  await check('a reset relay (new epoch) shows a clear message and keeps unsent changes', `
    click('#tabs [data-tab=prospects]');
    click('[data-act=open-prospect]');
    const cur = App.proj.prospects.p1.status;
    click('[data-act=pstatus][data-status=' + (cur === 'visited' ? 'todo' : 'visited') + ']');
    await until(() => outbox().length > 0, 'edit queued');
    __test.relay.epoch = 'fedcba9876543210';
    click('#tabs [data-tab=settings]');
    click('[data-act=sync-now]');
    await until(() => /server was reset/i.test(document.querySelector('#chip').textContent), 'reset chip: ' + document.querySelector('#chip').textContent);
    check(outbox().length > 0, 'unsent changes lost');
    __test.relay.epoch = '0123456789abcdef';
    click('[data-act=sync-now]');
    await until(() => outbox().length === 0 && document.querySelector('#chip').textContent === 'Synced', 'recovers: ' + document.querySelector('#chip').textContent);
  `);

  await check('a 200 answer that is not relay JSON keeps the outbox and shows an error', `
    click('#tabs [data-tab=prospects]');
    click('[data-act=open-prospect]');
    click('[data-act=pstatus][data-status=todo]');
    await until(() => App.proj.prospects.p1.status === 'todo' && outbox().length > 0, 'edit queued');
    const queued = outbox().length;
    __test.relay.htmlFor = 'push';
    const before = __test.relay.bundles.length;
    click('#tabs [data-tab=settings]');
    click('[data-act=sync-now]');
    await until(() => /unexpected answer/i.test(document.querySelector('#chip').textContent), 'error chip: ' + document.querySelector('#chip').textContent);
    check(outbox().length === queued, 'outbox changed: ' + outbox().length + ' vs ' + queued);
    check(__test.relay.bundles.length === before, 'relay should not have received anything');
    __test.relay.htmlFor = null;
    click('[data-act=sync-now]');
    await until(() => outbox().length === 0 && document.querySelector('#chip').textContent === 'Synced', 'resynced: ' + document.querySelector('#chip').textContent);
    await __test.pcSync();
  `);

  await check('edits made during a sync are captured after it', `
    let release; __test.relay.gate = new Promise(r => { release = r; }); __test.relay.gateHit = false;
    click('[data-act=sync-now]');
    await until(() => __test.relay.gateHit, 'sync reached the relay');
    click('#tabs [data-tab=prospects]');
    click('[data-act=open-prospect]');
    const n = document.querySelector('#pnotes'); n.value = 'Written during a sync';
    n.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await until(() => App.proj.prospects.p1.notes === 'Written during a sync' && JSON.parse(__test.files.get('data.json')).prospects.p1.notes === 'Written during a sync', 'saved locally');
    check(!outbox().some(o => o.f === 'notes' && o.v === 'Written during a sync'), 'captured while the sync was running');
    const nb = __test.relay.bundles.length;
    __test.relay.gate = null; release();
    await until(() => __test.relay.bundles.length > nb && outbox().length === 0, 'edit pushed after the sync');
    const { applied } = await __test.pcSync();
    check(applied.some(o => o.f === 'notes' && o.v === 'Written during a sync'), 'PC did not get the edit: ' + JSON.stringify(applied));
    click('[data-act=back]');
  `);

  await check('401 keeps local data and the unsent visit; the disconnected screen offers Pair again', `
    click('#tabs [data-tab=today]');
    await until(() => document.querySelector('#view .row'), 'rows');
    [...document.querySelectorAll('#view .row')].find(r => /Garage/.test(r.textContent)).click();
    await until(() => document.querySelector('#title').textContent === 'Garage Fictif', 'garage opens');
    click('[data-act=log-open]');
    await until(() => document.querySelector('#lv-note'), 'form');
    document.querySelector('#lv-note').value = 'Visit made while disconnected';
    click('[data-act=log-save]');
    await until(() => outbox().some(o => o.k === 'visit' && /while disconnected/.test(JSON.stringify(o))), 'visit queued');
    click('[data-act=back]');
    __test.relay.revoked.add('phone-token');
    click('#tabs [data-tab=settings]');
    click('[data-act=sync-now]');
    await until(() => mode() === 'disconnected', 'disconnected screen');
    check(/disconnected from the PC/.test(text()), text());
    check(/Pair again/.test(text()) && /Remove data from this phone/.test(text()), 'buttons missing: ' + text());
    check(getComputedStyle(document.querySelector('#tabs')).display === 'none', 'tabs should be hidden');
    check(__test.files.has('data.json') && Object.keys(App.proj.clients).length === 2, 'local data lost on 401');
    check(outbox().some(o => o.k === 'visit' && /while disconnected/.test(JSON.stringify(o))), 'unsent visit lost on 401');
    click('[data-act=disconnect]');
    await until(() => !document.querySelector('#modal').hidden, 'confirm dialog');
    click('[data-act=modal-cancel]');
    await sleep(50);
    check(__test.files.has('data.json') && outbox().length > 0, 'data deleted without confirmation');
  `);

  await check('a code from a different PC does not keep the data without confirmation', `
    document.querySelector('#paste').value = __test.pairingCode({ pcDeviceId: 'other-pc', token: 'phone2-token', deviceId: 'phone-dev2' });
    click('[data-act=paste-pair]');
    await until(() => !document.querySelector('#modal').hidden, 'confirm dialog');
    check(/different PC/.test(document.querySelector('#modal').textContent), document.querySelector('#modal').textContent);
    click('[data-act=modal-cancel]');
    await sleep(50);
    check(mode() === 'disconnected' && outbox().length > 0 && JSON.parse(__test.files.get('pairing.json')).pcDeviceId === 'pc-dev', 'pairing or outbox changed');
  `);

  await check('Pair again with the same PC keeps the data and pushes the unsent visit', `
    document.querySelector('#paste').value = __test.pairingCode({ token: 'phone2-token', deviceId: 'phone-dev2' });
    click('[data-act=paste-pair]');
    await until(() => mode() === 'app', 'back in the app');
    check(document.querySelector('#modal').hidden, 'no confirmation expected for the same PC');
    await until(() => outbox().length === 0 && __test.relay.bundles.some(b => b.device === 'phone-dev2'), 'unsent visit pushed');
    check(JSON.parse(__test.files.get('pairing.json')).deviceId === 'phone-dev2', 'new pairing not stored');
    const { applied } = await __test.pcSync();
    check(applied.some(o => o.k === 'visit' && /while disconnected/.test(JSON.stringify(o))), 'PC did not receive the visit: ' + JSON.stringify(applied));
  `);

  await check('Disconnect this phone deletes local data after confirm', `
    click('#tabs [data-tab=settings]');
    click('[data-act=disconnect]');
    await until(() => !document.querySelector('#modal').hidden, 'confirm dialog');
    click('[data-act=modal-ok]');
    await until(() => mode() === 'welcome', 'welcome again');
    check(!__test.files.has('data.json') && !__test.files.has('engine.json') && !__test.files.has('pairing.json'), 'files left: ' + [...__test.files.keys()]);
    check(Object.keys(App.proj.clients).length === 0, 'projection not cleared');
  `);

  await check('pair again through the QR scanner', `
    __test.relay.revoked.clear();
    __test.scanText = __test.pairingCode();
    click('[data-act=scan]');
    await until(() => mode() === 'app' && Object.keys(App.proj.clients).length === 2, 'paired by scan');
  `);

  await check('appearance can be forced dark', `
    click('#tabs [data-tab=settings]');
    click('[data-act=appearance][data-v=dark]');
    check(document.documentElement.dataset.theme === 'dark', 'theme not applied');
    click('[data-act=appearance][data-v=system]');
    check(!document.documentElement.dataset.theme, 'system should remove override');
  `);

  console.log(consoleErrors.length ? `FAIL console errors: ${consoleErrors.join(' || ')}` : 'PASS no console errors');
  if (consoleErrors.length) failed++;
  console.log(failed ? `DONE ${failed} failed` : 'DONE all passed');
  app.exit(failed ? 1 : 0);
});

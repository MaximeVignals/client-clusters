// Run by Electron (see phone-ui.test.cjs). Loads android/www/index.html with a fake Capacitor and prints PASS/FAIL lines.
// The UI is French. The window is compact (390x800) for the whole flow; one check at the end resizes to 852x883 (expanded).
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
    const text = () => document.querySelector('#view').innerText;   // the list pane; an open client or prospect is in #detail
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
    check(/Settings/.test(text()) && /Add a phone/.test(text()) && /Client Clusters/.test(text()), 'welcome text missing: ' + text());
    check(getComputedStyle(document.querySelector('#tabs')).display === 'none', 'tab bar visible while unpaired');
    check(document.documentElement.dataset.size === 'compact', 'test window should be compact, got ' + document.documentElement.dataset.size);
  `);

  await check('a bad pairing code is refused', `
    document.querySelector('#paste').value = 'hello';
    click('[data-act=paste-pair]');
    await until(() => !document.querySelector('#toast').hidden, 'toast');
    check(/code d’appairage/i.test(document.querySelector('#toast').textContent), document.querySelector('#toast').textContent);
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
    await until(() => document.querySelector('#chip').textContent === 'Synchronisé', 'pill Synchronisé, got ' + document.querySelector('#chip').textContent);
    check(!__test.files.has('data.json.tmp'), 'temp file left behind');
  `);

  await check('Today lists planned visits in order with open status, and unconfirmed ones', `
    await until(() => document.querySelectorAll('#view .row').length >= 3, 'rows');
    const rows = [...document.querySelectorAll('#view .row')];
    check(/Boulangerie Exemple/.test(rows[0].textContent) && /Garage Fictif/.test(rows[1].textContent), 'order wrong: ' + rows.map(r => r.textContent.trim()).join(' | '));
    check(/Ouvert 24 h\\/24/.test(rows[0].textContent), 'open tag missing: ' + rows[0].textContent);
    check(/à confirmer \\(1\\)/i.test(text()), 'unconfirmed header missing');
    check(/Boulangerie/.test(rows[2].textContent), 'past planned visit missing');
    check(/2 visites prévues, 1 à confirmer/.test(text()), 'day summary missing: ' + text());
    check(document.querySelector('#fab [data-act=picker-open]'), 'Noter une visite button missing');
  `);

  await check('Client: phone link, navigate, notes, hours', `
    click('#view .row');
    await until(() => document.querySelector('#title').textContent === 'Boulangerie Exemple', 'client opens');
    check(!document.querySelector('#detail').hidden && document.querySelector('#detail-title').textContent === 'Boulangerie Exemple', 'detail pane not showing the client');
    const tels = document.querySelectorAll('[data-act=call]');
    check(tels.length === 1 && tels[0].dataset.url === 'tel:0478000001', 'tel button: ' + [...tels].map(t => t.dataset.url));
    tels[0].click();
    await until(() => __opened.includes('tel:0478000001'), 'AppLauncher not called with tel:');
    document.querySelector('[data-act=navigate]').click();
    await until(() => __opened.includes('https://www.google.com/maps/dir/?api=1&destination=45.767,4.835'), 'AppLauncher not called with maps url: ' + __opened);
    check(/Ouvert 24 h\\/24/.test(document.querySelector('#detail .hstatus').textContent), 'hours missing: ' + document.querySelector('#detail').textContent);
    check(document.querySelector('#notes').value === 'Likes baguettes', 'notes not shown');
  `);

  await check('Client: notes edit is saved on blur and queued for sync', `
    const el = document.querySelector('#notes');
    el.value = 'Likes baguettes and croissants';
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await until(() => outbox().some(o => o.k === 'set' && o.e === 'client' && o.f === 'notes' && /croissants/.test(o.v)), 'notes op');
    check(App.proj.clients.c1.notes === 'Likes baguettes and croissants', 'projection not updated');
    check(JSON.parse(__test.files.get('data.json')).clients.c1.notes === 'Likes baguettes and croissants', 'data.json not updated');
    await until(() => /Enregistré/.test(document.querySelector('#notes-status').textContent), 'saved confirmation');
  `);

  await check('Client: log a visit appears in history and creates a visit op', `
    click('[data-act=log-open]');
    await until(() => document.querySelector('#lv-note'), 'form');
    document.querySelector('#lv-note').value = 'Met the owner, new order';
    document.querySelector('#lv-outcome').value = 'order';
    click('[data-act=log-save]');
    await until(() => /Met the owner, new order/.test(document.querySelector('#history').textContent), 'history entry');
    check(/Commande prise/.test(document.querySelector('#history').textContent), 'outcome missing');
    check(!document.querySelector('#logform'), 'form should close');
    await until(() => /Visite enregistrée/.test(document.querySelector('#toast').textContent), 'saved toast');
    const ops = outbox().filter(o => o.k === 'visit');
    check(ops.length >= 1, 'no visit op in outbox: ' + JSON.stringify(outbox()));
    // Same day as the planned visit: it is confirmed (done), not duplicated.
    const visits = Object.values(App.proj.clients.c1.visits);
    check(visits.length === 2 && visits.filter(v => v.status === 'done').length === 1 && visits.find(v => v.id === 'v1').status === 'done', 'planned visit not confirmed: ' + JSON.stringify(visits));
  `);

  await check('Client: Annuler on a confirmed visit puts it back to planned', `
    click('[data-act=visit-undo]');
    await until(() => App.proj.clients.c1.visits.v1.status === 'planned', 'back to planned');
    await until(() => document.querySelector('[data-act=visit-done][data-vid=v1]'), 'row redrawn');
    click('[data-act=visit-done][data-vid=v1]');
    await until(() => App.proj.clients.c1.visits.v1.status === 'done', 'done again');
  `);

  await check("Client: Fait, Pas eu lieu and Annuler (snackbar) on planned visits", `
    click('[data-act=back]');
    await until(() => document.querySelector('#title').textContent === 'Aujourd’hui', 'back to Aujourd’hui');
    await until(() => document.querySelectorAll('#view .row').length === 2, 'rows after done: ' + text());
    const row = [...document.querySelectorAll('#view .row')].find(r => /Garage/.test(r.textContent));
    row.click();
    await until(() => document.querySelector('#title').textContent === 'Garage Fictif', 'garage opens');
    document.querySelector('#toast').hidden = true;
    click('#detail [data-act=visit-done]');
    await until(() => !document.querySelector('#toast').hidden && /Visite marquée faite/.test(document.querySelector('#toast').textContent), 'toast');
    check(/Annuler/.test(document.querySelector('#toast [data-act=toast-action]').textContent), 'Annuler action missing');
    check(App.proj.clients.c2.visits.v2.status === 'done', 'not done');
    click('#toast [data-act=toast-action]');
    await until(() => App.proj.clients.c2.visits.v2.status === 'planned', 'undo toast');
    await until(() => document.querySelector('#detail [data-act=visit-cancel]'), 'row redrawn');
    click('#detail [data-act=visit-cancel]');
    await until(() => App.proj.clients.c2.visits.v2.status === 'cancelled', 'cancelled');
    await until(() => /pas eu lieu/.test(document.querySelector('#toast').textContent) && document.querySelector('#toast [data-act=toast-action]'), 'cancel toast');
    click('#toast [data-act=toast-action]');
    await until(() => App.proj.clients.c2.visits.v2.status === 'planned', 'undo cancel toast');
    await until(() => document.querySelector('#detail [data-act=visit-cancel]'), 'row redrawn again');
    click('#detail [data-act=visit-cancel]');
    await until(() => App.proj.clients.c2.visits.v2.status === 'cancelled', 'cancelled again');
    await until(() => /Pas eu lieu/.test(document.querySelector('#history').textContent), 'label missing');
    check(outbox().filter(o => o.k === 'visit' && o.id === 'v2').length >= 1, 'no op for v2');
  `);

  await check('Map: client markers by group colour, prospect chip, home marker, tap opens client', `
    click('[data-act=back]'); click('#tabs [data-tab=map]');
    await until(() => !document.querySelector('#mapview').hidden && document.querySelectorAll('#map .mk-wrap-client').length === 2, 'two client markers (got ' + document.querySelectorAll('#map .leaflet-marker-icon').length + ' marker elements)');
    const cols = [...document.querySelectorAll('#map .mk-wrap-client .mk-c')].map(p => /--g:\\s*([^;]+)/.exec(p.getAttribute('style'))[1].trim());
    check(cols.length === 2 && cols.every(f => f === '#d9480f'), 'group colour: ' + cols);
    check(document.querySelector('#map .hm'), 'home marker missing');
    check(!document.querySelector('#map .mk-wrap-prospect'), 'prospects must be hidden by default');
    const chip = document.querySelector('#maptools [data-f=prospects]');
    check(chip.getAttribute('aria-pressed') === 'false', 'prospect chip should start off: ' + chip.getAttribute('aria-pressed'));
    click('#maptools [data-f=prospects]');
    await until(() => document.querySelector('#map .mk-wrap-prospect'), 'prospect marker');
    check(chip.getAttribute('aria-pressed') === 'true' && localStorage.getItem('showProspects') === '1', 'prospect chip state not kept');
    document.querySelector('#map .mk-wrap-client').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    await until(() => /Boulangerie|Garage/.test(document.querySelector('#title').textContent), 'marker tap opens client');
    check(!document.querySelector('#detail').hidden, 'detail should show');
    click('[data-act=back]');
    click('#maptools [data-f=prospects]');
    await until(() => !document.querySelector('#map .mk-wrap-prospect'), 'prospect marker hidden again');
    check(localStorage.getItem('showProspects') === '0', 'showProspects not reset');
  `);

  await check('Prospects: grouped by status, search, status change and notes', `
    click('#tabs [data-tab=prospects]');
    await until(() => /À contacter \\(1\\)/i.test(text()), 'grouped list: ' + text());
    const s = document.querySelector('#psearch'); s.value = 'zzz'; s.dispatchEvent(new Event('input', { bubbles: true }));
    check(/Aucun prospect/.test(text()), 'search should filter');
    s.value = 'cafe'; s.dispatchEvent(new Event('input', { bubbles: true }));
    click('[data-act=open-prospect]');
    await until(() => document.querySelector('#title').textContent === 'Cafe Prospect', 'prospect opens');
    click('[data-act=pstatus][data-status=visited]');
    await until(() => App.proj.prospects.p1.status === 'visited', 'status changed');
    await until(() => document.querySelector('[data-status=visited].on'), 'status button highlighted');
    check(document.querySelector('[data-status=visited]').getAttribute('aria-pressed') === 'true' && document.querySelector('[data-status=todo]').getAttribute('aria-pressed') === 'false', 'aria-pressed not updated');
    check(outbox().some(o => o.k === 'set' && o.e === 'prospect' && o.f === 'status' && o.v === 'visited'), 'no status op');
    await until(() => /Statut.{1,3}Visité/.test(document.querySelector('#toast').textContent), 'status toast: ' + document.querySelector('#toast').textContent);
    click('#toast [data-act=toast-action]');
    await until(() => App.proj.prospects.p1.status === 'todo', 'undo status toast');
    click('[data-act=pstatus][data-status=visited]');
    await until(() => App.proj.prospects.p1.status === 'visited', 'status visited again');
    const n = document.querySelector('#pnotes'); n.value = 'Call back Monday';
    n.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await until(() => outbox().some(o => o.e === 'prospect' && o.f === 'notes' && o.v === 'Call back Monday'), 'notes op');
    click('[data-act=back]');
    await until(() => /Visité \\(1\\)/i.test(text()), 'moved to Visité');
  `);

  await check('Sync now pushes the outbox and the PC receives the phone changes', `
    click('#tabs [data-tab=settings]');
    await until(() => /Test PC/.test(text()), 'settings');
    click('#view [data-act=sync-now]');
    await until(() => outbox().length === 0 && __test.relay.bundles.some(b => b.device === 'phone-dev'), 'outbox pushed');
    const { applied } = await __test.pcSync();
    const kinds = applied.map(o => o.k + ':' + (o.f || o.e)).sort();
    check(kinds.includes('visit:visit') && kinds.some(k => /set:(notes|status)/.test(k)), 'PC applied: ' + kinds);
    check(/Dernière synchro\\s*: (?!jamais)/.test(text()), 'last sync time missing: ' + text());
  `);

  await check('PC changes arrive on the phone (resume triggers a sync)', `
    __test.pcData.clients[1].notes = 'Updated on the PC';
    await __test.pc.sync({ getProj: () => SyncModel.project(__test.pcData) });
    for (const f of __test.appListeners.resume) f();
    await until(() => App.proj.clients.c2.notes === 'Updated on the PC', 'note from PC');
  `);

  await check('offline shows Hors ligne and keeps the edit; tapping the pill syncs again', `
    __test.relay.offline = true;
    click('#tabs [data-tab=prospects]');
    click('[data-act=open-prospect]');
    click('[data-act=pstatus][data-status=converted]');
    await until(() => App.proj.prospects.p1.status === 'converted', 'edit while offline');
    click('#chip');
    await until(() => document.querySelector('#chip').textContent === 'Hors ligne', 'pill Hors ligne: ' + document.querySelector('#chip').textContent);
    check(outbox().some(o => o.f === 'status' && o.v === 'converted'), 'edit lost while offline');
    __test.relay.offline = false;
    click('#chip');
    await until(() => outbox().length === 0 && document.querySelector('#chip').textContent === 'Synchronisé', 'resynced');
    click('[data-act=back]');
  `);

  await check('both token headers are sent', `
    check(__test.relay.badHeaders === 0, 'requests without matching Authorization and X-CC-Token: ' + __test.relay.badHeaders);
  `);

  await check('a rolled-back relay pauses sync with a clear message and keeps data', `
    click('#tabs [data-tab=settings]');
    const seq = __test.relay.seq, bundles = __test.relay.bundles.slice();
    __test.relay.seq = 0; __test.relay.bundles = [];
    click('#chip');
    await until(() => /Échec de la synchro/.test(document.querySelector('#chip').textContent), 'rollback pill: ' + document.querySelector('#chip').textContent);
    await until(() => /revenu à un état plus ancien/i.test(text()), 'rollback message: ' + text());
    check(Object.keys(App.proj.clients).length === 2 && __test.files.has('data.json'), 'data lost');
    __test.relay.seq = seq; __test.relay.bundles = bundles;
    click('#chip');
    await until(() => document.querySelector('#chip').textContent === 'Synchronisé', 'recovers: ' + document.querySelector('#chip').textContent);
  `);

  await check('a reset relay (new epoch) shows a clear message and keeps unsent changes', `
    click('#tabs [data-tab=prospects]');
    click('[data-act=open-prospect]');
    const cur = App.proj.prospects.p1.status;
    click('[data-act=pstatus][data-status=' + (cur === 'visited' ? 'todo' : 'visited') + ']');
    await until(() => outbox().length > 0, 'edit queued');
    __test.relay.epoch = 'fedcba9876543210';
    click('#tabs [data-tab=settings]');
    click('#chip');
    await until(() => /Échec de la synchro/.test(document.querySelector('#chip').textContent), 'reset pill: ' + document.querySelector('#chip').textContent);
    await until(() => /serveur de synchro a été réinitialisé/i.test(text()), 'reset message: ' + text());
    check(outbox().length > 0, 'unsent changes lost');
    __test.relay.epoch = '0123456789abcdef';
    click('#chip');
    await until(() => outbox().length === 0 && document.querySelector('#chip').textContent === 'Synchronisé', 'recovers: ' + document.querySelector('#chip').textContent);
  `);

  await check('a 200 answer that is not relay JSON keeps the outbox and shows an error', `
    click('#tabs [data-tab=prospects]');
    click('[data-act=open-prospect]');
    // Choosing the status a prospect already has is ignored by the app, so pick a different one.
    const next = App.proj.prospects.p1.status === 'visited' ? 'converted' : 'visited';
    click('[data-act=pstatus][data-status=' + next + ']');
    await until(() => App.proj.prospects.p1.status === next && outbox().length > 0, 'edit queued');
    const queued = outbox().length;
    __test.relay.htmlFor = 'push';
    const before = __test.relay.bundles.length;
    click('#tabs [data-tab=settings]');
    click('#chip');
    await until(() => /Échec de la synchro/.test(document.querySelector('#chip').textContent), 'error pill: ' + document.querySelector('#chip').textContent);
    await until(() => /réponse inattendue/i.test(text()), 'error message: ' + text());
    check(outbox().length === queued, 'outbox changed: ' + outbox().length + ' vs ' + queued);
    check(__test.relay.bundles.length === before, 'relay should not have received anything');
    __test.relay.htmlFor = null;
    click('#chip');
    await until(() => outbox().length === 0 && document.querySelector('#chip').textContent === 'Synchronisé', 'resynced: ' + document.querySelector('#chip').textContent);
    await __test.pcSync();
  `);

  await check('edits made during a sync are captured after it', `
    let release; __test.relay.gate = new Promise(r => { release = r; }); __test.relay.gateHit = false;
    click('#chip');
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
    click('#chip');
    await until(() => mode() === 'disconnected', 'disconnected screen');
    check(/déconnecté du PC/.test(text()), text());
    check(/Appairer à nouveau/.test(document.querySelector('#actions').innerText) && /Supprimer les données de ce téléphone/.test(text()), 'buttons missing: ' + document.querySelector('#actions').innerText + ' / ' + text());
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
    check(/autre PC/.test(document.querySelector('#modal').textContent), document.querySelector('#modal').textContent);
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
    await until(() => /Téléphone déconnecté/.test(document.querySelector('#toast').textContent), 'disconnected toast');
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
    check(document.querySelector('[data-act=appearance][data-v=dark]').getAttribute('aria-pressed') === 'true', 'dark button not pressed');
    click('[data-act=appearance][data-v=system]');
    check(!document.documentElement.dataset.theme, 'system should remove override');
  `);

  await check('Android back button closes the dialog, then the sheet, then the open item, then goes to Aujourd’hui', `
    const back = () => { for (const f of __test.appListeners.backButton) f(); };
    click('[data-act=disconnect]');
    await until(() => !document.querySelector('#modal').hidden, 'confirm dialog');
    back();
    check(document.querySelector('#modal').hidden && __test.files.has('data.json'), 'back should close the dialog and keep the data');
    App.go('today');
    await until(() => document.querySelector('#view .row'), 'rows');
    App.openClient('c1');
    await until(() => document.querySelector('#title').textContent === 'Boulangerie Exemple', 'client opens');
    click('[data-act=log-open]');
    await until(() => document.querySelector('#lv-note'), 'sheet');
    back();
    check(!document.querySelector('#lv-note') && App.ui.sel && App.ui.sel.id === 'c1', 'back should close only the sheet');
    back();
    check(!App.ui.sel && document.querySelector('#title').textContent === 'Aujourd’hui', 'back should close the open item');
    App.go('map');
    back();
    check(App.tab === 'today', 'back from another destination should go to Aujourd’hui, got ' + App.tab);
  `);

  // Expanded window (852x883): the list stays visible and the selected client opens in #detail next to it.
  win.setContentSize(852, 883);
  await new Promise(r => setTimeout(r, 400));
  await check('Expanded: selecting a client shows it in the detail pane with the list still visible', `
    await until(() => document.documentElement.dataset.size === 'expanded', 'expanded size, got ' + document.documentElement.dataset.size);
    App.go('today');
    await until(() => document.querySelector('#view .row'), 'rows');
    click('#view .row');
    await until(() => !document.querySelector('#detail').hidden && document.querySelector('#detail-title') && document.querySelector('#detail-title').textContent === 'Boulangerie Exemple', 'detail shows the client');
    check(!document.querySelector('#view').hidden && document.querySelectorAll('#view .row').length >= 2, 'list should stay visible');
    check(document.querySelector('#back').hidden, 'no back button needed when expanded');
    check(getComputedStyle(document.querySelector('#tabs')).display !== 'none', 'navigation rail missing');
  `);
  win.setContentSize(390, 800);
  await new Promise(r => setTimeout(r, 300));

  console.log(consoleErrors.length ? `FAIL console errors: ${consoleErrors.join(' || ')}` : 'PASS no console errors');
  if (consoleErrors.length) failed++;
  console.log(failed ? `DONE ${failed} failed` : 'DONE all passed');
  app.exit(failed ? 1 : 0);
});

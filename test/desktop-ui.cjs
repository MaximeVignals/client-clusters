// Actual Electron layout and keyboard checks, always with offline fictional demo data.
const fs = require('node:fs');
const path = require('node:path');
const { ipcMain } = require('electron');

module.exports = async function desktopUI(win, check, js) {
  const scale = Number(process.env.CLIENT_CLUSTERS_UI_SCALE || 1);
  const output = path.resolve(__dirname, '../.test-tmp/ui');
  fs.mkdirSync(output, { recursive: true });
  // Offscreen Electron uses DPR 1 regardless of Windows/CLI scaling. Override Chromium's
  // device metrics explicitly and assert DPR so this suite never silently tests the wrong scale.
  win.webContents.debugger.attach('1.3');
  const size = async (width, height) => {
    win.setContentSize(width, height);
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  };
  await size(1400, 880);
  const settle = () => new Promise(resolve => setTimeout(resolve, 120));
  const capture = async name => {
    await settle();
    fs.writeFileSync(path.join(output, `${name}-${scale}.png`), (await win.webContents.capturePage()).toPNG());
  };
  await js(`loadProspectDemo(); groupProspects(); state.tab = 'groups'; renderAll(); $('#toasts').replaceChildren();`);
  await check(`device scale ${scale}`, `check(Math.abs(devicePixelRatio - ${scale}) < .05, 'unexpected devicePixelRatio: ' + devicePixelRatio);`);
  for (const [width, height] of [[640, 480], [820, 620], [1024, 720], [1440, 900], [1920, 1080], [2560, 1080]]) {
    await size(width, height);
    await settle();
    for (const theme of ['light', 'dark']) {
      await js(`appAppearance.set('${theme}'); state.tab = 'groups'; state.selectedClientId = null; state.selectedGroupId = state.data.groups[0].id; renderAll(); renderDetail(); $('#view-list').click(); $('#list').scrollTop = 0;`);
      await settle();
      await check(`${width}×${height} ${theme}: navigation, commands and list bounds`, `
        const inside = (selector, parent = document.body) => {
          const el = $(selector), a = el.getBoundingClientRect(), b = parent.getBoundingClientRect();
          check(a.width > 0 && a.height > 0, selector + ' has no size');
          check(a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1, selector + ' outside parent ' + JSON.stringify(a.toJSON()));
        };
        inside('.topbar'); inside('.sidebar'); inside('#list', $('.sidebar'));
        for (const id of ['#btn-import', '#btn-add', '#btn-regroup', '#btn-export', '#btn-menu']) inside(id, $('.topbar'));
        check($('#list').clientHeight > 100, 'list has insufficient working space');
        check($('#list').scrollWidth <= $('#list').clientWidth + 1, 'list overflows horizontally');
        check($('.tabs').scrollWidth <= $('.tabs').clientWidth + 1, 'navigation clipped');
        check(document.documentElement.scrollWidth <= innerWidth, 'page overflows');
        check(getComputedStyle(document.documentElement).colorScheme === '${theme}', 'native controls have wrong theme');
        for (const tab of document.querySelectorAll('.tab')) {
          tab.click();
          check($('#list').scrollWidth <= $('#list').clientWidth + 1, tab.dataset.tab + ' list overflows horizontally');
        }
        $('#tab-groups').click(); $('#list').scrollTop = 0;
      `);
      if (scale === 1 && [640, 1440, 2560].includes(width)) await capture(`groups-${width}-${theme}`);
      await js(`selectClient(state.data.clients[0].id, { pan: true });`);
      await settle();
      await check(`${width}×${height} ${theme}: inspector and map resizing`, `
        const panel = $('#detail').getBoundingClientRect(), wrap = $('.map-wrap').getBoundingClientRect();
        check(wrap.width > 0 && wrap.height > 100, 'map hidden or too small');
        check(panel.left >= wrap.left && panel.right <= wrap.right + 1 && panel.bottom <= wrap.bottom + 1, 'inspector outside map');
        check($('#detail .detail-body').scrollWidth <= $('#detail .detail-body').clientWidth + 1, 'inspector content overflows');
        check(Math.abs(map.getSize().x - $('#map').clientWidth) < 2, 'Leaflet size stale');
        if (innerWidth >= 1500) check($('#map').getBoundingClientRect().right <= panel.left + 1, 'docked inspector covers map');
        if (innerWidth < 900) check(document.body.dataset.compactView === 'map', 'client did not reveal inspector');
      `);
      if (scale === 1 && [640, 1440, 2560].includes(width)) await capture(`inspector-${width}-${theme}`);
      await js('settingsDialog();');
      await settle();
      await check(`${width}×${height} ${theme}: scrollable settings with reachable actions`, `
        const box = $('#modal-box'), rect = box.getBoundingClientRect(), foot = $('.modal-foot').getBoundingClientRect();
        check(rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, 'dialog outside viewport');
        check(foot.bottom <= innerHeight && foot.height > 0, 'dialog actions inaccessible');
        check($('.modal-body').scrollWidth <= $('.modal-body').clientWidth + 1, 'settings overflow horizontally');
        check($('.layout').inert, 'modal background still interactive');
      `);
      if (scale === 1 && width === 640) await capture(`settings-${width}-${theme}`);
      await js('modalCtx.close();');
      await settle();
    }
  }
  await size(1440, 900);
  await settle();
  await js(`$('#view-list').click(); state.tab = 'clients'; renderAll();`);
  await check('keyboard search, navigation, resizer, menus and dialog focus', `
    const key = (key, options = {}) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
    key('f', { ctrlKey: true }); check(document.activeElement === $('#search'), 'Ctrl+F failed');
    key('3', { ctrlKey: true }); check(state.tab === 'planned', 'Ctrl+3 failed');
    key('ArrowRight'); check(state.tab === 'prospecting', 'tab arrow navigation failed');
    key('1', { ctrlKey: true }); check(state.tab === 'groups', 'Ctrl+1 failed');
    const splitter = $('#sidebar-splitter'); splitter.focus(); const before = $('.sidebar').offsetWidth;
    key('ArrowRight'); check($('.sidebar').offsetWidth > before, 'keyboard pane resizing failed');
    $('#btn-menu').focus(); key('ArrowDown');
    check(!$('#menu').hidden && $('#menu').contains(document.activeElement), 'keyboard menu opening failed');
    key('End'); check(document.activeElement === $('#menu button:last-child'), 'menu End failed');
    key('Escape'); check($('#menu').hidden && document.activeElement === $('#btn-menu'), 'menu dismissal failed');
    $('#btn-add').focus(); addClientDialog(); await new Promise(r => setTimeout(r, 70));
    check($('#modal-box').contains(document.activeElement), 'dialog focus missing');
    check($('#modal-box').getAttribute('aria-labelledby') === 'modal-title', 'dialog has no accessible title');
    const buttons = [...$('#modal-box').querySelectorAll('button')]; buttons.at(-1).focus();
    key('Tab'); check($('#modal-box').contains(document.activeElement), 'focus escaped dialog');
    modalCtx.close(); await new Promise(r => setTimeout(r, 70));
    check(document.activeElement === $('#btn-add') && !$('.layout').inert, 'focus not restored');
    const row = $('#list [data-client]') || $('#list [data-group]');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 300 }));
    check(!$('.context-menu').hidden && $('.context-menu').contains(document.activeElement), 'context menu not keyboard reachable');
    key('Escape');
  `);
  // ---- Phone sync settings, with the main-process side replaced by a stub ----
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const sync = { enabled: false, phones: [{ id: 'a'.repeat(32), name: 'Fictional phone', lastSeen: 0 }], pauses: [], acks: [], answers: [], copies: 0, rekeys: 0 };
  const status = () => ({ enabled: sync.enabled, url: 'https://example.test/sync/', state: sync.enabled ? 'idle' : 'off', error: null, lastSyncAt: Date.now(), paused: false });
  const stubs = {
    'sync:status': () => status(),
    'sync:pause': (_e, p) => { sync.pauses.push(p); return status(); },
    'sync:test': () => ({ ok: true, claimed: false }),
    'sync:enable': (_e, o) => { if (!o.url || !o.setupCode) return { ok: false, error: 'missing' }; sync.enabled = true; return { ok: true, status: status() }; },
    'sync:disable': () => { sync.enabled = false; return { ok: true, status: status() }; },
    'sync:listPhones': () => ({ ok: true, phones: sync.phones }),
    'sync:addPhone': () => ({ ok: true, qrDataUrl: PNG }), // the text of the code never goes to the window
    'sync:copyPairing': () => { sync.copies++; return { ok: true, clearsInMs: 60000 }; },
    'sync:clearPairing': () => true,
    'sync:applied': (_e, id, ok) => { sync.acks.push([id, ok]); return true; },
    'sync:confirmDeletes': (_e, answer) => { sync.answers.push(answer); return { ok: true, restored: answer === false ? 8 : 0 }; },
    'sync:rekey': () => { sync.rekeys++; return { ok: true, status: status() }; },
    'sync:revokePhone': () => ({ ok: true }),
    'sync:now': () => ({ ok: true, ...status() }),
  };
  for (const [name, fn] of Object.entries(stubs)) { ipcMain.removeHandler(name); ipcMain.handle(name, fn); }
  await js(`state.tab = 'groups'; renderAll(); settingsDialog();`); await settle();
  await check('sync settings, off: address, setup code, test, turn on, help link', `
    for (const sel of ['#sync-url', '#sync-code', '[data-sync="test"]', '[data-sync="enable"]', 'a[data-sync="help"]']) check($(sel), sel + ' missing');
    check($('#sync-chip').hidden, 'sync chip visible while sync is off');
    check($('#sync-section').getBoundingClientRect().right <= $('.modal-body').getBoundingClientRect().right + 1, 'sync section overflows');
    $('#sync-url').value = 'https://example.test/sync/'; $('#sync-code').value = 'fictional-code';
    $('[data-sync="enable"]').click();
    for (let i = 0; i < 100 && !$('[data-sync="add"]'); i++) await new Promise(r => setTimeout(r, 20));
    check($('[data-sync="add"]'), 'enabled state did not appear');
  `);
  await check('sync settings, on: status chip, phones list, Add a phone shows a loaded QR image', `
    for (let i = 0; i < 100 && !$('.phone-list'); i++) await new Promise(r => setTimeout(r, 20));
    check(/Fictional phone/.test($('.phone-list').textContent) && $('[data-sync="revoke"]'), 'phone list missing');
    check(!$('#sync-chip').hidden && /Synced/.test($('#sync-chip').textContent), 'chip not showing Synced: ' + $('#sync-chip').textContent);
    $('[data-sync="add"]').click(); $('#sync-name').value = 'Test phone'; $('[data-sync="create"]').click();
    for (let i = 0; i < 100 && !$('.sync-pair img'); i++) await new Promise(r => setTimeout(r, 20));
    const img = $('.sync-pair img'); check(img, 'QR image missing');
    for (let i = 0; i < 100 && !img.complete; i++) await new Promise(r => setTimeout(r, 20));
    check(img.naturalWidth > 0, 'QR image did not load (is data: allowed by the CSP?)');
    check(!$('#sync-pair-code') && !/CCSYNC1/.test($('#sync-section').innerHTML), 'pairing code text is in the page');
    check($('[data-sync="copy"]'), 'copy button missing');
    $('[data-sync="copy"]').click(); await new Promise(r => setTimeout(r, 100));
    check(/Anyone with this code can read your client data/.test($('#sync-section').textContent), 'warning missing');
    const r = $('#modal-box').getBoundingClientRect(); check(r.right <= innerWidth && r.bottom <= innerHeight, 'dialog outside viewport');
    check($('.modal-body').scrollWidth <= $('.modal-body').clientWidth + 1, 'sync pairing overflows horizontally');
  `);
  await capture('sync-settings');
  await js('modalCtx.close();'); await settle();
  await check('changes from the phone are merged, saved once and summarised', `
    const c = state.data.clients[0], before = c.visits.length;
    await SyncUI.incoming({ id: 41, ops: [{ k: 'visit', e: 'visit', id: 'phone-v1', c: c.id, t: 1, v: { id: 'phone-v1', date: '2026-11-09', status: 'done', type: 'visit', outcome: '', note: 'fictional' } },
      { k: 'set', e: 'client', id: c.id, f: 'notes', v: 'phone note', t: 2 }] });
    const c2 = state.data.clients[0]; // the merge works on a copy, so the object is a new one
    check(c2.visits.length === before + 1 && c2.notes === 'phone note', 'ops not applied');
    check([...document.querySelectorAll('.toast')].some(t => /From your phone: 1 visit, 1 note/.test(t.textContent)), 'summary toast missing');
    await SyncUI.incoming({ id: 42, ops: [{ k: 'visit', e: 'visit', id: 'phone-v2', c: 'gone-client', t: 3, restore: true, cl: { name: 'Café Fictif' }, v: { id: 'phone-v2', date: '2026-11-09', status: 'done', type: 'visit', outcome: '', note: '' } }] });
    check(state.data.clients.some(x => x.id === 'gone-client'), 'client not restored');
    check([...document.querySelectorAll('.toast')].some(t => /Restored Café Fictif/.test(t.textContent)), 'restored toast missing');
    state.data.clients = state.data.clients.filter(x => x.id !== 'gone-client'); c2.visits = c2.visits.filter(v => v.id !== 'phone-v1'); c2.notes = ''; renderAll();
    $('#toasts').replaceChildren();
  `);
  await check('a merge that throws leaves the data untouched and is not acknowledged', `
    const before = state.data, n = state.data.clients.length, orig = SyncOps.applyToData;
    SyncOps.applyToData = d => { d.clients.length = 0; throw new Error('boom'); };
    try { await SyncUI.incoming({ id: 43, ops: [{ k: 'set', e: 'client', id: 'x', f: 'notes', v: 'y', t: 1 }] }); } finally { SyncOps.applyToData = orig; }
    check(state.data === before && state.data.clients.length === n, 'data was changed by a failed merge');
    $('#toasts').replaceChildren();
  `);
  if (sync.acks.map(a => a.join(':')).join() !== '41:true,42:true,43:false') throw new Error('incoming changes must be acknowledged after saving: ' + JSON.stringify(sync.acks));
  if (sync.copies !== 1) throw new Error('copy did not go through the main process');
  await check('the deletion question offers the two answers and reports the choice', `
    const p = SyncUI.confirmDeletes({ clients: 8, prospects: 0, visits: 21 });
    await new Promise(r => setTimeout(r, 100));
    check($('#modal-title').textContent === 'Also remove 8 clients / 21 visits from your phones?', 'title: ' + $('#modal-title').textContent);
    const labels = [...document.querySelectorAll('#modal-box .modal-foot .btn')].map(b => b.textContent);
    check(labels.includes('Remove from phones too') && labels.includes('Keep them (restore here)'), 'buttons: ' + labels);
    [...document.querySelectorAll('#modal-box .modal-foot .btn')].find(b => /Keep them/.test(b.textContent)).click();
    await p;
    check($('#modal').hidden, 'dialog still open');
    const q = SyncUI.confirmDeletes({ clients: 6, prospects: 0, visits: 0 });
    await new Promise(r => setTimeout(r, 100));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await q;
  `);
  if (JSON.stringify(sync.answers) !== '[false,null]') throw new Error('answers: ' + JSON.stringify(sync.answers));
  sync.enabled = false;
  await js(`appAppearance.set('light'); state.tab = 'planned'; renderAll(); renderDetail();`);
  await capture('planned');
  await js(`loadProspectDemo(); groupProspects(); state.tab = 'prospecting'; renderAll(); renderDetail();`);
  await capture('prospects');
  await js('planDayDialog();'); await settle();
  await check('planner form does not clip', `check($('.modal-body').scrollWidth <= $('.modal-body').clientWidth + 1, 'planner overflow');`);
  await capture('planner'); await js('modalCtx.close();');
  for (const [width, height] of [[640, 480], [1440, 900]]) {
    await size(width, height); await settle();
    for (const [name, open] of [
      ['add client', 'addClientDialog()'], ['import mapping', 'await openImport()'],
      ['log visits', "visitDialog({ ids: state.data.clients.slice(0, 6).map(c => c.id) })"],
      ['plan visits', "visitDialog({ ids: state.data.clients.slice(0, 6).map(c => c.id), mode: 'plan' })"],
      ['day planner', 'planDayDialog()'], ['backup', 'backupDialog()'],
      ['hours overview', 'hoursOverview()'], ['edit hours', 'editHours(state.data.clients[0])'],
      ['address review', 'reviewUnlocated()'],
    ]) {
      await js(`(async () => { ${open}; })()`); await settle();
      await check(`${width}×${height}: ${name} dialog`, `
        const box = $('#modal-box').getBoundingClientRect();
        check(!$('#modal').hidden, 'dialog not opened');
        check(box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight, 'dialog outside viewport ' + JSON.stringify(box.toJSON()));
        check($('.modal-body').scrollWidth <= $('.modal-body').clientWidth + 1, 'dialog content overflows horizontally');
        check($('.modal-foot').getBoundingClientRect().bottom <= innerHeight, 'dialog actions clipped');
      `);
      if (scale === 1 && width === 640) await capture(`dialog-${name.replaceAll(' ', '-')}-${width}`);
      await js('if (modalCtx) modalCtx.close();'); await settle();
    }
  }
  await size(640, 480); await settle();
  await check('compact first-run onboarding', `
    const demo = structuredClone(state.data); state.tab = 'groups'; loadData({});
    check(!$('#empty').hidden && document.body.dataset.compactView === 'map', 'first-run welcome not visible');
    check($('.empty-card').scrollWidth <= $('.empty').clientWidth, 'welcome overflows horizontally');
    loadData(demo);
  `);
  await js(`state.selectedClientId = null; state.tab = 'groups'; renderAll(); renderDetail();`);
  win.webContents.debugger.detach();
};

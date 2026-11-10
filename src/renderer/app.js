/* Client Clusters — renderer: render all, loading data and startup */
'use strict';

// =====================================================================
// Render all & init
// =====================================================================
function renderAll() {
  derive();
  setTimeout(fillMissingTowns, 0);
  renderStats(); renderTabs(); renderBanners(); renderList(); renderMap(); renderLegend(); renderSelectBar();
  $('#empty').hidden = state.data.clients.length > 0 || state.tab === 'prospecting';
  $('#btn-regroup').disabled = !state.data.clients.some(hasLoc);
  $('#btn-export').disabled = !state.data.clients.length;
  const lb = S().lastBackupAt;
  window.DesktopUI?.refresh();
  $('#menu [data-act="backup"]').innerHTML = `Save a backup…${lb ? `<small>last: ${esc(fmtAgo(daysSince(lb)).toLowerCase())}</small>` : ''}`;
}

function loadData(data) {
  const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  settings.tiers = Object.fromEntries(Object.entries(DEFAULT_TIERS).map(([k, d]) => [k, { ...d, ...((data.settings?.tiers || {})[k] || {}) }]));
  state.data = {
    version: 1, demo: !!data.demo,
    settings,
    clients: (data.clients || []).map(c => normalizeVisits({ visits: [], extra: {}, notes: '', address: '', postcode: '', city: '', country: '', tier: '', ...c })),
    groups: data.groups || [],
    // prospecting.js loads after this file; keep the data as is if it failed to load.
    prospecting: typeof normalizeProspecting === 'function' ? normalizeProspecting(data.prospecting) : data.prospecting,
  };
  state.selectedClientId = null; state.selectedGroupId = null; state.selectedDay = null; state.selection.clear();
  renderAll(); renderDetail();
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (modalCtx) { modalCtx.close(); return; }
  if (state.placingClientId) { stopPlacing(); return; }
  if (state.selectedClientId) { state.selectedClientId = null; renderAll(); renderDetail(); return; }
  if (state.selection.size) clearSelection();
});

$('#btn-import').addEventListener('click', openImport);
$('#empty-import').addEventListener('click', openImport);
$('#empty-demo').addEventListener('click', loadDemo);
$('#empty-restore').addEventListener('click', restoreBackup);
$('#btn-add').addEventListener('click', addClientDialog);
$('#btn-regroup').addEventListener('click', () => regroup());
$('#btn-export').addEventListener('click', e => { e.stopPropagation(); $('#menu').hidden = true; $('#export-menu').hidden = !$('#export-menu').hidden; });
$('#export-menu').addEventListener('click', e => {
  const act = e.target.closest('[data-exp]')?.dataset.exp;
  $('#export-menu').hidden = true;
  if (act === 'xlsx') exportExcel();
  if (act === 'kmz') exportKmz();
});
document.addEventListener('click', () => { $('#export-menu').hidden = true; });

// ---------- Recovery (the data file could not be read) ----------
// Until the user chooses, nothing is saved (see save() in state.js), so the damaged file and backups stay safe.
function startRecovery(info) {
  state.recovery = info;
  window.SyncUI?.pause(true); // no phone changes are merged or sent while the data file is in question
  loadData({});
  recoveryDialog();
}
// Resume locating addresses left over from last time, then Google pages not looked up yet.
function resumeBackgroundWork(delay) {
  if (state.derived.pending.length) geocodeClients(state.derived.pending).then(afterLocate);
  else setTimeout(autoLookupGoogle, delay);
}
function recoveryDialog() {
  const backups = state.recovery?.backups || [];
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  const label = b => `${esc(fmtDate(b.date))} — ${plural(b.clients, 'client')}, ${plural(b.visits, 'visit')}`;
  const buttons = [
    {
      label: 'Start empty',
      async fn(close) {
        if (!(await confirmDialog('Start with an empty list?', 'The app will start with no clients. You can still import a list or restore a backup later. The damaged file stays in the backups folder. If phone sync is on, clients and visits your phones still have are brought back here, not deleted there.', 'Start empty', true))) return;
        // Save at once: anything imported while the choice was pending has not been written yet.
        state.recovery = null; close(); await flushSave(); renderAll();
        // Phones and the sync copy may still have clients: they come back here instead of being deleted there.
        await window.SyncUI?.rebase(); window.SyncUI?.pause(false);
      },
    },
    { label: 'Open a backup file…', fn(close) { close(); restoreBackup(); } },
  ];
  if (backups.length) buttons.push({
    label: 'Restore this backup', primary: true,
    async fn(close, box) {
      const err = t => { box.querySelector('#rec-err').textContent = t; };
      const b = backups.find(x => x.file === box.querySelector('input[name="rec"]:checked')?.value);
      if (!b) return err('Choose a backup first.');
      let data;
      try { data = await window.api.restoreDailyBackup(b.file); } catch (e) { return err(e.message || 'That backup could not be restored.'); }
      state.recovery = null; close();
      loadData(data); await flushSave(); fitAll();
      await window.SyncUI?.rebase(); window.SyncUI?.pause(false); // newer data on the phones is merged back, never deleted
      toast(`Backup of ${fmtDate(b.date)} restored: ${plural(state.data.clients.length, 'client')}.`);
      resumeBackgroundWork(1500);
    },
  });
  showModal({
    title: 'Your data could not be read',
    desc: 'The app could not open its data file. A copy of the damaged file was kept in the backups folder, and nothing is saved until you make a choice.',
    render: () => `
      <p class="note">${esc(state.recovery?.__error || '')}</p>
      ${backups.length ? `<div class="field" style="margin-top:12px"><label>Restore a daily backup</label>
        <div class="radio-list">${backups.map((b, i) => `<label><input type="radio" name="rec" value="${esc(b.file)}"${i === 0 ? ' checked' : ''}><span>${label(b)}</span></label>`).join('')}</div></div>`
        : '<p style="margin-top:12px">No daily backup is available.</p>'}
      <div class="err" id="rec-err"></div>`,
    buttons,
  });
}

(async function init() {
  const data = await window.api.loadData();
  try { state.googleKey = await window.api.googleKeyStatus(); } catch { /* keep default */ }
  window.SyncUI?.start();
  if (data && data.__error) { startRecovery(data); return; }
  loadData(data || {});
  window.SyncUI?.pause(false); // data is in the window: phone sync may start
  fitAll();
  resumeBackgroundWork(1500);
})();

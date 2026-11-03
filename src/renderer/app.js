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

(async function init() {
  const data = await window.api.loadData();
  if (data && data.__error) toast(data.__error, { error: true });
  try { state.googleKey = await window.api.googleKeyStatus(); } catch { /* keep default */ }
  loadData(data && !data.__error ? data : {});
  fitAll();
  // Resume locating addresses left over from last time, then Google pages not looked up yet.
  if (state.derived.pending.length) geocodeClients(state.derived.pending).then(afterLocate);
  else setTimeout(autoLookupGoogle, 1500);
})();

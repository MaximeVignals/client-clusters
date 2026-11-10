/* Client Clusters — renderer: backups and restore */
'use strict';

// =====================================================================
// Backups: move everything to another computer (or keep a copy)
// =====================================================================
function backupDialog() {
  const hasKey = state.googleKey.hasKey;
  const visits = state.data.clients.reduce((n, c) => n + (c.visits || []).length, 0);
  const pros = state.data.prospecting;
  showModal({
    title: 'Save a backup',
    desc: 'One file with everything: clients, visits, groups, opening hours, settings and home address. Copy it to the other computer (USB key, OneDrive, e-mail…) and open it there with <b>… → Restore a backup…</b>',
    render: () => `
      <p style="margin:0 0 10px"><b>${state.data.clients.length}</b> clients · <b>${visits}</b> visits · <b>${state.data.groups.length}</b> groups${S().lastBackupAt ? ` · last backup ${fmtDate(S().lastBackupAt)}` : ''}</p>
      ${pros ? `<label class="check" style="margin-bottom:8px"><input type="checkbox" id="b-pros" checked> Include my prospecting map (${pros.prospects.length} prospect${pros.prospects.length === 1 ? '' : 's'}${pros.areas.length ? `, ${pros.areas.length} area${pros.areas.length === 1 ? '' : 's'}` : ''})</label>` : ''}
      ${hasKey ? `
        <label class="check"><input type="checkbox" id="b-key"> Include my Google API key, protected by a password</label>
        <div id="b-pass" class="field-row field" style="margin-top:8px;grid-template-columns:1fr 1fr" hidden>
          <input type="password" id="b-p1" placeholder="Password" autocomplete="new-password">
          <input type="password" id="b-p2" placeholder="Same password again" autocomplete="new-password">
        </div>
        <p class="note">Without it, paste the key again in Settings on the other computer. The key is never written to the file without a password.</p>` : ''}
      <div class="err" id="b-err"></div>`,
    buttons: [{ label: 'Cancel', action: 'close' }, { label: 'Save backup…', primary: true, action: 'ok' }],
    onChange(e, rerender, box) {
      if (e.target.id === 'b-key') { box.querySelector('#b-pass').hidden = !e.target.checked; if (e.target.checked) box.querySelector('#b-p1').focus(); }
    },
    async onOk(close, box) {
      const err = m => { box.querySelector('#b-err').textContent = m; };
      const withKey = !!box.querySelector('#b-key')?.checked;
      const pw = withKey ? box.querySelector('#b-p1').value : '';
      if (withKey) {
        if (pw.length < 6) return err('Choose a password of at least 6 characters for the key.');
        if (pw !== box.querySelector('#b-p2').value) return err('The two passwords are different.');
      }
      flushSave();
      const data = box.querySelector('#b-pros')?.checked === false ? { ...state.data, prospecting: undefined } : state.data;
      let r;
      try { r = await window.api.saveBackup({ data, includeKey: withKey, password: pw }); } catch (e) { return err('The backup could not be saved: ' + e.message); }
      if (!r) return; // save dialog cancelled
      close();
      S().lastBackupAt = todayISO(); save(); renderAll();
      toast(`Backup saved: ${r.path.split(/[\\/]/).pop()} (${r.size < 1048576 ? Math.max(1, Math.round(r.size / 1024)) + ' KB' : (r.size / 1048576).toFixed(1) + ' MB'}).`);
    },
  });
}

// Put a backup's clients and visits into the current list without removing anything.
function mergeBackup(incoming) {
  const local = state.data;
  const keyOf = c => norm(c.name) + '|' + norm(c.address) + '|' + norm(c.postcode) + '|' + norm(c.city);
  const byId = new Map(local.clients.map(c => [c.id, c]));
  const byKey = new Map(local.clients.map(c => [keyOf(c), c]));
  const groupIds = new Set(local.groups.map(g => g.id));
  const fresh = g => (g?.hours?.updatedAt || g?.checkedAt || '') + (g?.matchedBy === 'user' ? '~' : '');
  const res = { added: 0, updated: 0, visits: 0, newClients: [] };
  for (const raw of incoming.clients || []) {
    const inc = { visits: [], extra: {}, notes: '', address: '', postcode: '', city: '', country: '', ...raw };
    const ex = byId.get(inc.id) || byKey.get(keyOf(inc));
    if (!ex) {
      normalizeVisits(inc);
      if (byId.has(inc.id)) inc.id = uid();
      if (!groupIds.has(inc.groupId)) inc.groupId = null;
      local.clients.push(inc); byId.set(inc.id, inc); byKey.set(keyOf(inc), inc);
      res.added++; res.visits += inc.visits.length; res.newClients.push(inc);
      continue;
    }
    let changed = false;
    normalizeVisits(ex); normalizeVisits(inc);
    const visitKey = v => JSON.stringify([v.date, v.note || '', v.type || 'visit', vStatus(v), v.outcome || '']);
    const same = new Set(ex.visits.map(visitKey));
    for (const v of inc.visits) {
      const mine = ex.visits.find(x => x.id === v.id);
      // Same visit on both computers: a planned visit confirmed (or cancelled) on the other one is taken over.
      if (mine) { if (vStatus(mine) === 'planned' && vStatus(v) !== 'planned') { Object.assign(mine, v); changed = true; } continue; }
      if (same.has(visitKey(v))) continue;
      ex.visits.push(v); same.add(visitKey(v)); res.visits++; changed = true;
    }
    if (!ex.tier && inc.tier) { ex.tier = inc.tier; changed = true; }
    const n = (inc.notes || '').trim();
    if (n && !(ex.notes || '').includes(n)) { ex.notes = ex.notes ? `${ex.notes}\n${n}` : n; changed = true; }
    if (!hasLoc(ex) && hasLoc(inc)) { ex.lat = inc.lat; ex.lng = inc.lng; ex.geo = inc.geo; changed = true; }
    if (inc.gbp && fresh(inc.gbp) > fresh(ex.gbp)) { ex.gbp = inc.gbp; changed = true; }
    for (const [k, v] of Object.entries(inc.extra || {})) if (!(k in (ex.extra || {}))) { ex.extra = { ...(ex.extra || {}), [k]: v }; changed = true; }
    if (changed) res.updated++;
  }
  if (!homeOf() && incoming.settings?.home) S().home = incoming.settings.home;
  local.demo = false;
  return res;
}

async function restoreBackup() {
  let b;
  try { b = await window.api.openBackup(); } catch (e) { toast(e.message, { error: true }); return; }
  if (!b) return;
  const m = b.manifest || {};
  const localCount = state.data.demo ? 0 : state.data.clients.length;
  const st = { mode: localCount ? 'merge' : 'replace', password: '', prospects: !!b.data.prospecting };
  const localPros = state.data.prospecting?.prospects.length || 0;
  const when = m.createdAt ? new Date(m.createdAt) : null;
  const newer = m.appVersion && b.thisAppVersion && m.appVersion.localeCompare(b.thisAppVersion, undefined, { numeric: true }) > 0;
  showModal({
    title: 'Restore a backup',
    desc: `From <b>${esc(b.fileName)}</b>`,
    render: () => `
      <dl class="extra backup-sum">
        <dt>Saved</dt><dd>${when ? esc(when.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })) : '—'}${m.computer ? ` on <b>${esc(m.computer)}</b>` : ''}</dd>
        <dt>Contains</dt><dd>${m.clients} clients · ${m.visits} visits · ${m.groups} groups${m.prospects ? ` · ${m.prospects} prospects` : ''}</dd>
        ${m.format === 0 ? '<dt>Note</dt><dd>Backup from an older version: clients, visits, groups and settings (no Google key).</dd>' : ''}
      </dl>
      ${newer ? `<p class="note bad">This backup comes from a newer version of the app (${esc(m.appVersion)}). Update this computer first if anything looks wrong.</p>` : ''}
      ${localCount ? `
        <div class="field" style="margin-top:12px"><label>This computer already has ${localCount} clients</label>
          <div class="radio-list">
            <label><input type="radio" name="rmode" value="merge"${st.mode === 'merge' ? ' checked' : ''}><span><b>Combine</b> — add the backup's clients and visits to the ones here. Nothing is removed; clients found on both are joined and keep the visits of both.</span></label>
            <label><input type="radio" name="rmode" value="replace"${st.mode === 'replace' ? ' checked' : ''}><span><b>Replace</b> — this computer gets exactly the backup's data (clients, visits, groups and settings). What is here now is removed.</span></label>
          </div></div>` : ''}
      ${b.data.prospecting ? `<label class="check" style="margin-top:12px"><input type="checkbox" id="r-pros"${st.prospects ? ' checked' : ''}> Restore the prospecting map${localPros ? ` (with Combine, joined with the ${localPros} prospects here; with Replace, replaces them)` : ''}</label>` : ''}
      ${b.hasKey ? `
        <div class="field" style="margin-top:12px"><label for="r-pass">The backup includes a Google API key — its password</label>
          <input type="password" id="r-pass" placeholder="Leave empty to skip the key" autocomplete="off"></div>` : ''}
      <p class="note">A copy of the data on this computer is kept in the backups folder (… → Open data folder) before anything changes.</p>
      <div class="err" id="r-err"></div>`,
    buttons: [{ label: 'Cancel', action: 'close' }, { label: 'Restore', primary: true, action: 'ok' }],
    onChange(e) {
      if (e.target.name === 'rmode') st.mode = e.target.value;
      if (e.target.id === 'r-pros') st.prospects = e.target.checked;
    },
    async onOk(close, box) {
      const err = t => { box.querySelector('#r-err').textContent = t; };
      const pw = box.querySelector('#r-pass')?.value || '';
      if (pw) { const k = await window.api.unlockBackupKey(pw); if (!k.ok) return err(k.error + ' Try again, or leave it empty to restore without the key.'); }
      if (st.mode === 'replace' && localCount && !(await confirmDialog('Replace the data on this computer?', `The ${localCount} clients here and their visits will be replaced by the ${m.clients} clients of the backup. A safety copy is kept in the backups folder.${window.SyncUI?.enabled() ? ' Phone sync is on: visits and clients your phones have that the backup does not are brought back here instead of being deleted on the phones.' : ''}`, 'Replace', true))) return;
      flushSave();
      const a = await window.api.applyBackup({ current: state.data.demo ? null : state.data });
      if (!a.ok) return err(a.error || 'The backup could not be restored.');
      const wasRecovery = !!state.recovery;
      // Replacing the data (or rebuilding it from nothing): phone sync must not see the half-way state, or the
      // difference would be sent to the phones as deletions. It stays paused until the data is compared (rebase).
      const needRebase = st.mode === 'replace' || wasRecovery;
      if (needRebase) await window.SyncUI?.pause(true);
      state.recovery = null; // the backup is in; from now on the data can be saved
      close();
      let msg;
      if (st.mode === 'replace') {
        const keepPros = state.data.prospecting;
        loadData(st.prospects ? b.data : { ...b.data, prospecting: keepPros });
        msg = `Backup restored: ${state.data.clients.length} clients and their visits.`;
      } else {
        const r = mergeBackup(b.data);
        if (st.prospects) mergeProspecting(b.data.prospecting);
        if (state.data.groups.length) assignToNearest(r.newClients.filter(c => hasLoc(c) && !c.groupId), { quiet: true });
        else if (state.data.clients.some(hasLoc)) await regroup({ confirm: false });
        state.selectedClientId = null; state.selectedGroupId = null;
        renderAll(); renderDetail();
        msg = `Backup combined: ${r.added} new client${r.added === 1 ? '' : 's'}, ${r.visits} visit${r.visits === 1 ? '' : 's'} added${r.updated ? `, ${r.updated} client${r.updated === 1 ? '' : 's'} updated` : ''}.`;
      }
      if (a.keyMasked) { state.googleKey = { hasKey: true, masked: a.keyMasked }; msg += ' Google API key added.'; }
      else if (a.keyError) msg += ' Google API key not added: ' + a.keyError;
      await flushSave(); renderAll(); fitAll();
      toast(msg);
      // The data was replaced (or rebuilt from nothing): phones and the sync copy may have newer things; bring them back, never delete them there.
      if (needRebase) { await window.SyncUI?.rebase(); await window.SyncUI?.pause(false); }
      if (state.derived.pending.length) geocodeClients(state.derived.pending).then(afterLocate);
      else setTimeout(autoLookupGoogle, 800);
    },
  });
}

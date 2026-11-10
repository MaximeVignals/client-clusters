/* Client Clusters — renderer: phone sync (Settings section, top-bar status, changes arriving from the phone).
   The relay admin token and the encryption key stay in the main process. This window gets status text, the changes it
   has to apply, and, while a phone is being added, the pairing QR picture (which does contain the phone's token and the
   key). The text of the pairing code stays in the main process too: "Copy code" is done there, and the clipboard is
   cleared 60 seconds later if nothing else was copied. */
'use strict';

window.SyncUI = (function () {
  const api = () => window.api;
  let info = { enabled: false, state: 'off', error: null, lastSyncAt: 0, url: '' };
  let phones = null;       // null = not loaded, [] = none, or an array
  let phonesError = '';
  let view = { mode: 'main', msg: '', busy: false, code: null }; // 'main' | 'naming' | 'code'
  let codeTimer = null;
  let off = { url: '', code: '', msg: '', ok: true };           // off-state form drafts

  const SETUP_LINK = 'https://github.com/MaximeVignals/client-clusters#sync-and-android';
  const ERRORS = {
    disconnected: 'Server rejected the token',
    'key-mismatch': 'Sync key mismatch — turn sync off and on again',
    'relay-full': 'The server storage is full',
    'too-large': 'A change is too large for the server',
    'not-initialised': 'Sync is not set up yet',
    'window-not-ready': 'Waiting for the window',
    'window-timeout': 'The window did not confirm in time; trying again later',
    'window-refused': 'The window could not take the changes; trying again later',
    'relay-reset': 'The sync server was reset or replaced. Use "Reset sync key" in Settings to start again',
    'relay-rollback': 'The sync server went back to an older state. Use "Reset sync key" in Settings to start again',
    'bad-response': 'The server answered something unexpected (is the address right?)',
    'data-unavailable': 'Your data could not be read, sync is waiting',
  };
  const errText = e => ERRORS[e] || e || 'Error';
  const section = () => document.getElementById('sync-section');

  function chipText(s) {
    if (s.paused && s.state !== 'error') return 'Sync paused';
    if (s.needsConfirm && s.state !== 'error') return 'Waiting for your decision';
    if (s.state === 'syncing') return 'Syncing…';
    if (s.state === 'offline') return 'Offline';
    if (s.state === 'error') return errText(s.error);
    return 'Synced';
  }

  function paintChip() {
    const chip = document.getElementById('sync-chip');
    if (!chip) return;
    chip.hidden = !info.enabled;
    if (!info.enabled) return;
    chip.textContent = chipText(info);
    chip.className = 'sync-chip ' + (info.paused ? 'idle' : info.state);
    chip.title = 'Phone sync: ' + chipText(info) + (info.lastSyncAt ? ' (last sync ' + new Date(info.lastSyncAt).toLocaleString() + ')' : '');
  }

  function setInfo(s) {
    info = Object.assign({ enabled: false, state: 'off', error: null, lastSyncAt: 0, url: '' }, s || {});
    paintChip();
    if (section()?.isConnected) {
      // Don't wipe what the user is typing while the status text changes.
      const st = section().querySelector('[data-sync-status]');
      if (st && info.enabled) st.textContent = statusLine();
      else if (!info.enabled !== !section().querySelector('[data-sync="enable"]')) paint();
    }
  }

  async function refresh() {
    try { setInfo(await api().syncStatus()); } catch { setInfo(null); }
  }

  const when = ms => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
  const statusLine = () => `${chipText(info)} · last sync: ${when(info.lastSyncAt)}`;

  // ---------- Settings section ----------
  function html() {
    if (!info.enabled) {
      return `<label for="sync-url">Phone sync</label>
        <p class="note" style="margin-top:0">Keep the Client Clusters Android app up to date with your visits through a small server you host yourself. Everything is encrypted before it leaves this computer.</p>
        <div class="home-row"><input id="sync-url" value="${esc(off.url)}" placeholder="Server address, e.g. https://example.com/sync/" autocomplete="off" spellcheck="false"><button class="btn" data-sync="test"${view.busy ? ' disabled' : ''}>Test connection</button></div>
        <div class="home-row" style="margin-top:6px"><input id="sync-code" type="password" value="${esc(off.code)}" placeholder="Setup code (from the server's config file)" autocomplete="off" spellcheck="false"><button class="btn primary" data-sync="enable"${view.busy ? ' disabled' : ''}>${view.busy ? 'Working…' : 'Turn on sync'}</button></div>
        <p class="note ${off.ok ? '' : 'bad'}" id="sync-msg" role="status">${esc(off.msg)}</p>
        <p class="note"><a href="${SETUP_LINK}" data-sync="help">How to set up a server</a></p>`;
    }
    let body = `<label>Phone sync</label>
      <div class="inline"><span data-sync-status>${esc(statusLine())}</span><button class="btn small" data-sync="now"${view.busy ? ' disabled' : ''}>Sync now</button></div>`;
    if (view.mode === 'naming') {
      body += `<div class="home-row" style="margin-top:8px"><input id="sync-name" placeholder="Name this phone, e.g. My phone" maxlength="60" autocomplete="off"><button class="btn primary" data-sync="create"${view.busy ? ' disabled' : ''}>Show code</button><button class="btn" data-sync="cancel-add">Cancel</button></div>`;
    } else if (view.mode === 'code' && view.code) {
      body += `<div class="sync-pair"><img src="${esc(view.code.qrDataUrl)}" alt="Pairing QR code" width="200" height="200">
        <div><p class="note" style="margin-top:0"><b>${esc(view.code.name)}</b> — scan this in the Client Clusters app on your phone, or press Copy code and paste it there.</p>
        <div class="inline" style="margin-top:6px"><button class="btn small" data-sync="copy">Copy code</button><button class="btn small" data-sync="done-add">Done</button></div>
        <p class="note bad">Anyone with this code can read your client data — don't share it. It disappears from this screen after 5 minutes.</p></div></div>`;
    } else {
      body += `<div class="sync-phones" style="margin-top:8px"><b>Paired phones</b>`;
      if (phones === null) body += `<p class="note">${phonesError ? `<span class="bad">${esc(phonesError)}</span>` : 'Loading…'}</p>`;
      else if (!phones.length) body += '<p class="note">No phone is paired yet.</p>';
      else body += '<ul class="phone-list">' + phones.map(p => `<li><span>${esc(p.name)}<small>${p.lastSeen ? 'last seen ' + esc(when(p.lastSeen * 1000)) : 'never connected'}</small></span><button class="btn small" data-sync="revoke" data-id="${esc(p.id)}">Disconnect</button></li>`).join('') + '</ul>';
      body += `</div><div class="inline" style="margin-top:8px"><button class="btn" data-sync="add">Add a phone…</button><button class="btn" data-sync="rekey">Reset sync key…</button><button class="btn danger" data-sync="disable">Turn off sync</button></div>`;
    }
    body += `<p class="note ${view.msg && view.msg.startsWith('!') ? 'bad' : ''}" id="sync-msg" role="status">${esc((view.msg || '').replace(/^!/, ''))}</p>`;
    return body;
  }

  function paint() {
    const el = section();
    if (el?.isConnected) el.innerHTML = html();
  }

  async function loadPhones() {
    if (!info.enabled) return;
    const r = await api().syncListPhones().catch(e => ({ ok: false, error: e.message }));
    if (r.ok) { phones = r.phones; phonesError = ''; } else { phones = null; phonesError = r.error || 'Could not load the phone list.'; }
    paint();
  }

  // Called by the Settings dialog once it is on screen.
  async function mount() {
    view = { mode: 'main', msg: '', busy: false, code: null };
    await refresh();
    paint();
    if (info.enabled) loadPhones();
  }

  const setBusy = b => { view.busy = b; };
  const readOff = () => {
    off.url = section().querySelector('#sync-url')?.value.trim() ?? off.url;
    off.code = section().querySelector('#sync-code')?.value.trim() ?? off.code;
  };
  const say = (m, ok = true) => { if (info.enabled) view.msg = (ok ? '' : '!') + m; else { off.msg = m; off.ok = ok; } paint(); };

  async function click(e) {
    const b = e.target.closest('[data-sync]');
    if (!b) return;
    const act = b.dataset.sync;
    if (act === 'help') { e.preventDefault(); api().openExternal(SETUP_LINK); return; }
    if (view.busy) return;
    if (act === 'test') {
      readOff(); setBusy(true); say('Testing…');
      const r = await api().syncTest(off.url).catch(x => ({ ok: false, error: x.message }));
      setBusy(false);
      if (!r.ok) return say(r.error, false);
      say(r.claimed ? 'The server answers, but it is already set up. Use the PC that set it up, or reset it by deleting its data folder on the server.' : 'The server answers and is ready to be set up. Enter the setup code and turn sync on.', !r.claimed);
    }
    if (act === 'enable') {
      readOff();
      setBusy(true); say('Turning on sync…');
      flushSave(); // the first upload reads the data file
      const r = await api().syncEnable({ url: off.url, setupCode: off.code }).catch(x => ({ ok: false, error: x.message }));
      setBusy(false);
      if (!r.ok) return say(r.error, false);
      off = { url: '', code: '', msg: '', ok: true };
      view = { mode: 'main', msg: '', busy: false, code: null };
      setInfo(r.status); phones = null; paint(); loadPhones();
      toast('Phone sync is on. Add a phone to start using it.');
    }
    if (act === 'now') {
      setBusy(true); paint();
      const r = await api().syncNow().catch(x => ({ ok: false, error: x.message }));
      setBusy(false);
      view.msg = r.ok ? '' : '!' + r.error;
      await refresh(); paint();
    }
    if (act === 'add') { view.mode = 'naming'; view.msg = ''; paint(); section().querySelector('#sync-name')?.focus(); }
    if (act === 'cancel-add') { view.mode = 'main'; paint(); }
    if (act === 'create') {
      const name = section().querySelector('#sync-name').value.trim();
      if (!name) return say('Give the phone a name.', false);
      setBusy(true); paint();
      const r = await api().syncAddPhone(name).catch(x => ({ ok: false, error: x.message }));
      setBusy(false);
      if (!r.ok) { view.mode = 'naming'; view.msg = '!' + r.error; paint(); return; }
      view.mode = 'code'; view.code = { name, qrDataUrl: r.qrDataUrl }; view.msg = ''; paint();
      clearTimeout(codeTimer);
      codeTimer = setTimeout(() => { if (view.mode === 'code') { view.mode = 'main'; view.code = null; api().syncClearPairing(); paint(); loadPhones(); } }, 5 * 60 * 1000);
    }
    if (act === 'copy') {
      const r = await api().syncCopyPairing().catch(x => ({ ok: false, error: x.message }));
      if (r.ok) toast('Pairing code copied. It is removed from the clipboard in a minute.'); else say(r.error, false);
    }
    if (act === 'done-add') { clearTimeout(codeTimer); api().syncClearPairing(); view.mode = 'main'; view.code = null; paint(); loadPhones(); }
    if (act === 'rekey') await resetKey();
    if (act === 'revoke') {
      const name = b.closest('li').querySelector('span').firstChild.textContent;
      if (!(await confirmDialog('Disconnect this phone?', `${esc(name)} can no longer sync. If it was lost or stolen, also reset the sync key so it can't read future data. Data already on the phone stays there until you delete the app's data.`, 'Disconnect', true))) return;
      const r = await api().syncRevokePhone(b.dataset.id).catch(x => ({ ok: false, error: x.message }));
      if (!r.ok) return say(r.error, false);
      await loadPhones();
      if (await confirmDialog('Reset the sync key too?', `${esc(name)} can no longer sync. If it was lost or stolen, reset the sync key so it can't read future data. Your other phones will have to be paired again.`, 'Reset sync key', true)) await resetKey(true);
    }
    if (act === 'disable') {
      if (!(await confirmDialog('Turn off phone sync?', 'This computer stops syncing and forgets the server. Your data here is not changed and the server is not erased. To use the same server again, reset it by deleting its data folder.', 'Turn off', true))) return;
      await api().syncDisable().catch(() => null);
      phones = null; view = { mode: 'main', msg: '', busy: false, code: null };
      await refresh(); paint();
    }
  }

  // New key and a new copy on the server; every phone has to pair again. `asked` = the caller already asked.
  async function resetKey(asked) {
    if (!asked && !(await confirmDialog('Reset the sync key?', 'This computer makes a new key and a new copy on the server. All paired phones are disconnected and must be paired again (changes not yet sent from a phone stay on that phone). Your data on this computer is not changed.', 'Reset sync key', true))) return;
    await flushSave();
    setBusy(true); say('Resetting the sync key…');
    const r = await api().syncRekey().catch(x => ({ ok: false, error: x.message }));
    setBusy(false);
    if (!r.ok) return say(r.error, false);
    setInfo(r.status); phones = null; view = { mode: 'main', msg: '', busy: false, code: null }; paint(); loadPhones();
    toast('Sync key reset. Add your phones again.');
  }

  // Enter in the sync fields acts on sync, not on the Settings “Save” button.
  function key(e) {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    e.preventDefault(); e.stopPropagation();
    const act = e.target.id === 'sync-name' ? 'create' : e.target.id === 'sync-code' ? 'enable' : 'test';
    section().querySelector(`[data-sync="${act}"]`)?.click();
  }

  // ---------- Changes arriving from the phone ----------
  const plural = (n, w, w2) => `${n} ${n === 1 ? w : (w2 || w + 's')}`;
  // Merge the changes into the data, save, and only then tell the main process (it moves its sync state forward on that).
  async function incoming(payload) {
    const id = payload && payload.id, ops = payload && payload.ops;
    const ack = ok => { if (id !== undefined) api().syncApplied(id, ok).catch(() => {}); };
    if (state.recovery || !Array.isArray(ops)) return ack(false);
    if (!ops.length) return ack(true);
    let res;
    const before = state.data;
    try {
      await flushSave();
      // Work on a copy: if anything throws, the data in the window is exactly what it was.
      const copy = JSON.parse(JSON.stringify(state.data));
      res = SyncOps.applyToData(copy, ops);
      copy.clients.forEach(normalizeVisits);
      state.data = copy;
      renderAll();
      if (state.selectedClientId && clientById(state.selectedClientId)) renderDetail();
      else if (state.selectedClientId) { state.selectedClientId = null; renderAll(); renderDetail(); }
    } catch (e) {
      state.data = before;
      try { renderAll(); renderDetail(); } catch { /* nothing more to do */ }
      toast('Could not merge the phone changes: ' + e.message, { error: true });
      return ack(false);
    }
    const saved = await flushSave();
    ack(saved === true);
    const c = res.counts, parts = [];
    if (c.visits) parts.push(plural(c.visits, 'visit'));
    if (c.notes) parts.push(plural(c.notes, 'note'));
    if (c.prospects) parts.push(plural(c.prospects, 'prospect change'));
    if (parts.length) toast('From your phone: ' + parts.join(', '));
    if (res.restored.length) toast(`Restored ${res.restored.slice(0, 3).join(', ')}${res.restored.length > 3 ? ' and ' + (res.restored.length - 3) + ' more' : ''} because a visit was logged on the phone`);
  }

  // The circuit breaker held back a big deletion: ask whether the phones should lose those too.
  async function confirmDeletes(counts) {
    const bits = [];
    if (counts.clients) bits.push(plural(counts.clients, 'client'));
    if (counts.visits) bits.push(plural(counts.visits, 'visit'));
    if (counts.prospects) bits.push(plural(counts.prospects, 'prospect'));
    const what = bits.join(' / ');
    const answer = await choiceDialog(`Also remove ${what} from your phones?`,
      `You just removed ${what} on this computer. Phone sync is on, so your phones still have them. "Keep them" brings them back here and leaves the phones alone.`,
      [{ label: 'Keep them (restore here)', value: false, primary: true }, { label: 'Remove from phones too', value: true, danger: true }]);
    const r = await api().syncConfirmDeletes(answer).catch(e => ({ ok: false, error: e.message }));
    if (!r.ok) toast(r.error || 'Could not apply your choice.', { error: true });
    else if (answer === false && r.restored) toast(`Kept ${plural(r.restored, 'client')} (and their visits) from the phone copy.`);
  }

  // After the data was replaced on purpose (recovery, Replace restore): bring back what the phones still have instead of deleting it there.
  async function rebase() {
    await flushSave();
    const r = await api().syncRebase().catch(e => ({ ok: false, error: e.message }));
    if (!r.ok) { toast('Phone sync could not compare the data: ' + (r.error || 'unknown error'), { error: true }); return r; }
    if (r.restored || r.restoredProspects || r.restoredVisits) toast(`Phone sync copy: ${plural(r.restored || 0, 'client')}, ${plural(r.restoredVisits || 0, 'visit')} and ${plural(r.restoredProspects || 0, 'prospect')} that this data did not have were brought back.`);
    return r;
  }

  function pause(p) { return api().syncPause(p).then(setInfo).catch(() => {}); }

  function start() {
    if (!api() || !api().syncStatus) return;
    api().onSyncStatus(setInfo);
    api().onSyncIncoming(incoming);
    api().onSyncConfirmDeletes?.(confirmDeletes);
    document.getElementById('sync-chip')?.addEventListener('click', () => settingsDialog({ focus: '#sync-url' }));
    refresh();
  }

  return { html, mount, click, key, start, pause, rebase, enabled: () => !!info.enabled, refresh, incoming, confirmDeletes, setInfo };
})();

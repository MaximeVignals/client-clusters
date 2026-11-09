/* Client Clusters — renderer: settings dialog, … menu and clearing data */
'use strict';

function settingsDialog({ focus } = {}) {
  const s = { ...S() };
  let home = homeOf() ? { ...S().home } : null; // draft, saved with “Save”
  const keyNow = state.googleKey;
  const homeMsg = () => (home ? `Found: ${esc(home.label || home.address)}` : 'Not set — groups are numbered from north to south.');
  showModal({
    title: 'Settings',
    render: () => `
      <div class="field"><label for="s-home">Home address</label>
        <div class="home-row"><input id="s-home" value="${esc(home?.address || '')}" placeholder="e.g. 12 rue de la Paix, 69003 Lyon"><button class="btn" data-s="find-home">Find</button></div>
        <p class="note" id="s-home-msg">${homeMsg()}</p>
        <p class="note">With a home address, group 1 is the group nearest to home, group 2 the next one, and so on (as the crow flies). Routes in Google Maps start and end at home.</p>
      </div>
      <div class="field"><label>Grouping</label>
        <div class="inline"><span>Up to</span><input type="number" id="s-max" min="2" max="30" value="${s.maxSize}"><span>clients per group,</span></div>
        <div class="inline" style="margin-top:6px"><span>or up to</span><input type="number" id="s-flex" min="2" max="40" value="${s.flexSize}"><span>when they're all in the same town.</span></div>
        <div class="inline" style="margin-top:6px"><span>Clients in a group are never more than</span><input type="number" id="s-span" min="1" max="1000" value="${s.maxSpanKm}"><span>km apart.</span></div>
        <p class="note">Group sizes adapt: a town is kept in one group when possible, and a client with nobody within that distance gets a group of its own. A town with more clients than the second number is split by neighbourhood.</p>
      </div>
      <div class="field"><label>Visit reminders</label>
        <div class="inline"><span>A visit is <b>due</b> after</span><input type="number" id="s-due" min="1" value="${s.dueDays}"><span>days, and <b>overdue</b> after</span><input type="number" id="s-over" min="2" value="${s.overdueDays}"><span>days.</span></div>
        <table class="tier-table">
          <tr><th></th><th>Due after (days)</th><th>Overdue after (days)</th></tr>
          ${Object.keys(DEFAULT_TIERS).map(k => `<tr><td><span class="tier t${k}">${k}</span> ${esc(TIER_NAMES[k].split(' — ')[1])}</td><td><input type="number" id="s-t${k}-due" min="1" value="${s.tiers[k].due}"></td><td><input type="number" id="s-t${k}-over" min="2" value="${s.tiers[k].over}"></td></tr>`).join('')}
        </table>
        <p class="note">The first line applies to clients without a priority. Set a client's priority on its card, in the import file (a “Priority” column with A, B or C), or for several clients at once by selecting them on the map.</p>
      </div>
      <div class="field"><label>Day planning</label>
        <div class="plan-set">
          <label>Day starts at<input type="time" id="s-dstart" value="${esc(s.dayStart)}"></label>
          <label>Day ends at<input type="time" id="s-dend" value="${esc(s.dayEnd)}"></label>
          <label>Minutes per visit<input type="number" id="s-vmin" min="5" max="240" value="${s.visitMin}"></label>
          <label>Visits a day (at most)<input type="number" id="s-maxstops" min="1" max="25" value="${s.maxStops}"></label>
          <label>Look within (km)<input type="number" id="s-pradius" min="2" max="300" value="${s.planRadiusKm}"></label>
          <label>Average speed (km/h)<input type="number" id="s-speed" min="10" max="130" value="${s.speedKmh}"></label>
        </div>
        <p class="note">Used by “Plan a day” and to estimate arrival times, so the app can warn when a client is closed when you get there.</p>
      </div>
      <div class="field"><label for="s-gkey">Opening hours from Google</label>
        <div class="home-row"><input id="s-gkey" type="password" autocomplete="off" spellcheck="false" placeholder="${keyNow.hasKey ? 'Key saved (' + esc(keyNow.masked) + ') — paste a new one to replace it' : 'Paste your Google Maps Platform API key'}">${keyNow.hasKey ? '<button class="btn" data-s="remove-key">Remove key</button>' : ''}</div>
        <div class="inline" style="margin-top:6px"><span>Update hours from Google every</span><input type="number" id="s-hrefresh" min="0" max="365" value="${s.hoursRefreshDays}"><span>days (0 = only when I ask).</span></div>
        <p class="note">The key needs “Places API (New)” enabled in a Google Cloud project with billing. Google gives a free allowance each month (currently about 1,000 opening-hours reads); finding a client's page and reading its hours costs one read, plus one search. The key is stored encrypted on this computer and is not included in backups.</p>
      </div>
      <div class="err" id="s-err"></div>`,
    buttons: [{ label: 'Cancel', action: 'close' }, { label: 'Save', primary: true, action: 'ok' }],
    async onClick(e, box) {
      const b = e.target.closest('[data-s]');
      if (!b) return;
      if (b.dataset.s === 'find-home') {
        const q = box.querySelector('#s-home').value.trim();
        if (!q) { home = null; box.querySelector('#s-home-msg').innerHTML = homeMsg(); return; }
        b.disabled = true; b.textContent = 'Finding…';
        const r = await window.api.geocode({ query: q, postcode: (/\b\d{5}\b/.exec(q) || [])[0] || '', country: '' });
        b.disabled = false; b.textContent = 'Find';
        const msg = box.querySelector('#s-home-msg');
        if (!msg) return; // Settings was closed while searching
        if (r && Number.isFinite(r.lat)) { home = { address: q, label: r.label, lat: r.lat, lng: r.lng }; msg.innerHTML = homeMsg(); }
        else msg.innerHTML = '<span class="bad">Address not found. Check it, add the postal code and town, then click Find.</span>';
      }
      if (b.dataset.s === 'remove-key') {
        await window.api.googleSetKey('');
        state.googleKey = { hasKey: false, masked: '' };
        b.remove();
        box.querySelector('#s-gkey').placeholder = 'Paste your Google Maps Platform API key';
        toast('Google API key removed. Opening hours already found are kept.');
        renderAll(); renderDetail();
      }
    },
    async onOk(close, box) {
      const v = id => parseInt(box.querySelector(id).value, 10);
      const maxSize = v('#s-max'), flexSize = v('#s-flex'), maxSpanKm = v('#s-span'), due = v('#s-due'), over = v('#s-over'), hRefresh = v('#s-hrefresh');
      const err = m => { box.querySelector('#s-err').textContent = m; };
      if (!(maxSize >= 2 && maxSize <= 30)) return err('Group size must be between 2 and 30.');
      if (!(flexSize >= maxSize && flexSize <= 40)) return err(`The same-town size must be at least ${maxSize}.`);
      if (!(maxSpanKm >= 1 && maxSpanKm <= 1000)) return err('The distance must be between 1 and 1000 km.');
      if (!(due >= 1 && over > due)) return err('“Overdue” must be more days than “due”.');
      if (!(hRefresh >= 0 && hRefresh <= 365)) return err('Hours update: between 0 and 365 days.');
      const tiers = {};
      for (const k of Object.keys(DEFAULT_TIERS)) {
        const td = v(`#s-t${k}-due`), to = v(`#s-t${k}-over`);
        if (!(td >= 1 && to > td)) return err(`Priority ${k}: “overdue” must be more days than “due”.`);
        tiers[k] = { due: td, over: to };
      }
      const dayStart = box.querySelector('#s-dstart').value, dayEnd = box.querySelector('#s-dend').value;
      const ds = Planning.parseHHMM(dayStart), de = Planning.parseHHMM(dayEnd);
      if (ds === null || de === null || de <= ds) return err('The working day must end after it starts.');
      const visitMin = v('#s-vmin'), maxStops = v('#s-maxstops'), planRadiusKm = v('#s-pradius'), speedKmh = v('#s-speed');
      if (!(visitMin >= 5 && visitMin <= 240)) return err('Time per visit: between 5 and 240 minutes.');
      if (!(maxStops >= 1 && maxStops <= 25)) return err('Visits a day: between 1 and 25.');
      if (!(planRadiusKm >= 2 && planRadiusKm <= 300)) return err('Planning distance: between 2 and 300 km.');
      if (!(speedKmh >= 10 && speedKmh <= 130)) return err('Average speed: between 10 and 130 km/h.');
      const planningSettings = { tiers, dayStart, dayEnd, visitMin, maxStops, planRadiusKm, speedKmh };
      const okBtn = box.querySelector('.modal-foot .btn.primary');
      const busy = on => { okBtn.disabled = on; okBtn.textContent = on ? 'Checking…' : 'Save'; };
      // Home address typed but not looked up yet: look it up now.
      const homeText = box.querySelector('#s-home').value.trim();
      if (!homeText) home = null;
      else if (!home || home.address !== homeText) {
        busy(true);
        const r = await window.api.geocode({ query: homeText, postcode: (/\b\d{5}\b/.exec(homeText) || [])[0] || '', country: '' }).catch(() => null);
        busy(false);
        if (!(r && Number.isFinite(r.lat))) return err('The home address was not found. Check it, or leave it empty.');
        home = { address: homeText, label: r.label, lat: r.lat, lng: r.lng };
      }
      // New Google key: check it with Google before saving.
      const key = box.querySelector('#s-gkey').value.trim();
      let keyAdded = false;
      if (key) {
        busy(true);
        const r = await window.api.googleSetKey(key).catch(e => ({ ok: false, error: e.message }));
        busy(false);
        if (!r.ok) return err(r.error);
        keyAdded = !state.googleKey.hasKey;
        state.googleKey = { hasKey: true, masked: r.masked };
      }
      const groupingChanged = maxSize !== S().maxSize || flexSize !== S().flexSize || maxSpanKm !== S().maxSpanKm;
      const old = homeOf();
      const homeChanged = (old?.lat ?? null) !== (home?.lat ?? null) || (old?.lng ?? null) !== (home?.lng ?? null);
      Object.assign(S(), { maxSize, flexSize, maxSpanKm, dueDays: due, overdueDays: over, hoursRefreshDays: hRefresh, home, ...planningSettings });
      delete S().groupsMode; delete S().groupsCount;
      close(); save(); renderAll(); renderDetail();
      if (homeChanged && home && state.data.groups.length) {
        const first = [...state.derived.byGroup.values()].find(i => i.group.number === 1);
        toast(`Groups are now numbered from home${first ? `: group 1 is ${first.group.name}, ${fmtKm(first.homeKm)} away` : ''}.`);
      } else if (homeChanged && !home) toast('Home address removed. Group numbers stay as they are until the next Regroup.');
      if (groupingChanged && state.data.groups.length && (await confirmDialog('Regroup now?', 'The grouping settings changed. Regroup all clients with the new settings? Visit history is kept.', 'Regroup'))) await regroup({ confirm: false });
      if (keyAdded) {
        const todo = state.data.clients.filter(c => notLookedUp(c) && (hasLoc(c) || c.gbp?.mapsUrl));
        if (todo.length && !state.data.demo && (await confirmDialog('Look up opening hours now?', `The key works. Find the Google business page and opening hours of your ${todo.length} client${todo.length > 1 ? 's' : ''} now? Clients that can't be matched for sure are listed for you to check.`, 'Look up now'))) lookupGoogle(todo);
      } else if (key) toast('Google API key updated.');
    },
  });
  if (focus) setTimeout(() => box$(focus)?.focus(), 60);
}

async function clearAll(demo) {
  if (!demo && !(await confirmDialog('Delete all clients?', `All ${state.data.clients.length} clients, their groups and their visit history will be removed. A daily backup is kept in the data folder.`, 'Delete everything', true))) return;
  state.data.clients = []; state.data.groups = []; state.data.demo = false;
  state.selectedClientId = null; state.selectedGroupId = null; state.clientFilter = null;
  save(); renderAll(); renderDetail();
  map.setView([46.6, 2.4], 6);
  if (demo) openImport();
}

$('#btn-menu').addEventListener('click', e => { e.stopPropagation(); $('#export-menu').hidden = true; $('#menu').hidden = !$('#menu').hidden; });
document.addEventListener('click', () => { $('#menu').hidden = true; });
$('#menu').addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  $('#menu').hidden = true;
  if (act === 'settings') settingsDialog();
  if (act === 'hours') hoursOverview();
  if (act === 'folder') window.api.openDataFolder();
  if (act === 'clear') clearAll(false);
  if (act === 'backup') backupDialog();
  if (act === 'restore') restoreBackup();
});

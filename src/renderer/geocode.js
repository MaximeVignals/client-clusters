/* Client Clusters — renderer: geocoding addresses */
'use strict';

// =====================================================================
// Geocoding
// =====================================================================
function geoQuery(c) {
  return [c.address, [c.postcode, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}
async function geocodeOne(c) {
  const query = geoQuery(c);
  if (!query) { c.geo = { status: 'failed', label: '', score: 0 }; return false; }
  const r = await window.api.geocode({ query, postcode: c.postcode, country: c.country });
  if (r && Number.isFinite(r.lat)) {
    c.lat = r.lat; c.lng = r.lng;
    c.geo = { status: 'ok', label: r.label, score: r.score, source: r.source, precision: r.precision, city: r.city || '', postcode: r.postcode || '' };
    return true;
  }
  const notFound = !r || /not found/i.test(r.error || '');
  if (notFound) { c.geo = { status: 'failed', label: '', score: 0 }; delete c.lat; delete c.lng; }
  return notFound ? false : null; // null = network problem, try again later
}

async function geocodeClients(list) {
  if (!list.length || state.geocoding) return { ok: 0, failed: 0, network: 0 };
  if (state.gjob) state.gjob.stop = true; // addresses first; the Google lookup starts again afterwards
  const job = state.geocoding = { total: list.length, done: 0, stop: false };
  renderBanners();
  showProgress(`Locating addresses… 0 / ${job.total}`, 0);
  const res = { ok: 0, failed: 0, network: 0 };
  let next = 0, lastRender = Date.now();
  const worker = async () => {
    while (!job.stop && next < list.length) {
      const c = list[next++];
      let r;
      try { r = await geocodeOne(c); } catch { r = null; }
      if (r === true) res.ok++; else if (r === false) res.failed++; else res.network++;
      job.done++;
      showProgress(`Locating addresses… ${job.done} / ${job.total}`, job.done / job.total);
      if (res.network >= 6 && res.ok === 0) job.stop = true; // probably offline
      if (Date.now() - lastRender > 1200) { lastRender = Date.now(); save(); renderAll(); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  state.geocoding = null;
  hideProgress();
  save(); renderAll();
  if (res.network && !res.ok) toast("Couldn't reach the address service. Check the internet connection, then use “Locate now”.", { error: true });
  else toast(`${res.ok} address${res.ok === 1 ? '' : 'es'} placed on the map${res.failed ? `, ${res.failed} not found` : ''}${job.stop && job.done < job.total ? ' (stopped)' : ''}.`,
    res.failed ? { action: { label: 'See which', fn: reviewUnlocated } } : {});
  return res;
}
$('#progress-stop').addEventListener('click', () => { if (state.geocoding) state.geocoding.stop = true; if (state.gjob) state.gjob.stop = true; });

function afterLocate() {
  if (!state.data.groups.length) { if (state.data.clients.some(hasLoc)) regroup({ confirm: false }); }
  else fitAll();
  setTimeout(autoLookupGoogle, 400);
}

/* Client Clusters — renderer: KMZ and Excel export */
'use strict';

// =====================================================================
// Export, settings, backups
// =====================================================================
// Export for Google Earth / Google My Maps: one folder (layer) per group, pins in the group's colour.
async function exportKmz() {
  const located = state.data.clients.filter(hasLoc);
  if (!located.length) { toast('No client is on the map yet.', { error: true }); return; }
  const x = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const kmlColor = hex => { const h = hex.replace('#', ''); return 'ff' + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2); };
  const statusText = { ok: 'Up to date', due: 'Due', late: 'Overdue', never: 'Never visited' };
  const styles = [], folders = [];
  const placemark = (c, g, styleId) => {
    const lv = lastVisit(c), d = daysSince(lv);
    const addr = [c.address, [c.postcode, c.city].filter(Boolean).join(' '), c.country].filter(Boolean).join(', ');
    // Shown in the info bubble:
    const np = nextPlannedVisit(c);
    const shown = [['Group', g ? `${g.number}. ${g.name}` : ''], ['Address', addr], ['Last visit', lv ? `${fmtDate(lv)} (${fmtAgo(d)})` : 'Never visited'],
      ['Status', statusText[clientStatus(c)]], ['Priority', c.tier || ''], ['Next planned visit', np ? fmtDate(np) : ''],
      ['Visits recorded', (c.visits || []).filter(countsAsVisit).length], ['Opening hours', Hours.weekText(hoursOf(c))],
      ['Phone', c.gbp?.phone || ''], ['Notes', c.notes || ''], ...Object.entries(c.extra || {})];
    const desc = shown.filter(([, v]) => String(v).trim() !== '').map(([k, v]) => `<b>${esc(k)}:</b> ${esc(v).replace(/\n/g, '<br>')}`).join('<br>');
    // Data columns (kept separate so the file can be imported back into the app):
    const fields = [['Street address', c.address], ['Postal code', c.postcode], ['City', c.city], ['Country', c.country],
      ['Last visit', lv || ''], ['Priority', c.tier || ''], ['Group', g ? `${g.number}. ${g.name}` : ''], ['Notes', c.notes || ''], ['Google Maps link', c.gbp?.mapsUrl || ''], ...Object.entries(c.extra || {})]
      .filter(([, v]) => String(v ?? '').trim() !== '');
    return `      <Placemark>
        <name>${x(c.name)}</name>
        <description><![CDATA[${desc.replace(/]]>/g, ']]&gt;')}]]></description>
        <styleUrl>#${styleId}</styleUrl>
        <ExtendedData>
${fields.map(([k, v]) => `          <Data name="${x(k)}"><value>${x(v)}</value></Data>`).join('\n')}
        </ExtendedData>
        <Point><coordinates>${c.lng.toFixed(7)},${c.lat.toFixed(7)},0</coordinates></Point>
      </Placemark>`;
  };
  const addStyle = (id, color) => styles.push(`    <Style id="${id}">
      <IconStyle><color>${kmlColor(color)}</color><scale>1.0</scale><Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle>
      <LabelStyle><scale>0.8</scale></LabelStyle>
    </Style>`);
  for (const info of [...state.derived.byGroup.values()].sort((a, b) => a.group.number - b.group.number)) {
    const members = info.members.filter(hasLoc);
    if (!members.length) continue;
    const id = 'g' + info.group.number;
    addStyle(id, info.group.color);
    folders.push(`    <Folder>
      <name>${x(`${info.group.number}. ${info.group.name} (${members.length})`)}</name>
${members.map(c => placemark(c, info.group, id)).join('\n')}
    </Folder>`);
  }
  const loose = located.filter(c => !c.groupId);
  if (loose.length) {
    addStyle('nogroup', '#6b6d66');
    folders.push(`    <Folder>
      <name>Not in a group (${loose.length})</name>
${loose.map(c => placemark(c, null, 'nogroup')).join('\n')}
    </Folder>`);
  }
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Clients ${x(todayISO())}</name>
    <ExtendedData><Data name="generator"><value>Client Clusters</value></Data></ExtendedData>
${styles.join('\n')}
${folders.join('\n')}
  </Document>
</kml>
`;
  try {
    const p = await window.api.exportKmz({ kml, defaultName: `clients-${todayISO()}.kmz` });
    if (p) {
      const missing = state.data.clients.length - located.length;
      toast(`Exported ${located.length} clients for Google Earth / My Maps.${missing ? ` ${missing} not on the map were left out.` : ''}`);
    }
  } catch (e) { toast('Export failed: ' + e.message, { error: true }); }
}

async function exportExcel() {
  if (!state.data.clients.length) { toast('Nothing to export yet.', { error: true }); return; }
  const extraKeys = [...new Set(state.data.clients.flatMap(c => Object.keys(c.extra || {})))];
  const statusText = { ok: 'Up to date', due: 'Due', late: 'Overdue', never: 'Never visited' };
  const clients = state.data.clients.slice().sort((a, b) => ((groupById(a.groupId)?.number ?? 1e9) - (groupById(b.groupId)?.number ?? 1e9)) || a.name.localeCompare(b.name));
  const rows = [['Group #', 'Group', 'Client', 'Address', 'Postal code', 'City', 'Country', 'Last visit', 'Days since last visit', 'Status', 'Priority', 'Next planned visit', 'Visits done', 'Notes',
    'Opening hours', 'Google page', 'Phone (Google)', 'Latitude', 'Longitude', ...extraKeys]];
  for (const c of clients) {
    const g = groupById(c.groupId), lv = lastVisit(c);
    rows.push([g ? g.number : '', g ? g.name : '', c.name, c.address, c.postcode, c.city, c.country, lv || '', lv ? daysSince(lv) : '', statusText[clientStatus(c)],
      c.tier || '', nextPlannedVisit(c) || '', (c.visits || []).filter(countsAsVisit).length, c.notes || '', Hours.weekText(hoursOf(c)), c.gbp?.mapsUrl || '', c.gbp?.phone || '',
      hasLoc(c) ? +c.lat.toFixed(6) : '', hasLoc(c) ? +c.lng.toFixed(6) : '', ...extraKeys.map(k => c.extra?.[k] ?? '')]);
  }
  // History: what happened (done, didn't happen). Planned visits have their own sheet.
  const t = todayISO();
  const statusName = v => ({ done: 'Done', cancelled: "Didn't happen", planned: v.date < t ? 'Not confirmed' : 'Planned' }[vStatus(v)]);
  const visits = [['Date', 'Client', 'Group #', 'Group', 'Status', 'Type', 'Outcome', 'Note']];
  for (const c of clients) for (const v of (c.visits || []).filter(x => vStatus(x) !== 'planned' || x.date < t).sort((a, b) => b.date.localeCompare(a.date))) {
    const g = groupById(c.groupId);
    visits.push([v.date, c.name, g ? g.number : '', g ? g.name : '', statusName(v), VISIT_TYPES[v.type] || 'Visit', v.outcome ? OUTCOMES[v.outcome] : '', v.note || '']);
  }
  const planned = [['Date', 'Stop #', 'Client', 'Address', 'Postal code', 'City', 'Group', 'Estimated arrival', 'Opening hours that day', 'Note']];
  const days = [...new Set(state.data.clients.flatMap(c => plannedOf(c).filter(v => v.date >= t).map(v => v.date)))].sort();
  for (const day of days) {
    const p = dayPlan(day);
    p.stops.filter(s => vStatus(s.v) === 'planned').forEach(s => {
      const g = groupById(s.c.groupId);
      const line = hoursOf(s.c) ? Hours.weekLines(hoursOf(s.c)).find(l => l.day === p.opts.weekday)?.text || '' : '';
      planned.push([day, p.stops.indexOf(s) + 1, s.c.name, s.c.address, s.c.postcode, s.c.city, g ? `${g.number}. ${g.name}` : '', s.leg ? Planning.fmtMin(s.leg.arrive) : '', line, s.v.note || '']);
    });
  }
  const home = homeOf();
  const groups = [['Group #', 'Group', 'Clients', 'Oldest last visit (days)', 'Never visited', ...(home ? ['Distance from home (km)'] : []), 'Members']];
  for (const info of [...state.derived.byGroup.values()].sort((a, b) => a.group.number - b.group.number)) {
    groups.push([info.group.number, info.group.name, info.members.length, info.oldestDays ?? '', info.neverCount,
      ...(home ? [info.homeKm !== null ? Math.round(info.homeKm * 10) / 10 : ''] : []), info.members.map(c => c.name).join(', ')]);
  }
  try {
    const p = await window.api.exportXlsx({
      defaultName: `clients-${todayISO()}.xlsx`,
      sheets: [
        { name: 'Clients', rows, widths: [8, 18, 28, 30, 11, 18, 10, 12, 10, 14, 8, 14, 9, 30, 34, 30, 15, 11, 11] },
        { name: 'Groups', rows: groups, widths: [8, 20, 8, 12, 10, ...(home ? [12] : []), 80] },
        { name: 'Visits', rows: visits, widths: [12, 28, 8, 18, 14, 11, 18, 40] },
        { name: 'Planned', rows: planned, widths: [12, 7, 28, 30, 11, 18, 22, 10, 24, 30] },
      ],
    });
    if (p) toast('Exported to Excel.');
  } catch (e) { toast('Export failed: ' + e.message, { error: true }); }
}

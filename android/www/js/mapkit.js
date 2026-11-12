// Pure helpers for the map: marker and row markup, French labels, contrast. Shared by map.js (markers, lists) and views.js
// (pick-list sheet). No Leaflet here. Loaded after views.js (needs Views.PROSPECT_STATUS and Views.groupColor at call time).
'use strict';

const MapKit = (() => {
  const { esc } = U;
  const NB = T.NB;
  const FALLBACK = '#6B7873';

  // A group colour is user data that ends up in a style attribute: accept hex only.
  function safeColor(c) {
    const s = String(c || '').trim();
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : FALLBACK;
  }
  function luminance(hex) {
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    const ch = i => { const v = parseInt(h.substr(i, 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
  }
  // White or dark ink, whichever contrasts more with the disc colour.
  function inkFor(hex) {
    const l = luminance(hex), dark = luminance('#1B2421');
    return (1.05 / (l + 0.05)) >= ((l + 0.05) / (dark + 0.05)) ? '#FFFFFF' : '#1B2421';
  }

  const tierOf = c => String(c.tier || '').trim().toUpperCase();
  const town = e => [e.postcode, e.city].filter(Boolean).join(' ');

  // Visit order of the clients planned today: same numbering as the Aujourd’hui list.
  function todayOrders() {
    const m = new Map();
    Views.plannedToday().forEach((it, i) => { if (!m.has(it.c.id)) m.set(it.c.id, Number.isFinite(it.v.order) ? it.v.order : i + 1); });
    return m;
  }

  function label(kind, e, order) {
    if (kind === 'client') {
      const t = tierOf(e);
      return `Client${NB}: ${e.name || ''}${t ? `, priorité ${t}` : ''}${order ? `, visite ${order} aujourd’hui` : ''}`;
    }
    return `Prospect${NB}: ${e.name || ''}, ${Views.PROSPECT_STATUS[Views.statusKey(e)].label.toLowerCase()}`;
  }

  // The visual part of a marker (shape + colour + glyph). Client: disc in the group colour with the priority letter.
  // Prospect: diamond in the status colour with the status glyph. A yellow corner badge carries today's visit order.
  function glyph(kind, e, order) {
    if (kind === 'client') {
      const col = safeColor(Views.groupColor(e)), t = tierOf(e);
      return `<span class="mk mk-c" style="--g:${col};--gi:${inkFor(col)}">${t ? `<span class="mk-t">${esc(t.slice(0, 1))}</span>` : '<span class="mk-dot"></span>'}${order ? `<span class="mk-ord">${esc(order)}</span>` : ''}</span>`;
    }
    const meta = Views.PROSPECT_STATUS[Views.statusKey(e)];
    return `<span class="mk mk-p ${meta.cls}">${Icon.svg(meta.glyph)}</span>`;
  }

  // Today's opening hours in words ("Ouvert jusqu’à 18:00"), '' when unknown (clients only).
  function hoursText(e) {
    const h = e.gbp && e.gbp.hours, s = h && typeof Hours !== 'undefined' && Hours.short(h);
    return s ? T.hoursShort(s.text) : '';
  }
  // Full accessible name of a list row: kind, name, town, priority or status, visit order, today's hours.
  function rowLabel(kind, e, order) {
    return [label(kind, e, order), e.city || town(e), hoursText(e)].filter(Boolean).join(', ');
  }

  // One row of the "Sur la carte" list and of the overlap pick-list. One control; no separator characters in the text:
  // the name, the town on its own line, then the priority or "glyph + status word" on one line.
  function row(kind, e, order, selected) {
    const key = `os:${kind}:${e.id}`;
    let sub;
    if (kind === 'client') {
      const t = tierOf(e);
      sub = (t ? `<span class="sub">Priorité ${esc(t)}</span>` : '') + (order ? `<span class="sub">Visite ${esc(order)} aujourd’hui</span>` : '');
    } else {
      const meta = Views.PROSPECT_STATUS[Views.statusKey(e)];
      sub = `<span class="sub stext ${meta.cls}"><span aria-hidden="true">${meta.mark}</span> ${esc(meta.label)}</span>`;
    }
    const where = e.city || town(e);
    return `<button type="button" class="row row-os${selected ? ' sel' : ''}" data-act="os-open" data-kind="${kind}" data-id="${esc(e.id)}" data-key="${esc(key)}" aria-label="${esc(rowLabel(kind, e, order))}"${selected ? ' aria-current="true"' : ''}>`
      + `<span class="os-g" aria-hidden="true">${glyph(kind, e, order)}</span><span class="grow"><span class="name">${esc(e.name)}</span>`
      + `${where ? `<span class="sub">${esc(where)}</span>` : ''}${sub}</span></button>`;
  }

  return { safeColor, inkFor, tierOf, todayOrders, label, glyph, row };
})();

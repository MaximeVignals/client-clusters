// Opening hours and Google business page matching (no DOM, no network: pure functions).
// Hours use Google's format: { periods: [{ open: {day, hour, minute}, close: {day, hour, minute} }] }
// with day 0 = Sunday. A period with no "close" means open 24/7.
(function (root) {
  'use strict';
  const Cluster = typeof module !== 'undefined' && module.exports ? require('./cluster') : root.Cluster;

  const WEEK = 7 * 1440;
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];
  const pad = n => String(n).padStart(2, '0');
  const fmt = m => { m = ((m % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
  // Closing time: "18:30", "midnight", or "Tue 02:00" when it isn't on the same day as t.
  const fmtEnd = (end, t) => {
    const sameDay = Math.floor((end - 1) / 1440) === Math.floor(t / 1440);
    if (sameDay) return end % 1440 === 0 ? 'midnight' : fmt(end);
    return `${DAY_SHORT[Math.floor(end / 1440) % 7]} ${fmt(end)}`;
  };
  const minOfWeek = d => d.getDay() * 1440 + d.getHours() * 60 + d.getMinutes();

  // [start, end) in minutes of the week; end can go past the end of the week (Saturday night).
  function intervals(hours) {
    const out = [];
    for (const p of (hours && hours.periods) || []) {
      if (!p || !p.open) continue;
      if (!p.close) return [[0, WEEK + 1440]]; // open 24/7
      const s = p.open.day * 1440 + (p.open.hour || 0) * 60 + (p.open.minute || 0);
      let e = p.close.day * 1440 + (p.close.hour || 0) * 60 + (p.close.minute || 0);
      if (e <= s) e += WEEK;
      out.push([s, e]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  }
  const known = hours => !!(hours && Array.isArray(hours.periods) && hours.periods.length);
  const always = iv => iv.length === 1 && iv[0][0] === 0 && iv[0][1] >= WEEK;

  // Openings that overlap a weekday, including carry-over from the previous night.
  // Keep an end beyond midnight so a visit starting late can still fit before closing.
  function dayRanges(hours, weekday) {
    if (!known(hours)) return null;
    const iv = intervals(hours);
    if (always(iv)) return [[0, 1440 * 2]];
    const start = weekday * 1440, ranges = [];
    for (const [s, e] of iv) for (const shift of [-WEEK, 0]) {
      if (s + shift < start + 1440 && e + shift > start) {
        ranges.push([Math.max(0, s + shift - start), e + shift - start]);
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push(range);
    }
    return merged;
  }

  // When does the opening that contains minute t end? Follows openings that start right as the previous one ends.
  function openUntil(iv, t) {
    for (const shift of [0, -WEEK]) {
      for (const [s, e] of iv) {
        const S = s + shift, E = e + shift;
        if (t >= S && t < E) {
          let end = E, grew = true, guard = 0;
          while (grew && guard++ < 20) {
            grew = false;
            for (const [s2, e2] of iv) for (const k of [0, WEEK, -WEEK]) {
              if (s2 + k <= end && e2 + k > end) { end = e2 + k; grew = true; }
            }
            if (end - t > WEEK) break;
          }
          return end;
        }
      }
    }
    return null;
  }
  function nextOpening(iv, t) {
    let best = null;
    for (const [s] of iv) for (const k of [0, WEEK]) { const S = s + k; if (S > t && (best === null || S < best)) best = S; }
    return best;
  }

  /** Status now: { open: true|false, text } or null when hours are unknown. */
  function status(hours, now = new Date()) {
    if (!known(hours)) return null;
    const iv = intervals(hours);
    if (always(iv)) return { open: true, text: 'Open 24 hours' };
    const t = minOfWeek(now);
    const end = openUntil(iv, t);
    if (end !== null) {
      return { open: true, text: `Open · closes ${fmtEnd(end, t)}`, closesIn: end - t };
    }
    const nx = nextOpening(iv, t);
    if (nx === null) return { open: false, text: 'Closed' };
    const sameDay = Math.floor(nx / 1440) === Math.floor(t / 1440);
    const tomorrow = Math.floor(nx / 1440) === Math.floor(t / 1440) + 1;
    return { open: false, text: `Closed · opens ${sameDay ? '' : tomorrow ? 'tomorrow ' : DAY_SHORT[Math.floor(nx / 1440) % 7] + ' '}${fmt(nx)}`, opensIn: nx - t };
  }

  /** Very short text for lists: "Open till 18:30", "Opens 14:00", "Closed today". */
  function short(hours, now = new Date()) {
    if (!known(hours)) return null;
    const iv = intervals(hours);
    if (always(iv)) return { cls: 'open', text: 'Open 24h' };
    const t = minOfWeek(now);
    const end = openUntil(iv, t);
    if (end !== null) {
      return { cls: end - t <= 45 ? 'soon' : 'open', text: `Open till ${fmtEnd(end, t)}` };
    }
    const nx = nextOpening(iv, t);
    const dayEnd = (Math.floor(t / 1440) + 1) * 1440;
    if (nx !== null && nx < dayEnd) return { cls: 'later', text: `Opens ${fmt(nx)}` };
    const openedToday = iv.some(([s, e]) => [0, WEEK, -WEEK].some(k => s + k < dayEnd && e + k > dayEnd - 1440));
    return { cls: 'closed', text: openedToday ? 'Closed for today' : 'Closed today' };
  }

  /** One line per day, Monday first: [{ day: 1, name: 'Monday', text: '09:00–12:00, 14:00–18:30' }]. */
  function weekLines(hours) {
    const iv = intervals(hours);
    const all = always(iv);
    return MONDAY_FIRST.map(d => {
      if (all) return { day: d, name: DAY_NAMES[d], text: 'Open 24 hours', ranges: [[0, 1440]] };
      const mine = iv.filter(([s]) => Math.floor(s / 1440) % 7 === d);
      const ranges = mine.map(([s, e]) => [s - d * 1440, e - d * 1440]);
      let text;
      if (!mine.length) text = 'Closed';
      else if (ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] >= 1440) text = 'Open 24 hours';
      else text = ranges.map(([s, e]) => `${fmt(s)}–${e === 1440 ? '24:00' : fmt(e)}`).join(', ');
      return { day: d, name: DAY_NAMES[d], text, ranges };
    });
  }
  const weekText = hours => (known(hours) ? weekLines(hours).map(l => `${l.name.slice(0, 3)} ${l.text}`).join('\n') : '');

  // ---------- Hours typed by hand ----------
  // Accepts "9-12, 14-18:30", "9h-12h / 14h-18h30", "09:00–12:00 14:00–18:00", "closed"/"fermé", "24h".
  function parseDay(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t || /^(ferm|closed|clos\b|close\b|-+$|—|x$|no$|non$)/.test(t)) return [];
    if (/^(open\s*)?(24\s*h(ours)?|24\s*\/\s*24|24h\s*\/\s*24|ouvert\s*24\s*h(\s*\/\s*24)?|open 24 hours)$/.test(t)) return [[0, 1440]];
    const re = /(\d{1,2})(?:\s*[h:.](\d{2})|\s*h)?/g; // "9h30", "9:30", "9h", "9" — but "12h 14h" is two times
    const times = [];
    let m;
    while ((m = re.exec(t))) {
      const h = +m[1], mi = m[2] ? +m[2] : 0;
      if (h > 24 || mi > 59 || (h === 24 && mi)) throw new Error(`“${m[0].trim()}” is not a time.`);
      times.push(h * 60 + mi);
    }
    if (!times.length || times.length % 2) throw new Error('Write each opening as start–end, e.g. 9:00–12:00, 14:00–18:30 (or “closed”).');
    const out = [];
    for (let i = 0; i < times.length; i += 2) {
      const s = times[i];
      let e = times[i + 1];
      if (s === 1440) throw new Error('An opening can\'t start at 24:00.');
      if (e <= s) e += 1440; // past midnight
      out.push([s, e]);
    }
    return out;
  }
  /** lines: 7 strings, Monday first. Returns { periods } or throws Error with .day (0 = Monday). */
  function parseWeek(lines) {
    const periods = [];
    lines.forEach((line, i) => {
      let ranges;
      try { ranges = parseDay(line); } catch (err) { err.day = i; throw err; }
      const d = MONDAY_FIRST[i];
      for (const [s, e] of ranges) {
        const cd = (d + Math.floor(e / 1440)) % 7, cm = e % 1440;
        periods.push({ open: { day: d, hour: Math.floor(s / 60), minute: s % 60 }, close: { day: cd, hour: Math.floor(cm / 60), minute: cm % 60 } });
      }
    });
    return { periods };
  }
  const toLines = hours => (known(hours) ? weekLines(hours).map(l => l.text) : new Array(7).fill(''));

  // ---------- Matching a client with Google results ----------
  const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const STOP = new Set('sarl sas sa sasu eurl sci snc selarl scp ets etablissements etab ste sté societe ltd gmbh le la les l de du des d et and the chez au aux en sur a s'.split(' '));
  // Words that say what kind of business it is but not which one: they count for little.
  const GENERIC = new Set(('boulangerie patisserie pharmacie garage restaurant resto cafe bar brasserie bistrot hotel tabac presse salon coiffure coiffeur ' +
    'boucherie charcuterie fleuriste fleurs opticien optique librairie epicerie cave caviste atelier magasin boutique cabinet agence ' +
    'supermarche superette marche station service auto automobiles carrosserie institut beaute centre commerce shop store sa sas ' +
    'quincaillerie bricolage pressing laverie traiteur fromagerie primeur poissonnerie')
    .split(' '));
  const toks = s => [...new Set(norm(s).split(' ').filter(t => t && !STOP.has(t) && (t.length > 1 || /\d/.test(t))))];
  const weight = t => (GENERIC.has(t) ? 0.3 : 1);
  function close1(a, b) { // one letter different, added or missing
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, diff = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++diff > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return diff + (a.length - i) + (b.length - j) <= 1;
  }
  const tokMatch = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) || (a.length >= 5 && b.length >= 5 && close1(a, b));

  /** 0..1, how likely two business names are the same business. */
  function nameSimilarity(a, b) {
    const ta = toks(a), tb = toks(b);
    if (!ta.length || !tb.length) return 0;
    const wa = ta.reduce((s, t) => s + weight(t), 0), wb = tb.reduce((s, t) => s + weight(t), 0);
    let hit = 0;
    for (const x of ta) if (tb.some(y => tokMatch(x, y))) hit += weight(x);
    let sim = 0.7 * Math.min(1, hit / Math.min(wa, wb)) + 0.3 * Math.min(1, hit / Math.max(wa, wb));
    // One name written inside the other ("Leclerc" / "E.Leclerc Bron"), unless the shorter one is only generic words.
    const na = norm(a).replace(/ /g, ''), nb = norm(b).replace(/ /g, '');
    const shorter = na.length <= nb.length ? ta : tb;
    if (shorter.some(t => !GENERIC.has(t)) && na.length >= 5 && nb.length >= 5 && (na.includes(nb) || nb.includes(na))) sim = Math.max(sim, 0.9);
    return Math.min(1, sim);
  }

  // Straight-line distance, shared with cluster.js.
  const distanceKm = (a, b) => Cluster.distanceKm(a, b);

  /**
   * Score Google results for a client and decide whether one is a sure match.
   * client: { name, postcode, address, lat?, lng?, preciseLocation: bool }
   * Returns { match: candidate|null, candidates: [...sorted, with sim, dist, pcMatch] }.
   */
  function judge(client, places) {
    const located = client.preciseLocation && Number.isFinite(client.lat) && Number.isFinite(client.lng);
    // The postal code goes into a search pattern: characters with a special meaning there are neutralised.
    const pc = String(client.postcode || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const num = (/^\s*(\d+)/.exec(client.address || '') || [])[1];
    const scored = places.map(p => {
      const sim = nameSimilarity(client.name, p.name);
      const dist = located && Number.isFinite(p.lat) ? distanceKm(client, p) : null;
      const pcMatch = !!(pc && p.address && new RegExp('\\b' + pc + '\\b').test(p.address));
      const numMatch = !!(num && p.address && new RegExp('(^|[\\s,])' + num + '([\\s,]|bis|ter|$)', 'i').test(p.address));
      const closed = p.status === 'CLOSED_PERMANENTLY';
      let score = sim + (pcMatch ? 0.05 : 0) + (numMatch ? 0.05 : 0) - (closed ? 0.2 : 0);
      if (dist !== null) score -= Math.min(0.5, dist / 4);
      return { ...p, sim: Math.round(sim * 100) / 100, dist: dist === null ? null : Math.round(dist * 1000) / 1000, pcMatch, numMatch, closed, score };
    }).sort((a, b) => b.score - a.score);
    const sure = s => !s.closed && (
      (s.sim >= 0.75 && (s.dist !== null ? (s.dist <= 0.35 || (s.dist <= 1.5 && (s.pcMatch || s.numMatch))) : (s.pcMatch && (s.numMatch || s.sim >= 0.9)))) ||
      (s.sim >= 0.55 && s.dist !== null && s.dist <= 0.12 && (s.pcMatch || s.numMatch)));
    const best = scored[0];
    let match = best && sure(best) ? best : null;
    // Two results that fit equally well (e.g. two branches of a chain next to each other): let the user choose.
    if (match && scored.slice(1).some(o => o.id !== best.id && sure(o) && o.sim >= best.sim - 0.1)) match = null;
    return { match, candidates: scored };
  }

  const api = { status, short, weekLines, weekText, parseDay, parseWeek, toLines, dayRanges, known, nameSimilarity, judge, norm, DAY_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Hours = api;
})(typeof window !== 'undefined' ? window : globalThis);

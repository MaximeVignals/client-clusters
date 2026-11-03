/* Client Clusters — renderer: shared helpers: escaping, dates, formatting, colours */
'use strict';

// =====================================================================
// Utilities
// =====================================================================
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const norm = Hours.norm; // accent- and case-insensitive text for comparisons

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isoToDate(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
function daysSince(iso) {
  if (!iso) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((t - isoToDate(iso)) / 86400000));
}
const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDate = iso => (iso ? dateFmt.format(isoToDate(iso)) : '');
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDay = iso => (iso ? dayFmt.format(isoToDate(iso)) : '');
const shortDateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const fmtShort = iso => (iso ? shortDateFmt.format(isoToDate(iso)) : '');
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function addDaysISO(iso, n) {
  const d = isoToDate(iso); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Next Monday–Friday after `iso` (or `iso` itself when allowed).
function nextWorkday(iso, includeSelf = false) {
  let d = includeSelf ? iso : addDaysISO(iso, 1);
  while ([0, 6].includes(isoToDate(d).getDay())) d = addDaysISO(d, 1);
  return d;
}
function fmtAgo(days) {
  if (days === null || days === undefined) return 'Never visited';
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `${Math.round(days / 30.4)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}
function shortAgo(days) {
  if (days === null || days === undefined) return 'Never';
  if (days === 0) return 'Today';
  if (days < 60) return `${days} d`;
  if (days < 730) return `${Math.round(days / 30.4)} mo`;
  return `${Math.round(days / 365)} y`;
}

// Parse dates as found in spreadsheets: 2025-03-14, 14/03/2025, 14-03-25, Excel serials.
function parseDateLoose(s) {
  s = String(s ?? '').trim();
  if (!s) return null;
  let m;
  const ok = (y, mo, d) => {
    if (y < 100) y += 2000;
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return ok(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/))) return ok(+m[3], +m[2], +m[1]); // day first
  if (/^\d{5}(\.\d+)?$/.test(s)) { // Excel serial date
    const n = parseFloat(s);
    if (n > 20000 && n < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
      return ok(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
  }
  return null;
}
function parseCoord(s, max) {
  const v = parseFloat(String(s ?? '').replace(',', '.').trim());
  return Number.isFinite(v) && Math.abs(v) <= max ? v : null;
}
// Title-case only text typed all in capitals or all in lower case; keep "Villefranche-sur-Saône" as is.
const titleCase = s => (String(s) !== String(s).toUpperCase() && String(s) !== String(s).toLowerCase()) ? String(s) : String(s).toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

const PALETTE = ['#2563eb', '#d9480f', '#0f8a6c', '#9333ea', '#c2185b', '#0e7490', '#a16207', '#4338ca', '#15803d', '#b91c1c', '#0369a1', '#8d5524'];
const STATUS_COLORS = { ok: '#2e8a57', due: '#d08a1d', late: '#c4402c', never: '#8b8d86' };
const NEVER = 1e6;

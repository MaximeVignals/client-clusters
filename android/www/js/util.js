// Small helpers shared by the phone screens. Classic script: defines global `U` and `$`.
'use strict';

const $ = sel => document.querySelector(sel);

const U = (() => {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Local calendar date (not UTC), like the desktop app.
  function todayISO(d = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function uid() {
    const c = globalThis.crypto;
    if (c && c.randomUUID) return 'p' + c.randomUUID().replace(/-/g, '').slice(0, 16);
    const b = new Uint8Array(8); c.getRandomValues(b);
    return 'p' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }

  function fmtDate(iso) {
    const d = new Date(iso + 'T12:00:00');
    return isNaN(d) ? String(iso) : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  function fmtTime(ms) {
    if (!ms) return 'never';
    const d = new Date(ms);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  const looksLikeDate = s => /^\d{4}-\d{1,2}-\d{1,2}/.test(s) || /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/.test(s);

  // Phone numbers: imported columns that look like phone numbers, plus the Google page phone.
  function phonesOf(e) {
    const found = [];
    const add = (raw, key, strict) => {
      const s = String(raw == null ? '' : raw).trim();
      const digits = s.replace(/\D/g, '');
      if (!s || !/^\+?[\d\s().\-/]+$/.test(s) || looksLikeDate(s)) return;
      const named = /t[eé]l|phone|mobile|gsm|portable|fixe/i.test(key || '');
      if (strict) { if (digits.length < 8 || digits.length > 15) return; }
      else if (named) { if (digits.length < 8 || digits.length > 15) return; }
      else if (!(s[0] === '+' || /^0\d/.test(s)) || digits.length < 9 || digits.length > 15) return;
      const id = digits.slice(-9);
      if (found.some(f => f.id === id)) return;
      found.push({ id, text: s, tel: (s[0] === '+' ? '+' : '') + digits });
    };
    if (e && e.gbp && e.gbp.phone) add(e.gbp.phone, 'phone', true);
    for (const [k, v] of Object.entries((e && e.extra) || {})) add(v, k, false);
    return found;
  }

  const hasLoc = e => e && Number.isFinite(e.lat) && Number.isFinite(e.lng);
  const addressLine = e => [e.address, [e.postcode, e.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  function navUrl(e) {
    const dest = hasLoc(e) ? `${e.lat},${e.lng}` : encodeURIComponent(addressLine(e));
    return `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
  }

  return { esc, todayISO, uid, fmtDate, fmtTime, phonesOf, hasLoc, addressLine, navUrl };
})();

// French (fr-FR) strings and date helpers for the phone screens. Classic script: defines global `T`.
// Strings produced by the shared libs (lib/hours.js, lib/visits.js, js/sync.js) stay English there and are mapped here at display time.
'use strict';

const T = (() => {
  const NB = '\u00a0';           // non-breaking space (before : ; ? ! and inside « »)
  const q = s => '«' + NB + s + NB + '»';
  const LOCALE = 'fr-FR';
  const toDate = x => (x instanceof Date ? x : typeof x === 'number' ? new Date(x) : new Date(String(x) + 'T12:00:00'));
  const fmt = (opts, x) => { const d = toDate(x); return isNaN(d) ? String(x) : new Intl.DateTimeFormat(LOCALE, opts).format(d); };
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  // "mardi 10 novembre"
  const fmtDay = (x = new Date()) => fmt({ weekday: 'long', day: 'numeric', month: 'long' }, x);
  // "mar. 10 nov. 2026"
  const fmtDate = iso => fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }, iso);
  // "14:32"
  const fmtTime = ms => (ms ? fmt({ hour: '2-digit', minute: '2-digit' }, ms) : '');
  // "aujourd’hui à 14:32", "hier à 14:32", "le 3 nov. à 14:32", "jamais"
  function fmtRelative(ms) {
    if (!ms) return 'jamais';
    const d = new Date(ms), now = new Date(), y = new Date(now.getTime() - 864e5);
    const time = fmtTime(ms);
    if (sameDay(d, now)) return `aujourd’hui à ${time}`;
    if (sameDay(d, y)) return `hier à ${time}`;
    return `le ${fmt({ day: 'numeric', month: 'short' }, ms)} à ${time}`;
  }
  const dayNum = iso => { const d = toDate(iso); return isNaN(d) ? '' : String(d.getDate()); };
  const monthShort = iso => fmt({ month: 'short' }, iso);
  const dayName = d => fmt({ weekday: 'long' }, new Date(2024, 0, 7 + d)); // 0 = Sunday (7 Jan 2024)

  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  function todaySummary(planned, unconfirmed) {
    if (!planned && !unconfirmed) return 'Rien de prévu';
    const parts = [];
    parts.push(planned ? plural(planned, 'visite prévue', 'visites prévues') : 'Aucune visite prévue');
    if (unconfirmed) parts.push(`${unconfirmed} à confirmer`);
    return parts.join(', ');
  }

  // ----- opening hours (lib/hours.js output, English) -----
  const DAY_FR = { Sun: 'dim.', Mon: 'lun.', Tue: 'mar.', Wed: 'mer.', Thu: 'jeu.', Fri: 'ven.', Sat: 'sam.' };
  const endAt = s => { // "18:30" | "midnight" | "Tue 02:00"
    if (s === 'midnight') return 'à minuit';
    const m = /^([A-Z][a-z]{2}) (\d\d:\d\d)$/.exec(s);
    return m ? `${DAY_FR[m[1]] || m[1]} ${m[2]}` : `à ${s}`;
  };
  function hoursShort(t) {
    let m;
    if (t === 'Open 24h') return 'Ouvert 24 h/24';
    if ((m = /^Open till (.+)$/.exec(t))) { const e = endAt(m[1]); return `Ouvert jusqu’${e.startsWith('à ') ? e : 'à ' + e}`; }
    if ((m = /^Opens (\d\d:\d\d)$/.exec(t))) return `Ouvre à ${m[1]}`;
    if (t === 'Closed for today') return 'Fermé pour la journée';
    if (t === 'Closed today') return 'Fermé aujourd’hui';
    return t;
  }
  function hoursStatus(t) {
    let m;
    if (t === 'Open 24 hours') return 'Ouvert 24 h/24';
    if ((m = /^Open · closes (.+)$/.exec(t))) return `Ouvert, ferme ${endAt(m[1])}`;
    if (t === 'Closed') return 'Fermé';
    if ((m = /^Closed · opens (.*)$/.exec(t))) {
      const r = m[1];
      if (/^tomorrow (\d\d:\d\d)$/.test(r)) return `Fermé, ouvre demain à ${r.slice(-5)}`;
      const d = /^([A-Z][a-z]{2}) (\d\d:\d\d)$/.exec(r);
      if (d) return `Fermé, ouvre ${DAY_FR[d[1]] || d[1]} à ${d[2]}`;
      return `Fermé, ouvre à ${r}`;
    }
    return t;
  }
  const hoursLine = t => (t === 'Closed' ? 'Fermé' : t === 'Open 24 hours' ? 'Ouvert 24 h/24' : t);

  const SYNC_ERRORS = {
    'Sync key mismatch. Pair again with a new code from the PC': 'La clé de synchro ne correspond plus. Appairez à nouveau avec un nouveau code du PC.',
    'The sync server was reset. Your unsent changes are kept. Pair again, or remove the data from this phone': 'Le serveur de synchro a été réinitialisé. Vos changements non envoyés sont conservés. Appairez à nouveau, ou supprimez les données de ce téléphone.',
    'The sync server went back to an older state. Sync is paused. Check the server, then pair again': 'Le serveur de synchro est revenu à un état plus ancien. La synchro est en pause. Vérifiez le serveur, puis appairez à nouveau.',
    'The sync server sent an unexpected answer. Your changes are kept and will be sent later': 'Le serveur de synchro a envoyé une réponse inattendue. Vos changements sont conservés et seront envoyés plus tard.',
    'The relay storage is full': 'Le stockage du relais est plein.',
    'A change is too large for the relay': 'Un changement est trop volumineux pour le relais.',
    'Open the Windows app once so it can share your data': 'Ouvrez une fois l’application Windows pour qu’elle partage vos données.',
  };

  return {
    NB, q, fmtDay, fmtDate, fmtTime, fmtRelative, dayNum, monthShort, dayName, plural, todaySummary,
    hoursShort, hoursStatus, hoursLine, syncError: t => SYNC_ERRORS[t] || 'La synchro a échoué. Réessayez plus tard.',
    appName: 'Client Clusters',
    // Map: filters, "Sur la carte" list, cluster label
    map: {
      filters: 'Filtres', showAll: 'Tout afficher', clients: 'Clients', prospects: 'Prospects', today: 'Prévues aujourd’hui', noPrio: 'Sans priorité',
      group: 'Filtres de la carte', onMap: n => (n ? `${n} sur la carte` : 'Rien dans cette zone'),
      more: n => (n > 1 ? `Zoomez pour voir les ${n} autres.` : 'Zoomez pour voir l’autre.'),
      cluster: (n, c, p, tight) => `${n} éléments${NB}: ${[c ? plural(c, 'client', 'clients') : '', p ? plural(p, 'prospect', 'prospects') : ''].filter(Boolean).join(', ')}. ${tight ? 'Touchez pour voir la liste.' : 'Touchez pour zoomer.'}`,
      todayOnly: 'Seules les visites prévues aujourd’hui sont affichées.', tilesOff: 'Fond de carte indisponible hors ligne', layers: 'Fond de carte',
      see: 'Voir sur la carte',
      emptyFilters: 'Rien ne correspond à ces filtres.', emptyView: 'Déplacez ou zoomez la carte pour voir d’autres éléments.',
    },
    // Empty and error states
    empty: {
      clients: 'Aucun client sur ce téléphone.', clientsHint: 'Vos clients arriveront du PC à la prochaine synchro.',
      prospects: 'Aucun prospect pour l’instant.', prospectsHint: 'Les prospects importés sur le PC apparaîtront ici après la prochaine synchro.',
      syncNow: 'Synchroniser maintenant', retry: 'Réessayer', loading: 'Chargement…',
    },
    tabs: { today: 'Aujourd’hui', map: 'Carte', prospects: 'Prospects', settings: 'Réglages' },
    sync: { off: 'Synchro désactivée', ok: 'Synchronisé', busy: 'Synchronisation…', offline: 'Hors ligne', error: 'Échec de la synchro', disconnected: 'Non connecté' },
    status: { todo: 'À contacter', visited: 'Visité', converted: 'Converti', no: 'Pas intéressé' },
    types: { visit: 'Visite', call: 'Appel téléphonique' },
    outcomes: { '': 'Résultat non précisé', ok: 'Bien passé', order: 'Commande prise', followup: 'À relancer', absent: 'Personne sur place', closed: 'Fermé à l’arrivée' },
    visitStatus: { planned: 'Prévue', unconfirmed: 'À confirmer', done: 'Faite', cancelled: 'Pas eu lieu' },
  };
})();

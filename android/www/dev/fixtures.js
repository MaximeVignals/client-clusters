// DEV ONLY. Invented demo data for the phone UI, shaped like app.proj (the projection the phone gets in data.json).
// Every name, address and phone number here is made up. Deterministic: seeded PRNG, dates relative to "today".
// Not part of the real app: only loaded by index.html, and only used when demo.js activates.
(function (root) {
  'use strict';

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (n, base) => { const d = new Date((base || new Date()).getTime()); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return iso(d); };

  // Invented towns in a rural area (Cantal / Aveyron), with a made-up postcode each.
  const TOWNS = [
    { name: 'Saint-Aubin-des-Landes', pc: '15120', lat: 44.62, lng: 2.55 },
    { name: 'Montferrand-le-Bas', pc: '12210', lat: 44.45, lng: 2.38 },
    { name: 'Roquefeuil-sur-Cère', pc: '15800', lat: 44.80, lng: 2.70 },
    { name: 'La Bastide-Sainte-Hélène', pc: '15350', lat: 44.52, lng: 2.85 },
    { name: "Cazals-d'Entraygues", pc: '12140', lat: 44.66, lng: 2.30 },
    { name: 'Vieillevie-la-Haute', pc: '12390', lat: 44.38, lng: 2.62 },
    { name: 'Lacapelle-des-Monts', pc: '15600', lat: 44.75, lng: 2.95 },
    { name: 'Pons-de-Rouergue', pc: '12320', lat: 44.33, lng: 2.90 },
  ];
  const TOWN_GROUP = [0, 1, 1, 2, 2, 3, 4, 4]; // group index per town
  const GROUPS = [
    { id: 'g1', number: 1, name: 'Plateau nord', color: '#2563eb' },
    { id: 'g2', number: 2, name: '', color: '#d9480f' },
    { id: 'g3', number: 3, name: 'Vallée de la Cère', color: '#0f8a6c' },
    { id: 'g4', number: 4, name: '', color: '#9333ea' },
    { id: 'g5', number: 5, name: 'Rouergue sud', color: '#c2185b' },
  ];

  const STREETS = ['rue des Châtaigniers', 'avenue de la Gare', 'chemin des Genêts', 'place du Foirail', 'route de Salers', 'impasse des Noyers', 'rue du Moulin', 'boulevard des Estives', 'rue Basse', 'allée des Tilleuls', 'route du Lioran', 'rue de la Fontaine'];
  const SURNAMES = ['Vercors', 'Lagarrigue', 'Bonnefoux', 'Delmas-Roque', 'Fabrègues', 'Castanet', 'Soulacroix', 'Peyrelade', 'Montalbert', 'Cabanac', 'Rouquette', 'Ganhac', 'Arpajol', 'Laveissière', 'Clauzel', 'Bédouès', 'Viallefont', 'Sarrazac', 'Mazeyrac', 'Tournemire'];
  const C_KINDS = ['Garage', 'Boulangerie', 'Ferme', 'Auberge', 'Épicerie', 'Menuiserie', 'Cave', 'Quincaillerie', 'Atelier', 'Coopérative', 'Pharmacie', 'Camping', 'Fromagerie', 'Électricité'];
  const P_KINDS = ['Garage', 'Boulangerie', 'Ferme', 'Auberge', 'Épicerie', 'Menuiserie', 'Cave', 'Quincaillerie', 'Atelier', 'Camping', 'Salon', 'Transports', 'Scierie', 'Boucherie'];
  const NOTES = ['Préfère être appelé avant 9 h.', 'Parking derrière le bâtiment.', 'Demander Mme Delmas à l’accueil.', 'Sonnette en panne : frapper à la porte latérale.', 'Intéressé par la gamme été, rappeler en mars.'];
  const LONG_NOTE = 'Client historique du secteur. Le gérant souhaite être prévenu la veille de chaque passage, de préférence par SMS. Le portail est fermé entre 12 h et 14 h ; passer par la cour arrière, côté atelier, et demander Laurent ou sa sœur. Dernier échange : réclamation sur une livraison incomplète, à vérifier lors de la prochaine visite avant toute nouvelle proposition commerciale. Ne pas oublier les échantillons.';
  const LONG_NAMES = [
    'Société coopérative agricole des producteurs de châtaignes et de fruits secs du plateau de Saint-Aubin',
    'Établissements Lagarrigue et fils – Transports, location de matériel et travaux publics du Haut-Rouergue',
    'Association départementale pour la valorisation des produits fermiers et du patrimoine rural',
  ];

  const hoursWeek = (days, ranges) => ({ periods: days.flatMap(d => ranges.map(([a, b]) => ({ open: { day: d, hour: Math.floor(a / 60), minute: a % 60 }, close: { day: d, hour: Math.floor(b / 60), minute: b % 60 } }))) });
  const HOURS = [
    () => hoursWeek([1, 2, 3, 4, 5], [[540, 720], [840, 1080]]),
    () => hoursWeek([1, 2, 3, 4, 5, 6], [[480, 1200]]),
    () => hoursWeek([2, 3, 4, 5, 6], [[510, 750], [870, 1140]]),
    () => hoursWeek([1, 2, 3, 4, 5], [[420, 1000]]),
    () => ({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] }), // open 24/7
  ];

  function build(base) {
    const rnd = mulberry32(20261110);
    const pick = a => a[Math.floor(rnd() * a.length)];
    const jit = (v, s) => Math.round((v + (rnd() - 0.5) * 2 * s) * 1e6) / 1e6;
    const phone = () => `06 00 00 ${pad(Math.floor(rnd() * 100))} ${pad(Math.floor(rnd() * 100))}`;
    let vseq = 0;
    const visit = (date, o) => Object.assign({ id: 'v' + String(++vseq).padStart(4, '0'), date, note: '', type: 'visit', outcome: '', status: 'done' }, o);

    const proj = { clients: {}, groups: {}, prospects: {}, settings: {} };
    GROUPS.forEach(g => { proj.groups[g.id] = Object.assign({}, g); });

    // ---------- clients ----------
    const N = 40, noCoords = new Set([17, 29, 36]);
    const clientList = [];
    for (let i = 0; i < N; i++) {
      const ti = i % TOWNS.length, t = TOWNS[ti];
      const id = 'c' + String(i + 1).padStart(3, '0');
      let name = i < 3 ? LONG_NAMES[i] : `${pick(C_KINDS)} ${pick(SURNAMES)}`;
      if (i === 3) name = 'Boulangerie-pâtisserie artisanale Peyrelade & Fils – Maison fondée en 1921 (2 points de vente)';
      const c = {
        id, name,
        address: i % 9 === 8 ? '' : `${1 + Math.floor(rnd() * 80)} ${pick(STREETS)}`,
        postcode: t.pc, city: t.name, country: 'FR',
        lat: noCoords.has(i) ? null : jit(t.lat, 0.03), lng: noCoords.has(i) ? null : jit(t.lng, 0.04),
        groupId: GROUPS[TOWN_GROUP[ti]].id,
        tier: ['A', 'B', 'C', ''][i % 4],
        notes: i % 5 === 0 ? '' : i === 1 || i === 10 ? LONG_NOTE : pick(NOTES),
        extra: {}, gbp: null, visits: {},
      };
      if (i % 6 !== 5) c.extra['Téléphone'] = phone();
      if (i % 11 === 0) c.extra['Mobile'] = phone();
      if (i % 3 !== 2) { // some clients have no hours at all
        c.gbp = { hours: HOURS[i % HOURS.length](), phone: null, website: null, url: null };
        if (i % 7 === 0) c.gbp.phone = `05 00 00 ${pad(i)} ${pad(40 + i)}`;
      }
      clientList.push(c);
      proj.clients[id] = c;
    }
    const add = (c, v) => { c.visits[v.id] = v; };

    // Planned today (4 to 6; here 5), ordered.
    for (let k = 0; k < 5; k++) add(clientList[k], visit(addDays(0, base), { status: 'planned', order: k + 1, type: k === 3 ? 'call' : 'visit', note: k === 0 ? 'Apporter le catalogue 2027.' : '' }));
    // Planned in the past = not confirmed (3).
    [-2, -5, -9].forEach((d, k) => add(clientList[5 + k], visit(addDays(d, base), { status: 'planned', note: k === 1 ? LONG_NOTE.slice(0, 120) : '' })));
    // Planned in the future (4).
    [1, 3, 7, 14].forEach((d, k) => add(clientList[8 + k], visit(addDays(d, base), { status: 'planned', type: k === 2 ? 'call' : 'visit' })));
    // Didn't happen (3).
    [-1, -6, -20].forEach((d, k) => add(clientList[12 + k], visit(addDays(d, base), { status: 'cancelled', note: k === 0 ? 'Reporté par le client.' : '' })));
    // Done history for everyone else, cycling through every type and outcome.
    const OUT = ['', 'ok', 'order', 'followup', 'absent', 'closed'];
    let oi = 0;
    for (let i = 0; i < N; i++) {
      if (i === 39) continue; // never visited
      const c = clientList[i];
      const count = i === 15 ? 12 : i < 5 ? 2 : 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < count; k++) {
        const days = -(3 + k * 24 + Math.floor(rnd() * 20) + (i % 8) * 6);
        const out = OUT[oi++ % OUT.length], type = oi % 5 === 0 ? 'call' : 'visit';
        const v = visit(addDays(days, base), { type, outcome: out, note: k === 0 && i % 4 === 0 ? 'Commande de printemps confirmée, livraison sous 15 jours.' : '' });
        if (i % 10 === 4 && k === 0) v.confirmedFrom = 'planned';
        add(c, v);
      }
    }

    // ---------- prospects ----------
    const STATUS = ['todo', 'todo', 'todo', 'visited', 'visited', 'converted', 'no'];
    const pros = [];
    const mkP = (ti, lat, lng, i) => {
      const t = TOWNS[ti], id = 'p' + String(pros.length + 1).padStart(3, '0');
      const n = pros.length;
      const p = {
        id, name: n === 7 ? 'Entreprise générale de maçonnerie, couverture et rénovation du bâtiment Mazeyrac-Clauzel et associés' : `${pick(P_KINDS)} ${pick(SURNAMES)}`,
        address: n % 10 === 3 ? '' : `${1 + Math.floor(rnd() * 60)} ${pick(STREETS)}`,
        postcode: n % 13 === 4 ? '' : t.pc, city: n % 13 === 4 ? '' : t.name, country: 'FR',
        lat, lng, status: STATUS[Math.floor(rnd() * STATUS.length)],
        notes: n % 4 === 0 ? '' : n === 11 ? LONG_NOTE : pick(NOTES),
        group: null, extra: {},
      };
      if (n % 3 === 0) p.extra['Téléphone'] = phone();
      pros.push(p);
      return p;
    };
    [0, 1, 2].forEach((ti, k) => {
      const t = TOWNS[ti], count = 40 - k * 5; // 40, 35, 30
      const placed = [];
      for (let i = 0; i < count; i++) {
        let lat, lng;
        if (i > 0 && i % 6 === 0) { // within ~13 m of an earlier one
          const q = placed[Math.floor(rnd() * placed.length)];
          lat = q.lat + 0.00008 * (rnd() < 0.5 ? -1 : 1); lng = q.lng + 0.00009 * (rnd() < 0.5 ? -1 : 1);
        } else if (k === 0 && i >= count - 4) { // exact duplicates of coordinates
          const q = placed[i - (count - 4)]; lat = q.lat; lng = q.lng;
        } else { lat = jit(t.lat, 0.012); lng = jit(t.lng, 0.016); }
        const p = mkP(ti, lat, lng, i);
        placed.push(p);
      }
    });
    while (pros.length < 200) {
      const ti = Math.floor(rnd() * TOWNS.length);
      mkP(ti, jit(TOWNS[ti].lat, 0.12), jit(TOWNS[ti].lng, 0.14), pros.length);
    }
    pros.forEach(p => { proj.prospects[p.id] = p; });

    // Area shapes (small GeoJSON polygons). The phone projection has no field for them (they stay on the PC),
    // so they are NOT in proj; exposed separately for later map experiments.
    const areas = pros.filter((p, i) => i % 20 === 5).slice(0, 10).map(p => {
      const r = 0.002 + rnd() * 0.002, c = [p.lng, p.lat];
      const ring = [[c[0] - r, c[1] - r * 0.7], [c[0] + r, c[1] - r * 0.7], [c[0] + r * 1.1, c[1] + r * 0.6], [c[0] - r * 0.4, c[1] + r]];
      ring.push(ring[0]);
      return { prospectId: p.id, geometry: { type: 'Polygon', coordinates: [ring] } };
    });

    proj.settings = {
      home: { address: '12 chemin des Genêts, 15120 Saint-Aubin-des-Landes', label: '12 chemin des Genêts, 15120 Saint-Aubin-des-Landes', lat: 44.6105, lng: 2.5320 },
      tiers: { A: { due: 21, over: 35 }, B: { due: 45, over: 75 }, C: { due: 90, over: 150 } },
      dueDays: 30, overdueDays: 60, visitMin: 30, dayStart: '08:30', dayEnd: '18:00',
    };
    return { proj, areas };
  }

  root.DemoFixtures = {
    TOWNS,
    // Fresh project object each call. `base` is an optional Date standing in for "today".
    build: base => build(base).proj,
    areas: base => build(base).areas,
    empty: () => ({ clients: {}, groups: {}, prospects: {}, settings: {} }),
  };
})(typeof window !== 'undefined' ? window : globalThis);

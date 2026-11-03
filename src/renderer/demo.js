/* Client Clusters — renderer: demo data */
'use strict';

// =====================================================================
// Demo data (fictional clients around Lyon)
// =====================================================================
function loadDemo() {
  const towns = [
    ['Lyon', '69003', 45.760, 4.850, 9], ['Villeurbanne', '69100', 45.771, 4.890, 5], ['Vénissieux', '69200', 45.697, 4.886, 3],
    ['Bron', '69500', 45.738, 4.913, 3], ['Caluire-et-Cuire', '69300', 45.796, 4.846, 3], ['Écully', '69130', 45.775, 4.776, 2],
    ['Meyzieu', '69330', 45.767, 5.003, 2], ['Saint-Priest', '69800', 45.696, 4.944, 3], ['Vienne', '38200', 45.525, 4.874, 4],
    ['Villefranche-sur-Saône', '69400', 45.989, 4.719, 4], ['Bourgoin-Jallieu', '38300', 45.586, 5.274, 3], ['Givors', '69700', 45.590, 4.769, 2],
  ];
  const kinds = ['Boulangerie', 'Pharmacie', 'Garage', 'Fleuriste', 'Quincaillerie', 'Épicerie', 'Opticien', 'Librairie', 'Cave', 'Salon', 'Atelier', 'Bistrot'];
  const names = ['du Centre', 'des Lilas', 'Martin', 'Bernard', 'de la Gare', 'Petit', 'du Marché', 'Moreau', 'Laurent', 'des Arts', 'Fournier', 'du Parc', 'Girard', 'Bonnet', 'du Pont'];
  const streets = ['rue de la République', 'avenue Jean Jaurès', 'rue Victor Hugo', 'place du Marché', 'rue Pasteur', 'boulevard des Belges', 'rue des Écoles', 'chemin des Vignes'];
  let seed = 3;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const clients = [];
  let k = 0;
  for (const [city, pc, lat, lng, n] of towns) {
    for (let i = 0; i < n; i++, k++) {
      const c = {
        id: uid(), name: `${kinds[k % kinds.length]} ${names[(k * 7) % names.length]}`,
        address: `${1 + Math.floor(rnd() * 120)} ${streets[Math.floor(rnd() * streets.length)]}`, postcode: pc, city, country: '',
        lat: lat + (rnd() - 0.5) * 0.035, lng: lng + (rnd() - 0.5) * 0.05, geo: { status: 'ok', label: 'Demo', score: 1, source: 'file' },
        notes: '', extra: {}, visits: [], groupId: null, createdAt: todayISO(),
      };
      const pattern = [['9-12, 14-19', '9-12, 14-19', '9-12, 14-19', '9-12, 14-19', '9-12, 14-19', '9-12', ''],
        ['7-13, 15-19:30', '7-13, 15-19:30', '', '7-13, 15-19:30', '7-13, 15-19:30', '7-13, 15-19:30', '7-12:30'],
        ['8:30-18', '8:30-18', '8:30-18', '8:30-18', '8:30-18', '', ''], null][k % 4];
      if (pattern) c.gbp = { status: 'manual', hours: { ...Hours.parseWeek(pattern), source: 'manual', updatedAt: todayISO() } };
      const r = rnd();
      if (r > 0.12) {
        const back = Math.floor(rnd() * 110);
        const d = new Date(); d.setDate(d.getDate() - back);
        recordVisit(c, { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` });
      }
      clients.push(c);
    }
  }
  clients.forEach((c, i) => { c.tier = i % 7 === 0 ? 'A' : i % 5 === 0 ? 'C' : ''; });
  state.data.clients = clients; state.data.groups = []; state.data.demo = true;
  // A few planned visits so the Planned tab has something to show.
  const day = nextWorkday(todayISO());
  clients.filter(c => c.city === 'Villeurbanne' || c.city === 'Caluire-et-Cuire').slice(0, 5).forEach(c => recordVisit(c, { date: day, status: 'planned', order: 1 }));
  optimizeDay(day);
  const prev = clients.find(c => c.city === 'Vienne');
  if (prev) recordVisit(prev, { date: addDaysISO(todayISO(), -2), status: 'planned' });
  regroup({ confirm: false });
}

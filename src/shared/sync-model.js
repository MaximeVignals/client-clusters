// Sync model: which data the phone sees and which fields it may change.
// Shared by Windows and Android (UMD: require() in Node, global SyncModel in a page).
(function (root) {
  const CLIENT_FIELDS = ['name', 'address', 'postcode', 'city', 'country', 'lat', 'lng', 'groupId', 'tier', 'notes', 'extra', 'gbp'];
  const GBP_FIELDS = ['hours', 'phone', 'website', 'url'];
  const PROSPECT_FIELDS = ['name', 'address', 'postcode', 'city', 'country', 'lat', 'lng', 'status', 'notes', 'group', 'extra'];
  const GROUP_FIELDS = ['number', 'name', 'color'];
  const SETTINGS_FIELDS = ['home', 'tiers', 'dueDays', 'overdueDays', 'visitMin', 'dayStart', 'dayEnd'];
  const FIELDS = { client: CLIENT_FIELDS, prospect: PROSPECT_FIELDS, group: GROUP_FIELDS, settings: SETTINGS_FIELDS };
  // Value lists the receiver enforces (kept equal to Visits / the prospect statuses by a test).
  const VISIT_STATUS = ['done', 'planned', 'cancelled'];
  const VISIT_TYPES = ['visit', 'call'];
  const VISIT_OUTCOMES = ['', 'ok', 'order', 'followup', 'absent', 'closed'];
  const PROSPECT_STATUS = ['todo', 'visited', 'converted', 'no'];
  const COLLECTION = { client: 'clients', prospect: 'prospects', group: 'groups' };

  const clone = x => (x === undefined ? null : JSON.parse(JSON.stringify(x)));

  function projectGbp(g) {
    if (!g || typeof g !== 'object') return null;
    const out = {};
    for (const f of GBP_FIELDS) out[f] = clone(g[f]);
    return out;
  }

  function projectEntity(e, src) {
    const out = { id: src.id };
    for (const f of FIELDS[e]) out[f] = f === 'gbp' ? projectGbp(src.gbp) : clone(src[f]);
    return out;
  }

  // Windows data (state.data shape) -> projection.
  function project(data) {
    const proj = { clients: {}, groups: {}, prospects: {}, settings: {} };
    for (const c of (data && data.clients) || []) {
      const p = projectEntity('client', c);
      p.visits = {};
      for (const v of c.visits || []) if (v && v.id) p.visits[v.id] = clone(v);
      proj.clients[c.id] = p;
    }
    for (const g of (data && data.groups) || []) proj.groups[g.id] = projectEntity('group', g);
    for (const p of (data && data.prospecting && data.prospecting.prospects) || []) proj.prospects[p.id] = projectEntity('prospect', p);
    const s = (data && data.settings) || {};
    for (const f of SETTINGS_FIELDS) if (s[f] !== undefined) proj.settings[f] = clone(s[f]);
    return proj;
  }

  // Phone write permissions: visits (upsert/delete), client.notes, prospect.status, prospect.notes.
  function phoneMayWrite(op) {
    if (!op) return false;
    if (op.k === 'visit') return true;
    if (op.k === 'del') return op.e === 'visit';
    if (op.k === 'set') return (op.e === 'client' && op.f === 'notes') || (op.e === 'prospect' && (op.f === 'status' || op.f === 'notes'));
    return false;
  }

  const api = { VISIT_STATUS, VISIT_TYPES, VISIT_OUTCOMES, PROSPECT_STATUS, CLIENT_FIELDS, GBP_FIELDS, PROSPECT_FIELDS, GROUP_FIELDS, SETTINGS_FIELDS, FIELDS, COLLECTION, project, projectGbp, phoneMayWrite };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SyncModel = api;
})(typeof window !== 'undefined' ? window : globalThis);

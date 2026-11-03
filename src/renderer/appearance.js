/* Presentation preferences stay local and outside client data and backups. */
(() => {
  const key = 'client-clusters.appearance';
  let preference = 'system';
  try { preference = localStorage.getItem(key) || preference; } catch { /* Storage can be unavailable. */ }
  if (!['system', 'light', 'dark'].includes(preference)) preference = 'system';
  const system = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    document.documentElement.dataset.theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
  };
  window.appAppearance = {
    get value() { return preference; },
    set(value) {
      if (!['system', 'light', 'dark'].includes(value)) return;
      preference = value;
      try { localStorage.setItem(key, value); } catch { /* In-memory preference still works. */ }
      apply();
    },
  };
  system.addEventListener('change', apply);
  apply();
})();

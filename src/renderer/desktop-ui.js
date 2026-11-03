/* Desktop presentation and input behavior. Client, visit and file logic stays in app.js. */
(() => {
  const paths = {
    groups: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    clients: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 4v2"/>',
    planned: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18M8 16l3 3 5-5"/>',
    prospecting: '<circle cx="11" cy="11" r="7"/><path d="M16 16l5 5M8 11h6M11 8v6"/>',
  };
  const compact = matchMedia('(max-width: 899px)');
  let lastHasClients = null;
  function setView(view, focus = false) {
    document.body.dataset.compactView = view;
    $('#view-list').setAttribute('aria-pressed', String(view === 'list'));
    $('#view-map').setAttribute('aria-pressed', String(view === 'map'));
    if (focus && compact.matches) (view === 'list' ? $('#list') : $('#map')).focus();
  }
  function decorateTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
      const key = tab.dataset.tab;
      tab.id = `tab-${key}`;
      tab.setAttribute('aria-selected', String(key === state.tab));
      tab.setAttribute('aria-controls', 'list');
      tab.tabIndex = key === state.tab ? 0 : -1;
      tab.title = `${TAB_LABELS[key]} (Ctrl+${Object.keys(paths).indexOf(key) + 1})`;
      if (!tab.querySelector('svg')) tab.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[key]}</svg>`);
    });
    $('.tabs').setAttribute('aria-orientation', compact.matches ? 'horizontal' : 'vertical');
  }
  function refresh() {
    if (!state.derived) return;
    decorateTabs();
    $('#workspace-title').textContent = TAB_LABELS[state.tab];
    const descriptions = { groups: 'Nearby client groups', clients: 'All clients', planned: 'Your upcoming rounds', prospecting: 'Discover your next clients' };
    $('#list-summary').textContent = descriptions[state.tab];
    $('#list').setAttribute('aria-label', TAB_LABELS[state.tab]);
    $('#list').setAttribute('aria-labelledby', `tab-${state.tab}`);
    $('#workspace-status').textContent = `${state.data.demo ? 'Demo workspace · ' : ''}${state.data.clients.length} clients · ${state.data.groups.length} groups · Stored on this device`;
    const hasClients = state.data.clients.length > 0;
    if (lastHasClients !== hasClients && compact.matches) setView(hasClients || state.tab === 'prospecting' ? 'list' : 'map');
    lastHasClients = hasClients;
  }
  window.DesktopUI = { refresh, decorateTabs, revealDetail() { if (compact.matches) setView('map'); },
    focusReturn(element) { return element?.closest('.menu') ? menuOpener : element; },
  };

  $('#appearance').value = window.appAppearance.value;
  $('#appearance').addEventListener('change', e => window.appAppearance.set(e.target.value));
  $('#nav-settings').addEventListener('click', settingsDialog);
  $('#btn-plan-day').addEventListener('click', () => planDayDialog());
  $('#btn-fit-map').addEventListener('click', () => {
    if (state.tab === 'prospecting') fitProspects();
    else if (state.tab === 'planned' && state.selectedDay) fitDay(state.selectedDay);
    else fitAll();
  });
  $('#view-list').addEventListener('click', () => setView('list', true));
  $('#view-map').addEventListener('click', () => setView('map', true));
  $('.tabs').addEventListener('click', e => { if (compact.matches && e.target.closest('.tab')) setView('list'); });
  compact.addEventListener('change', () => { decorateTabs(); if (compact.matches && !$('#detail').hidden) setView('map'); });

  // Resize only the presentation pane; Leaflet also needs to know about inspector and DPI changes.
  let mapFrame;
  const mapObserver = new ResizeObserver(() => {
    cancelAnimationFrame(mapFrame);
    mapFrame = requestAnimationFrame(() => {
      if ($('#map').clientWidth && $('#map').clientHeight) map.invalidateSize({ pan: false, debounceMoveend: true });
    });
  });
  mapObserver.observe($('#map'));
  const splitter = $('#sidebar-splitter');
  function resizeSidebar(width) {
    const max = Math.max(320, Math.min(560, innerWidth - $('.navrail').offsetWidth - 320));
    width = Math.round(Math.max(320, Math.min(max, width)));
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
    splitter.setAttribute('aria-valuenow', String(width));
    splitter.setAttribute('aria-valuemax', String(max));
    return width;
  }
  try {
    const width = Number(localStorage.getItem('client-clusters.sidebar-width'));
    if (width >= 320 && width <= 560) resizeSidebar(width);
  } catch { /* Default adaptive width remains available. */ }
  const rememberWidth = () => {
    try { localStorage.setItem('client-clusters.sidebar-width', String($('.sidebar').offsetWidth)); } catch { /* Optional preference. */ }
  };
  splitter.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); splitter.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
  });
  splitter.addEventListener('pointermove', e => {
    if (splitter.hasPointerCapture(e.pointerId)) resizeSidebar(e.clientX - $('.sidebar').getBoundingClientRect().left);
  });
  const finishResize = () => { document.body.classList.remove('resizing'); rememberWidth(); };
  splitter.addEventListener('pointerup', e => { splitter.releasePointerCapture(e.pointerId); finishResize(); });
  splitter.addEventListener('lostpointercapture', finishResize);
  splitter.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    resizeSidebar(e.key === 'Home' ? 320 : e.key === 'End' ? 560 : $('.sidebar').offsetWidth + (e.key === 'ArrowLeft' ? -20 : 20));
    rememberWidth();
  });
  window.addEventListener('resize', () => {
    if (!compact.matches && document.documentElement.style.getPropertyValue('--sidebar-width')) resizeSidebar($('.sidebar').offsetWidth);
  });

  function shortcutsDialog() {
    showModal({ title: 'Keyboard shortcuts', desc: 'Move through your workspace without leaving the keyboard.',
      render: () => '<div class="shortcut-list">' + [
        ['Search the workspace', 'Ctrl + F'], ['Import a client list', 'Ctrl + O'], ['Add a client', 'Ctrl + N'],
        ['Plan a day', 'Ctrl + Shift + P'], ['Switch workspace', 'Ctrl + 1–4'], ['Move between workspace tabs', 'Arrow keys'],
        ['Close dialog or details', 'Esc'], ['Select clients on the map', 'Ctrl + click / Shift + drag'],
      ].map(([label, key]) => `<span>${label}</span><kbd>${key}</kbd>`).join('') + '</div>',
      buttons: [{ label: 'Close', primary: true, action: 'close' }],
    });
  }
  $('#btn-shortcuts').addEventListener('click', shortcutsDialog);
  $('#status-shortcuts').addEventListener('click', shortcutsDialog);
  $('.tabs').addEventListener('keydown', e => {
    const tabs = [...document.querySelectorAll('.tab')];
    const index = tabs.indexOf(document.activeElement);
    if (index < 0 || !['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (['ArrowDown', 'ArrowRight'].includes(e.key) ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click(); tabs[next].focus();
  });

  // Menus share keyboard behavior, including context menus for client and group workflows.
  const context = document.createElement('div');
  context.className = 'menu context-menu'; context.hidden = true; context.setAttribute('role', 'menu');
  document.body.append(context);
  let menuOpener = null;
  const menus = [$('#menu'), $('#export-menu'), context];
  function closeMenus(restoreFocus = false) {
    menus.forEach(menu => { menu.hidden = true; });
    if (restoreFocus && menuOpener?.isConnected) menuOpener.focus();
  }
  const menuObserver = new MutationObserver(() => {
    $('#btn-menu').setAttribute('aria-expanded', String(!$('#menu').hidden));
    $('#btn-export').setAttribute('aria-expanded', String(!$('#export-menu').hidden));
  });
  menus.forEach(menu => {
    menu.setAttribute('role', 'menu');
    menuObserver.observe(menu, { attributes: true, attributeFilter: ['hidden'] });
    menu.addEventListener('keydown', e => {
      const items = [...menu.querySelectorAll('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
      if (e.key === 'Tab') closeMenus();
    });
  });
  [$('#btn-menu'), $('#btn-export')].forEach(button => {
    button.addEventListener('click', e => {
      menuOpener = button;
      if (e.detail === 0) menus.find(menu => !menu.hidden)?.querySelector('button')?.focus();
    });
    button.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); button.click(); }
    });
  });
  $('#list').addEventListener('contextmenu', e => {
    if (state.tab === 'prospecting') return;
    const row = e.target.closest('[data-client], [data-group]');
    if (!row) return;
    const client = row.dataset.client && clientById(row.dataset.client);
    const group = row.dataset.group && groupById(row.dataset.group);
    if (!client && !group) return;
    e.preventDefault(); closeMenus(); menuOpener = row;
    const ids = client ? [client.id] : state.derived.byGroup.get(group.id).members.map(c => c.id);
    const actions = client ? [
      ['Open client details', () => selectClient(client.id, { pan: true })],
      ['Plan a visit…', () => visitDialog({ ids, mode: 'plan', title: client.name })],
      ['Log a visit…', () => visitDialog({ ids, mode: 'log', title: client.name })],
      [doneToday(client) ? 'Undo today’s visit' : 'Mark visited today', () => toggleVisitedToday(client.id)],
    ] : [
      ['Show group on map', () => { selectGroup(group.id, { fit: true }); if (compact.matches) setView('map'); }],
      ['Plan visits…', () => visitDialog({ ids, mode: 'plan', title: group.name })],
      ['Log a visit…', () => visitDialog({ ids, mode: 'log', title: group.name })],
      ['Route in Google Maps', () => openRoute(group.id)], ['Rename group…', () => renameGroup(group.id)],
    ];
    context.replaceChildren(...actions.map(([label, action]) => {
      const button = document.createElement('button'); button.textContent = label; button.setAttribute('role', 'menuitem');
      button.onclick = () => { closeMenus(); action(); }; return button;
    }));
    context.hidden = false;
    context.style.left = `${Math.max(8, Math.min(e.clientX, innerWidth - context.offsetWidth - 8))}px`;
    context.style.top = `${Math.max(8, Math.min(e.clientY, innerHeight - context.offsetHeight - 8))}px`;
    context.querySelector('button').focus();
  });
  document.addEventListener('click', () => { context.hidden = true; });
  window.addEventListener('resize', () => closeMenus());

  // Dynamic forms receive associated labels; non-button list rows retain keyboard access.
  let labelIndex = 0;
  function enhance(root) {
    root.querySelectorAll('.field').forEach(field => {
      const label = field.querySelector('label');
      const input = field.querySelector('input, select, textarea');
      if (!label || !input || label.contains(input) || label.htmlFor) return;
      if (!input.id) input.id = `ui-field-${++labelIndex}`;
      label.htmlFor = input.id;
    });
    root.querySelectorAll('button[title]').forEach(button => {
      if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', button.title);
    });
    const names = { 'v-date': 'Visit date', 'v-type': 'Visit type', 'v-outcome': 'Visit outcome', 'v-note': 'Visit note',
      's-max': 'Maximum clients per group', 's-flex': 'Maximum clients in the same town', 's-span': 'Maximum group distance in kilometres',
      's-due': 'Days until due', 's-over': 'Days until overdue' };
    root.querySelectorAll('input, select, textarea').forEach(input => {
      if (input.labels?.length || input.hasAttribute('aria-label') || input.hasAttribute('aria-labelledby')) return;
      const name = names[input.id] || input.title || input.placeholder || input.dataset.f || input.closest('.section')?.querySelector('h3')?.textContent;
      if (name) input.setAttribute('aria-label', name);
    });
    root.querySelectorAll('button[data-group]').forEach(row => row.setAttribute('aria-expanded', String(row.closest('.group').classList.contains('selected'))));
    root.querySelectorAll('.client-row').forEach(row => row.setAttribute('aria-current', String(row.classList.contains('selected'))));
    root.querySelectorAll('[data-tier]').forEach(button => button.setAttribute('aria-pressed', String(button.classList.contains('on'))));
    root.querySelectorAll('.member[data-client], .member[data-prospect], .stop[data-client]').forEach(row => {
      row.tabIndex = 0;
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', row.querySelector('.name')?.textContent.trim() || 'Client');
    });
    root.querySelectorAll('.menu button').forEach(button => button.setAttribute('role', 'menuitem'));
  }
  const dynamicObserver = new MutationObserver(records => {
    const roots = new Set(records.map(record => record.target.closest('#list, #detail, #modal-box, #menu')));
    roots.forEach(root => { if (root) enhance(root); });
  });
  ['#list', '#detail', '#modal-box', '#menu'].forEach(selector => dynamicObserver.observe($(selector), { childList: true, subtree: true }));
  $('#list').addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.member, .stop')) { e.preventDefault(); e.target.click(); }
  });

  // Keep keyboard focus inside active dialogs and make the background inaccessible while open.
  const focusable = root => [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
    .filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[hidden]'));
  const modalObserver = new MutationObserver(() => {
    const open = !$('#modal').hidden;
    ['.topbar', '.layout', '.statusbar', '.compact-switch'].forEach(selector => { $(selector).inert = open; });
  });
  modalObserver.observe($('#modal'), { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menus.some(menu => !menu.hidden)) {
      e.preventDefault(); e.stopImmediatePropagation(); closeMenus(true); return;
    }
    if (modalCtx) {
      if (e.key === 'Tab') {
        const items = focusable($('#modal-box'));
        const first = items[0], last = items.at(-1);
        if (!first) { e.preventDefault(); $('#modal-box').focus(); }
        else if (e.shiftKey && (document.activeElement === first || !$('#modal-box').contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !$('#modal-box').contains(document.activeElement))) { e.preventDefault(); first.focus(); }
      }
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'f') { e.preventDefault(); if (compact.matches) setView('list'); $('#search').focus(); $('#search').select(); }
    else if (key === 'o') { e.preventDefault(); openImport(); }
    else if (key === 'n') { e.preventDefault(); addClientDialog(); }
    else if (key === 'p' && e.shiftKey) { e.preventDefault(); planDayDialog(); }
    else if (['1', '2', '3', '4'].includes(key)) { e.preventDefault(); const tab = document.querySelectorAll('.tab')[Number(key) - 1]; if (compact.matches) setView('list'); tab.click(); tab.focus(); }
  }, true);
  enhance(document); refresh();
})();

/* Client Clusters — renderer: modals, toasts and progress bar */
'use strict';

// =====================================================================
// Modals, toasts, progress
// =====================================================================
const box$ = sel => $('#modal-box').querySelector(sel);
let modalCtx = null;
// Makes the dialog in #modal-box the active one and wires its buttons and inputs.
// Also used to bring a dialog back after a confirmation covered it.
function bindModal(opts, previousFocus) {
  const back = $('#modal'), box = $('#modal-box');
  // A dialog that was closed or replaced must not touch the one now on screen
  // (for example when a search it started answers late).
  const current = () => modalCtx !== null && modalCtx.opts === opts;
  const close = () => {
    if (!current()) return;
    back.hidden = true; box.innerHTML = ''; modalCtx = null; opts.onClose && opts.onClose();
    requestAnimationFrame(() => { if (back.hidden && previousFocus?.isConnected) previousFocus.focus(); });
  };
  const rerender = () => { if (current()) box.querySelector('.modal-body').innerHTML = opts.render(box); };
  modalCtx = { close, opts, previousFocus };
  box.onclick = e => {
    const b = e.target.closest('[data-mb]');
    if (!b) { if (opts.onClick) opts.onClick(e, box, close, rerender); return; }
    const btn = opts.buttons[+b.dataset.mb];
    if (btn.action === 'close') close();
    else if (btn.action === 'ok') opts.onOk(close, box);
    else if (btn.fn) btn.fn(close, box);
  };
  box.onchange = e => opts.onChange && opts.onChange(e, rerender, box);
  box.oninput = e => opts.onInput && opts.onInput(e, box);
  box.onkeydown = e => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'radio' && opts.onOk) { e.preventDefault(); opts.onOk(close, box); }
  };
}

function showModal(opts) {
  const back = $('#modal'), box = $('#modal-box');
  const previousFocus = window.DesktopUI?.focusReturn(document.activeElement) || document.activeElement;
  box.className = 'modal' + (opts.wide ? ' wide' : '');
  box.innerHTML = `
    <div class="modal-head"><h2 id="modal-title">${opts.title}</h2>${opts.desc ? `<p>${opts.desc}</p>` : ''}</div>
    <div class="modal-body">${opts.render(box)}</div>
    <div class="modal-foot">${opts.buttons.map((b, i) => `<button class="btn${b.primary ? ' primary' : ''}${b.danger ? ' danger solid' : ''}" data-mb="${i}">${b.label}</button>`).join('')}</div>`;
  back.hidden = false;
  bindModal(opts, previousFocus);
  const f = box.querySelector('[autofocus], .modal-body input:not([type=checkbox]):not([type=radio])');
  setTimeout(() => {
    if (modalCtx?.opts !== opts || back.hidden) return;
    if (f?.isConnected) f.focus();
    else (box.querySelector('.btn.primary, .modal-foot .btn') || box).focus();
  }, 30);
}

function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  return new Promise(resolve => {
    const box = $('#modal-box');
    const prev = modalCtx; // confirm can open on top of another dialog
    // Keep that dialog's own elements (not a copy of its HTML), so what was typed or ticked in it comes back too.
    const prevNodes = prev ? [...box.childNodes] : null;
    const prevClass = box.className;
    let answered = false;
    const restore = () => {
      if (!prev) return;
      box.replaceChildren(...prevNodes); box.className = prevClass; $('#modal').hidden = false;
      bindModal(prev.opts, prev.previousFocus);
      requestAnimationFrame(() => box.querySelector('input, select, button')?.focus());
    };
    showModal({
      title, render: () => `<p style="margin:0">${message}</p>`,
      buttons: [{ label: 'Cancel', action: 'close' }, { label: okLabel, primary: !danger, danger, fn: close => { answered = true; close(); } }],
      onClose: () => { restore(); resolve(answered); },
    });
  });
}
function toast(msg, { error, action } = {}) {
  const t = document.createElement('div');
  t.className = 'toast' + (error ? ' err' : '');
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn small'; b.style.marginLeft = '10px'; b.style.background = 'transparent'; b.style.color = '#fff'; b.style.borderColor = 'rgba(255,255,255,.4)';
    b.textContent = action.label;
    b.onclick = () => { action.fn(); t.remove(); };
    t.appendChild(b);
  }
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), action ? 7000 : error ? 6500 : 3800);
}

function showProgress(text, frac) {
  $('#progress').hidden = false;
  $('#progress-text').textContent = text;
  $('.progress-bar').style.display = frac === null ? 'none' : '';
  $('#progress-stop').style.display = state.geocoding || state.gjob ? '' : 'none';
  if (frac !== null) $('#progress-fill').style.width = Math.round(frac * 100) + '%';
}
function hideProgress() { $('#progress').hidden = true; }

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// For any user-entered text going into innerHTML (merchants, names).
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

export function errorMessage(err) {
  return err?.message || String(err);
}

let toastTimer;
// Errors by default; { ok: true } for good news.
export function showToast(message, { ok = false } = {}) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.toggle('ok', ok);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
}

export function showFormError(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

// A soft fade at the bottom of a sheet while there's more to scroll to.
function updateFade(sheet) {
  sheet.classList.toggle('more-below', sheet.scrollHeight - sheet.scrollTop - sheet.clientHeight > 4);
}

function addFade(sheet) {
  if (sheet.querySelector(':scope > .sheet-fade')) return;
  const fade = document.createElement('div');
  fade.className = 'sheet-fade';
  sheet.append(fade);
  const update = () => requestAnimationFrame(() => updateFade(sheet));
  sheet.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(sheet);
  new MutationObserver(update).observe(sheet, { childList: true, subtree: true }); // rows added/removed
}

// Bottom sheets: open/close, backdrop tap, ✕ button, Escape key.
export function openSheet(backdrop) {
  const sheet = backdrop.querySelector('.sheet');
  if (sheet) {
    addFade(sheet);
    sheet.append(sheet.querySelector(':scope > .sheet-fade')); // keep it last
    requestAnimationFrame(() => updateFade(sheet));
  }
  backdrop.classList.add('open');
}

export function closeSheet(backdrop) {
  backdrop.classList.remove('open');
}

export function wireSheet(backdrop) {
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop || e.target.closest('[data-close]')) closeSheet(backdrop);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSheet(backdrop);
  });
}

// Single-select chip group: keeps exactly one chip `.selected`.
export function selectChip(group, chip) {
  group.querySelectorAll('.chip').forEach(c => c.classList.toggle('selected', c === chip));
}

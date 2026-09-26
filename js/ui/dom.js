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

// Bottom sheets: open/close, backdrop tap, ✕ button, Escape key.
export function openSheet(backdrop) {
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

// Settings → Store suggestions: every store being suggested (Hide) and every
// hidden one (Unhide). Hiding only affects the expense sheet's suggestions.
import { MONTHS_SHORT } from '../budget.js';
import { esc, openSheet, closeSheet, wireSheet } from './dom.js';

const settingsBackdrop = document.getElementById('settingsBackdrop');
const backdrop = document.getElementById('storesBackdrop');
const listEl = document.getElementById('storesList');
const openBtn = document.getElementById('openStores');

let ctx;

function lastUsedText(date) {
  if (!date) return '';
  const year = date.getFullYear() === new Date().getFullYear() ? '' : `, ${date.getFullYear()}`;
  return `last ${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}${year}`;
}

function metaText(store) {
  if (!store.count) return 'Not used any more';
  return [store.count === 1 ? 'Used once' : `Used ${store.count} times`, lastUsedText(store.lastUsed)]
    .filter(Boolean).join(' · ');
}

function groupHtml(title, stores, action, label, emptyText) {
  const rows = stores.map(s => `<div class="store-choice">
      <div class="store-name"><div>${esc(s.name)}</div><div class="store-meta">${esc(metaText(s))}</div></div>
      <button type="button" class="row-btn" data-${action}="${esc(s.key)}">${label}</button>
    </div>`).join('');
  return `<div class="section-label">${title} · ${stores.length}</div>
    <div class="list-card">${rows || `<div class="empty">${emptyText}</div>`}</div>`;
}

function render() {
  const { suggested, hidden } = ctx.getStores();
  listEl.innerHTML =
    groupHtml('Hidden', hidden, 'unhide', 'Unhide', 'No hidden stores.')
    + groupHtml('Suggested', suggested, 'hide', 'Hide', 'No stores to suggest yet.');
}

// ctx: { getStores() → { suggested: [store], hidden: [store] },
//        onHide(key), onUnhide(key) }   store: { key, name, count, lastUsed }
export function initStoresSheet(context) {
  ctx = context;
  wireSheet(backdrop);

  openBtn.addEventListener('click', () => {
    closeSheet(settingsBackdrop);
    render();
    openSheet(backdrop);
  });

  listEl.addEventListener('click', async e => {
    const btn = e.target.closest('[data-hide], [data-unhide]');
    if (!btn) return;
    btn.disabled = true;
    if (btn.dataset.hide) await ctx.onHide(btn.dataset.hide);
    else await ctx.onUnhide(btn.dataset.unhide);
    render();
  });
}

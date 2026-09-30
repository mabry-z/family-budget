// Overview → "N new from Chase": purchases read from card alert emails
// (migration 008, gmail-script/) that nobody has reviewed yet. They don't
// count toward anything until someone taps one and adds it.
import { CARDS } from '../config.js';
import { money, MONTHS_SHORT } from '../budget.js';
import { esc } from './dom.js';

const cardEl = document.getElementById('importsCard');
let byId = new Map();

export const cardInfo = value => CARDS.find(c => c.value === value) ?? CARDS.find(c => c.value === 'Other');

export function badgeHtml(value) {
  const card = cardInfo(value);
  return `<span class="review-badge" style="background:${esc(card.color)};">${esc(card.badge)}</span>`;
}

// "10:50 AM" today, otherwise "Sep 29".
export function whenLabel(iso, { withDay = false } = {}) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const isToday = d.toDateString() === now.toDateString();
  const day = `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
  if (!withDay) return isToday ? time : day;
  return isToday ? `today ${time}` : `${day}, ${time}`;
}

// Whole dollars, as the rest of the app shows money.
export const importDollars = imp => Math.max(1, Math.round(imp.amount_cents / 100));

function rowHtml(imp, authorColors) {
  if (imp.unreadable) {
    return `<button type="button" class="review-row unreadable" data-import="${imp.id}">`
      + `<span class="merchant">Couldn’t read this alert</span>`
      + `<span class="meta">${esc(whenLabel(imp.occurred_at))}</span>`
      + `<span class="amt">—</span><span class="go">›</span></button>`;
  }
  const color = imp.cardholder_user_id ? authorColors.get(imp.cardholder_user_id) : null;
  const dot = color ? `<span class="author-dot" style="background:${esc(color)};"></span>` : '';
  return `<button type="button" class="review-row" data-import="${imp.id}">`
    + `<span class="merchant">${dot}${esc(imp.merchant)}</span>`
    + `<span class="meta">${esc(whenLabel(imp.occurred_at))}</span>`
    + `<span class="amt">${money(importDollars(imp))}</span><span class="go">›</span></button>`;
}

export function initImports({ onReview }) {
  cardEl.addEventListener('click', e => {
    const row = e.target.closest('[data-import]');
    if (row) onReview(byId.get(row.dataset.import));
  });
}

// authorColors: Map<user_id, colour>, the same dots as Recent activity.
export function renderImports(imports, authorColors = new Map()) {
  byId = new Map(imports.map(i => [String(i.id), i]));
  cardEl.hidden = !imports.length;
  if (!imports.length) {
    cardEl.innerHTML = '';
    return;
  }
  const cards = new Set(imports.map(i => i.card));
  const from = cards.size === 1 ? `from ${cardInfo([...cards][0]).label}` : 'card purchases';
  const n = imports.length;
  cardEl.innerHTML = `
    <div class="review-head">
      ${cards.size === 1 ? badgeHtml([...cards][0]) : badgeHtml('Other')}
      <div class="review-title">${n} new ${esc(from)}</div>
      <span class="review-hint">Review</span>
    </div>
    ${imports.map(i => rowHtml(i, authorColors)).join('')}
    <div class="review-foot">Tap ${n === 1 ? 'it' : 'one'} to pick a category. ${n === 1 ? 'It doesn’t' : 'They don’t'} count until you do.</div>`;
}

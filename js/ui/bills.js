import { money, sum } from '../budget.js';
import { esc } from './dom.js';
import { cardInfo, whenLabel } from './imports.js';

// "Paid by Chase alert · today 5:01 PM" under a bill a card alert paid.
function paidNote(f) {
  if (!f.is_paid || !f.paid_import) return '';
  const label = cardInfo(f.paid_import.card).label;
  return `<div class="bill-note">Paid by ${esc(label)} alert · ${esc(whenLabel(f.paid_import.occurred_at, { withDay: true }))}</div>`;
}

const billsEl = document.getElementById('billsCard');

export function initBills({ onTogglePaid }) {
  billsEl.addEventListener('click', e => {
    const check = e.target.closest('.check');
    if (check) onTogglePaid(Number(check.dataset.id), !check.classList.contains('checked'));
  });
}

export function renderBills(fixedCosts) {
  if (!fixedCosts.length) {
    billsEl.innerHTML = '<div class="empty">No fixed costs this period. Add them in Settings.</div>';
    return;
  }

  const paid = fixedCosts.filter(f => f.is_paid);
  const total = sum(fixedCosts, f => f.amount);
  const paidTotal = sum(paid, f => f.amount);
  const pct = total > 0 ? Math.round((paidTotal / total) * 100) : 0;

  // Unpaid first, then paid; alphabetical within each.
  const ordered = [...fixedCosts].sort((a, b) =>
    (a.is_paid - b.is_paid) || a.name.localeCompare(b.name));

  billsEl.innerHTML = `
    <div class="progress-line"><b>${paid.length} of ${fixedCosts.length} paid</b> · ${money(paidTotal)} of ${money(total)}</div>
    <div class="bar-track" style="margin-bottom:14px;"><div class="bar-fill fill-ok" style="width:${pct}%"></div></div>
    ${ordered.map(f => `
      <div class="bill-row${f.is_paid ? ' paid' : ''}">
        <button type="button" class="check${f.is_paid ? ' checked' : ''}" data-id="${f.id}"
          aria-label="Mark ${esc(f.name)} as ${f.is_paid ? 'unpaid' : 'paid'}">${f.is_paid ? '✓' : ''}</button>
        <div class="bill-name"><div class="bill-title">${esc(f.name)}</div>${paidNote(f)}</div>
        <div class="bill-amt">${money(f.amount)}</div>
      </div>`).join('')}`;
}

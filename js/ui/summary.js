import { money, barFor } from '../budget.js';
import { today, shortDay } from '../paydays.js';
import { esc } from './dom.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function row(label, value, cls = '') {
  return `<div class="summary-row${cls ? ` ${cls}` : ''}"><span>${label}</span><span${value < 0 ? ' class="negative"' : ''}>${money(value)}</span></div>`;
}

// "6 days left" (today counts), "Last day", "Ended", or "Starts Fri, Oct 30".
function timeNote(start, end) {
  const now = today();
  if (now < start) return `Starts ${shortDay(start)}`;
  if (now > end) return 'Ended';
  const days = Math.round((end - now) / DAY_MS) + 1;
  return days === 1 ? 'Last day' : `${days} days left`;
}

// period: { fixedCosts, start, end } — the period's bills and real dates.
export function renderSummary(budget, cardTotals, period) {
  const { toSpend, spent, left, carryIn } = budget;
  const bar = barFor(spent, toSpend, false);

  document.getElementById('leftCard').innerHTML = `
    <div class="left-label">Left to spend</div>
    <div class="left-amount${left < 0 ? ' negative' : ''}">${money(left)}</div>
    <div class="bar-track"><div class="bar-fill ${bar.cls}" style="width:${bar.pct}%"></div></div>
    <div class="left-note">${money(spent)} spent of ${money(toSpend)} · ${timeNote(period.start, period.end)}</div>`;

  const bills = period.fixedCosts;
  const paid = bills.filter(f => f.is_paid).length;
  const billsNote = bills.length ? ` <span class="row-note">· ${paid} of ${bills.length} paid</span>` : '';

  document.getElementById('budgetSummary').innerHTML = `
    <h3>How we got there</h3>
    ${row('Paycheck', budget.starting)}
    ${carryIn ? row(`${carryIn < 0 ? '−' : '+'} Carried in from last period`, Math.abs(carryIn), carryIn < 0 ? 'short' : '') : ''}
    ${row(`− Bills${billsNote}`, budget.fixedTotal)}
    ${row('= To spend this period', toSpend, 'total')}
    ${row('− Spent so far', spent)}
    ${row('= Left', left, 'total')}`;

  // Cards with spending first, most to least; the $0 ones after, in their usual order.
  const cards = [...cardTotals].sort((a, b) => (b.total !== 0) - (a.total !== 0) || b.total - a.total);
  const cardTotal = cardTotals.reduce((n, c) => n + c.total, 0);
  document.getElementById('cardSummary').innerHTML = `
    <h3>Card spending</h3>
    ${cards.map(c => row(esc(c.card), c.total, c.total === 0 ? 'zero' : '')).join('')}
    ${row('Total', cardTotal, 'total')}`;
}

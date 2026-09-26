import { money } from '../budget.js';
import { esc } from './dom.js';

function row(label, value) {
  return `<div class="summary-row"><span>${esc(label)}</span><span${value < 0 ? ' class="negative"' : ''}>${money(value)}</span></div>`;
}

export function renderSummary(budget, cardTotals) {
  document.getElementById('budgetSummary').innerHTML = `
    <h3>Budget summary</h3>
    ${row('Starting', budget.starting)}
    ${budget.carryIn ? row('Carried in (Extra)', budget.carryIn) : ''}
    ${row('Fixed costs', budget.fixedTotal)}
    ${row('Category budgets', budget.categoryBudgets)}
    ${budget.moved ? row('Moved to Extra', budget.moved) : ''}
    ${row('Spent (categories)', budget.spent)}
    ${row('Remaining (categories)', budget.remaining)}`;

  document.getElementById('cardSummary').innerHTML = `
    <h3>Card spending</h3>
    ${cardTotals.map(c => row(c.card, c.total)).join('')}`;
}

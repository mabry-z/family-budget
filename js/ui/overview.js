import { money, sum, MONTHS_SHORT } from '../budget.js';
import { esc } from './dom.js';

const cardsEl = document.getElementById('categoryCards');
const recentEl = document.getElementById('recentList');

let expandedId = null;
let expensesById = new Map();
let sweepable = []; // categories with money left that haven't been emptied

function shortDate(iso) {
  const d = new Date(iso);
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

function amountHtml(e) {
  return e.transaction_type === 'refund'
    ? `<span class="amt-refund">+${money(e.amount)}</span>`
    : `<span>${money(e.amount)}</span>`;
}

function expenseRowHtml(e, meta) {
  return `<div class="expense-row clickable" data-expense="${e.id}">`
    + `<span class="merchant">${esc(e.merchant || 'Unknown')}</span>`
    + `<span class="meta">${esc(meta)}</span>`
    + amountHtml(e)
    + `</div>`;
}

function noteHtml(card) {
  if (card.isExtra) {
    if (!card.carryIn) return '';
    const sign = card.carryIn > 0 ? '+' : '−';
    return `<div class="cat-note${card.carryIn < 0 ? ' negative' : ''}">${sign} ${money(Math.abs(card.carryIn))} carried from last period</div>`;
  }
  if (card.emptied) {
    return `<div class="cat-note">Emptied · ${money(card.moved)} moved to Extra</div>`;
  }
  return '';
}

// Shown at the bottom of an expanded card. Extra's gathers every leftover at once.
function actionHtml(card) {
  if (card.isExtra) {
    if (!sweepable.length) return '';
    return `<button type="button" class="cat-action" data-action="sweep">Move all leftovers here (${money(sum(sweepable, c => c.leftover))})</button>`;
  }
  if (card.emptied) {
    return `<button type="button" class="cat-action" data-action="undo-empty" data-cat-id="${card.id}">Undo — give ${money(card.moved)} back to ${esc(card.name)}</button>`;
  }
  if (card.leftover > 0) {
    return `<button type="button" class="cat-action" data-action="empty" data-cat-id="${card.id}">Move ${money(card.leftover)} leftover to Extra</button>`;
  }
  return '';
}

function cardHtml(card) {
  const rows = card.expenses.length
    ? card.expenses.map(e => expenseRowHtml(e, `${shortDate(e.created_at)} · ${e.card}`)).join('')
    : '<div class="empty">No expenses yet.</div>';
  const overBudget = card.budget < 0 ? ' negative' : '';
  return `<div class="cat-card${card.id === expandedId ? ' expanded' : ''}" data-cat="${card.id}">
    <div class="cat-top">
      <div class="cat-name-row"><span class="chevron">›</span><span class="cat-dot" style="background:${esc(card.color)};"></span><div class="cat-name">${esc(card.name)}</div></div>
      <div class="cat-nums"><b>${money(card.spent)}</b> / <span class="${overBudget}">${money(card.budget)}</span></div>
    </div>
    <div class="bar-track"><div class="bar-fill ${card.bar.cls}" style="width:${card.bar.pct}%"></div></div>
    ${noteHtml(card)}
    <div class="expense-list">${card.isExtra ? actionHtml(card) + rows : rows + actionHtml(card)}</div>
  </div>`;
}

export function expandCategory(categoryId, { scroll = false } = {}) {
  expandedId = categoryId;
  cardsEl.querySelectorAll('.cat-card').forEach(c => {
    c.classList.toggle('expanded', Number(c.dataset.cat) === categoryId);
  });
  const card = cardsEl.querySelector(`.cat-card[data-cat="${categoryId}"]`);
  if (card && scroll) setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
}

// onEmpty(categoryIds, emptied): mark categories emptied (or not) for this period.
export function initOverview({ onEditExpense, onEmpty }) {
  const run = async (button, categoryIds, emptied) => {
    button.disabled = true;
    try {
      await onEmpty(categoryIds, emptied);
    } finally {
      button.disabled = false;
    }
  };

  cardsEl.addEventListener('click', e => {
    const action = e.target.closest('[data-action]');
    if (action) {
      const { action: kind, catId } = action.dataset;
      if (kind === 'sweep') run(action, sweepable.map(c => c.id), true);
      else run(action, [Number(catId)], kind === 'empty');
      return;
    }
    const row = e.target.closest('[data-expense]');
    if (row) {
      onEditExpense(expensesById.get(row.dataset.expense));
      return;
    }
    const card = e.target.closest('.cat-card');
    if (!card) return;
    const id = Number(card.dataset.cat);
    expandCategory(expandedId === id ? null : id);
  });

  recentEl.addEventListener('click', e => {
    const row = e.target.closest('[data-cat]');
    if (row) expandCategory(Number(row.dataset.cat), { scroll: true });
  });
}

export function renderOverview(budget, expenses) {
  expensesById = new Map(expenses.map(e => [String(e.id), e]));
  sweepable = budget.cards.filter(c => !c.isExtra && !c.emptied && c.leftover > 0);
  cardsEl.innerHTML = budget.cards.map(cardHtml).join('');

  const nameById = new Map(budget.cards.map(c => [c.id, c.name]));
  const recent = [...expenses]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 5);

  recentEl.innerHTML = recent.length
    ? recent.map(e => {
        const catId = budget.bucketOf(e);
        return `<div class="expense-row clickable" data-cat="${catId}">`
          + `<span class="merchant">${esc(e.merchant || 'Unknown')}</span>`
          + `<span class="meta">${shortDate(e.created_at)} · ${esc(nameById.get(catId))}</span>`
          + amountHtml(e)
          + `</div>`;
      }).join('')
    : '<div class="empty">Nothing yet this period. Tap + to add an expense.</div>';
}

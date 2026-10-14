import { money, sum, MONTHS_SHORT } from '../budget.js';
import { esc } from './dom.js';
import { purchaseDate, newestPurchaseFirst, toISO } from '../paydays.js';

const cardsEl = document.getElementById('categoryCards');
const recentEl = document.getElementById('recentList');

let expandedId = null;
let expensesById = new Map();
let sweepable = []; // categories with money left that haven't been emptied
let authorColors = new Map(); // user_id → dot colour; see renderOverview
let cardsById = new Map(); // this period's budget cards, for dating overages

function shortDate(d) {
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

// An overage is dated by the latest purchase in the category that went over.
function overageDate(o) {
  const dates = (cardsById.get(o.categoryId)?.expenses ?? []).map(purchaseDate);
  return dates.length ? new Date(Math.max(...dates)) : new Date(o.created_at);
}

// Gives an overage a spent_on, so it sorts among purchases (newestPurchaseFirst).
const datedOverage = o => ({ ...o, spent_on: toISO(overageDate(o)) });

function amountHtml(e) {
  return e.transaction_type === 'refund'
    ? `<span class="amt-refund">+${money(e.amount)}</span>`
    : `<span>${money(e.amount)}</span>`;
}

// Who added it, as a small dot before the merchant name. Nothing for
// expenses from before this was tracked (created_by is null) — no dot
// rather than a guess.
function authorDotHtml(e) {
  const color = e.created_by ? authorColors.get(e.created_by) : null;
  return color ? `<span class="author-dot" style="background:${esc(color)};"></span>` : '';
}

function expenseRowHtml(e, meta) {
  return `<div class="expense-row clickable" data-expense="${e.id}">`
    + `<span class="merchant">${authorDotHtml(e)}${esc(e.merchant || 'Unknown')}</span>`
    + `<span class="meta">${esc(meta)}</span>`
    + amountHtml(e)
    + `</div>`;
}

// An overage Extra covered, shown like a purchase. Tapping it opens the
// category that went over.
function overageRowHtml(o, meta) {
  return `<div class="expense-row clickable overage" data-cat="${o.categoryId}">`
    + `<span class="merchant">${esc(o.name)} overage</span>`
    + `<span class="meta">${esc(meta)}</span>`
    + `<span>${money(o.amount)}</span>`
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

// "$180 left" over a small "of $300", or "$20 over" (red) over "$300 budget".
function numsHtml(card) {
  const left = card.budget - card.spent - (card.covered ?? 0);
  const budget = `<span${card.budget < 0 ? ' class="negative"' : ''}>${money(card.budget)}</span>`;
  return left < 0
    ? `<b class="negative">${money(-left)} over</b><small>${budget} budget</small>`
    : `<b>${money(left)} left</b><small>of ${budget}</small>`;
}

// First line of an expanded card.
function detailHtml(card) {
  return `<div class="cat-detail">Spent ${money(card.spent + (card.covered ?? 0))}</div>`;
}

function cardHtml(card) {
  // Extra's list mixes its own expenses with the overages it covered.
  const items = [
    ...card.expenses.map(e => ({ ...e, html: () => expenseRowHtml(e, `${shortDate(purchaseDate(e))} · ${e.card}`) })),
    ...(card.overages ?? []).map(o => ({ ...datedOverage(o), html: () => overageRowHtml(o, `${shortDate(overageDate(o))} · Auto`) })),
  ];
  const rows = items.length
    ? items.sort(newestPurchaseFirst).map(i => i.html()).join('')
    : '<div class="empty">No expenses yet.</div>';
  return `<div class="cat-card${card.id === expandedId ? ' expanded' : ''}" data-cat="${card.id}">
    <div class="cat-top">
      <div class="cat-name-row"><span class="chevron">›</span><span class="cat-dot" style="background:${esc(card.color)};"></span><div class="cat-name">${esc(card.name)}</div></div>
      <div class="cat-nums">${numsHtml(card)}</div>
    </div>
    <div class="bar-track"><div class="bar-fill ${card.bar.cls}" style="width:${card.bar.pct}%"></div></div>
    ${noteHtml(card)}
    <div class="expense-list">${detailHtml(card)}${card.isExtra ? actionHtml(card) + rows : rows + actionHtml(card)}</div>
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
    const overage = e.target.closest('.overage[data-cat]');
    if (overage) {
      expandCategory(Number(overage.dataset.cat), { scroll: true });
      return;
    }
    const card = e.target.closest('.cat-card');
    if (!card) return;
    const id = Number(card.dataset.cat);
    expandCategory(expandedId === id ? null : id);
  });

  recentEl.addEventListener('click', e => {
    const savings = e.target.closest('[data-expense]'); // savings rows have no category card
    if (savings) {
      onEditExpense(expensesById.get(savings.dataset.expense));
      return;
    }
    const row = e.target.closest('[data-cat]');
    if (row) expandCategory(Number(row.dataset.cat), { scroll: true });
  });
}

// authorColors: Map<user_id, hexColor> — who gets which dot; see app.js.
// expenses: all of the period's, savings purchases included (only Recent
// activity shows those; the budget cards never count them).
export function renderOverview(budget, expenses, colors = new Map()) {
  authorColors = colors;
  cardsById = new Map(budget.cards.map(c => [c.id, c]));
  expensesById = new Map(expenses.map(e => [String(e.id), e]));
  sweepable = budget.cards.filter(c => !c.isExtra && !c.emptied && c.leftover > 0);
  cardsEl.innerHTML = budget.cards.map(cardHtml).join('');

  const nameById = new Map(budget.cards.map(c => [c.id, c.name]));
  const extraCard = budget.cards.find(c => c.isExtra);
  const overages = extraCard.overages.map(o => datedOverage({ ...o, isOverage: true }));
  const recent = [...expenses, ...overages]
    .sort(newestPurchaseFirst)
    .slice(0, 5);

  recentEl.innerHTML = recent.length
    ? recent.map(e => {
        if (e.isOverage) return overageRowHtml(e, `${shortDate(purchaseDate(e))} · Auto`);
        if (e.from_savings) {
          return `<div class="expense-row clickable excluded" data-expense="${e.id}">`
            + `<span class="merchant">${authorDotHtml(e)}${esc(e.merchant || 'Unknown')}<span class="savings-tag">Savings</span></span>`
            + `<span class="meta">${shortDate(purchaseDate(e))} · Not in budget</span>`
            + amountHtml(e)
            + `</div>`;
        }
        const catId = budget.bucketOf(e);
        return `<div class="expense-row clickable" data-cat="${catId}">`
          + `<span class="merchant">${authorDotHtml(e)}${esc(e.merchant || 'Unknown')}</span>`
          + `<span class="meta">${shortDate(purchaseDate(e))} · ${esc(nameById.get(catId))}</span>`
          + amountHtml(e)
          + `</div>`;
      }).join('')
    : '<div class="empty">Nothing yet this period. Tap + to add an expense.</div>';
}

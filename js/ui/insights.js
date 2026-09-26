// Insights: where the money goes, whether Extra is growing, and how often
// each category stays on budget — across several pay periods.
import * as db from '../data.js';
import {
  money, sum, signedAmount, MONTHS_SHORT, buildBudget, snapshotCategories,
  periodsInRange, periodKey, groupByPeriod, extraLeftover, budgetStatus, overBudgetPattern,
} from '../budget.js';
import { fromISO } from '../paydays.js';
import { groupByMerchant, biggestPurchase } from '../merchants.js';
import { esc, errorMessage, selectChip } from './dom.js';

const chipsEl = document.getElementById('rangeChips');
const bodyEl = document.getElementById('insightsBody');

const TOP_STORES = 5;
const STATUS_LABELS = { under: 'under budget', near: 'on budget', over: 'over budget' };

let ctx;
let range = '6';
let cache = null;        // rows loaded for periods from cache.fromYear on
let loadToken = 0;
let periods = [];        // what's on screen: [{ row, budget, current, label }]
let scoreRows = [];
let selectedCategoryId = null;
let selectedBar = null;  // index into periods
let selectedCell = null; // { row, col } in the scorecard

// Called after anything is saved so the next Insights view refetches.
export function invalidateInsights() {
  cache = null;
}

// ctx: { get() → { payPeriods, categories, extraCategory, currentStartISO, categoryIdOf, periodLabel(row) } }
export function initInsights(context) {
  ctx = context;

  chipsEl.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    selectChip(chipsEl, chip);
    range = chip.dataset.range;
    selectedBar = null;
    selectedCell = null;
    renderInsights();
  });

  bodyEl.addEventListener('click', e => {
    const category = e.target.closest('[data-category]');
    const bar = e.target.closest('[data-bar]');
    const cell = e.target.closest('[data-cell]');
    if (category) selectedCategoryId = Number(category.dataset.category);
    else if (bar) selectedBar = Number(bar.dataset.bar);
    else if (cell) {
      const [row, col] = cell.dataset.cell.split(':').map(Number);
      selectedCell = { row, col };
    } else return;
    draw();
  });
}

// ---------- Loading ----------

async function ensureLoaded(fromYear, payPeriods) {
  if (cache && cache.fromYear <= fromYear) return;
  const periodIds = payPeriods.filter(r => r.year >= fromYear).map(r => r.id);
  const [expenses, fixedCosts, periodCategories, carry, carryStart] = await Promise.all([
    db.loadExpensesSince(fromYear),
    db.loadFixedCostsSince(fromYear),
    db.loadPeriodCategoriesFor(periodIds),
    db.loadAllCarryIn(),
    db.loadCarryStart(),
  ]);
  cache = { fromYear, expenses, fixedCosts, periodCategories, carry, carryStart };
}

export async function renderInsights() {
  const token = ++loadToken;
  const { payPeriods, currentStartISO } = ctx.get();
  const rows = periodsInRange(payPeriods, range, currentStartISO);
  if (!rows.length) {
    bodyEl.innerHTML = '<div class="empty">No pay periods in this range yet.</div>';
    return;
  }
  try {
    if (!cache || cache.fromYear > rows[0].year) {
      bodyEl.innerHTML = '<div class="empty">Loading…</div>';
    }
    await ensureLoaded(rows[0].year, payPeriods);
  } catch (err) {
    if (token === loadToken) bodyEl.innerHTML = `<div class="empty">Couldn't load insights: ${esc(errorMessage(err))}</div>`;
    return;
  }
  if (token !== loadToken) return;
  periods = summarize(rows);
  draw();
}

// Rebuilds each period's budget exactly as the Overview does.
function summarize(rows) {
  const { categories, extraCategory, currentStartISO, categoryIdOf, periodLabel } = ctx.get();
  const byId = new Map(categories.map(c => [c.id, c]));
  const carry = new Map(cache.carry.map(r => [r.period_id, r.carry_in]));
  const snapshots = groupByPeriod(cache.periodCategories, pc => pc.period_id);
  const fixed = groupByPeriod(cache.fixedCosts, f => periodKey(f.year, f.month, f.period_start_day));
  const spending = groupByPeriod(cache.expenses, e => periodKey(e.year, e.month, e.period_start_day));

  return rows.map(row => {
    const key = periodKey(row.year, row.month, row.start_day);
    const budget = buildBudget({
      starting: row.starting_amount,
      carryIn: carry.get(row.id) ?? 0,
      fixedCosts: fixed.get(key) ?? [],
      periodCategories: snapshotCategories(snapshots.get(row.id) ?? [], byId),
      extraCategory,
      expenses: spending.get(key) ?? [],
      categoryIdOf,
    });
    const current = row.start_date === currentStartISO;
    return { row, budget, current, label: periodLabel(row) + (current ? ' (so far)' : '') };
  });
}

// ---------- Drawing ----------

function draw() {
  bodyEl.innerHTML = whereHtml() + aheadHtml() + scoreHtml();
}

const signed = n => (n > 0 ? '+' : '') + money(n);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function shortDate(value) {
  const d = typeof value === 'string' && value.length === 10 ? fromISO(value) : new Date(value);
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

// Month name under the first pay period of each month.
const monthLabel = row => (row.start_day === 1 ? MONTHS_SHORT[row.month - 1] : '');

function whereHtml() {
  // Each expense counts where the Overview put it (off-list categories land in Extra).
  const byCategory = new Map();
  for (const p of periods) {
    for (const card of p.budget.cards) {
      if (!card.expenses.length) continue;
      if (!byCategory.has(card.id)) byCategory.set(card.id, { card, expenses: [] });
      byCategory.get(card.id).expenses.push(...card.expenses);
    }
  }
  const choices = [...byCategory.values()]
    .sort((a, b) => (a.card.isExtra - b.card.isExtra) || (a.card.sort_order - b.card.sort_order) || (a.card.id - b.card.id));

  let body;
  if (!choices.length) {
    body = '<div class="empty">No spending in this range yet.</div>';
  } else {
    if (!byCategory.has(selectedCategoryId)) selectedCategoryId = choices[0].card.id;
    const { card, expenses } = byCategory.get(selectedCategoryId);
    const stores = groupByMerchant(expenses);
    const top = stores.slice(0, TOP_STORES);
    const rest = stores.slice(TOP_STORES);
    const widest = Math.max(...top.map(s => s.total), 1);
    const trips = expenses.filter(e => e.transaction_type !== 'refund').length;
    const biggest = biggestPurchase(expenses);

    const chips = choices.map(({ card: c }) =>
      `<button type="button" class="chip${c.id === selectedCategoryId ? ' selected' : ''}" data-category="${c.id}">`
      + `<span class="cat-dot" style="background:${esc(c.color)};"></span>${esc(c.name)}</button>`).join('');

    const storeRows = top.map(s => `
      <div class="store-row">
        <div class="store-name"><div>${esc(s.name)}</div><div class="store-meta">${plural(s.trips, 'trip')}${s.trips ? ` · avg ${money(s.average)}` : ''}</div></div>
        <div class="store-total"><div>${money(s.total)}</div><div class="store-bar" style="width:${Math.max(0, Math.round((s.total / widest) * 100))}%; background:${esc(card.color)};"></div></div>
      </div>`).join('');

    body = `<div class="chips insight-cats">${chips}</div>
      <div class="insight-lead"><b>${money(sum(expenses, signedAmount))}</b> on ${esc(card.name)} · ${plural(trips, 'trip')}</div>
      ${storeRows}
      ${rest.length ? `<div class="store-more">+ ${plural(rest.length, 'more place')} · ${money(sum(rest, s => s.total))}</div>` : ''}
      ${biggest ? `<div class="insight-note">Biggest purchase: ${esc(biggest.merchant || 'Unknown')}, ${money(biggest.amount)} on ${shortDate(biggest.created_at)}</div>` : ''}`;
  }
  return `<div class="summary-card insight-card"><h3>Where does it go?</h3>${body}</div>`;
}

function aheadHtml() {
  const { currentStartISO } = ctx.get();
  const { carryStart } = cache;
  const now = periods.find(p => p.current);

  let headline;
  if (!carryStart || currentStartISO < carryStart) {
    headline = `<div class="insight-big">$0</div><div class="insight-sub">Extra starts carrying over ${carryStart ? shortDate(carryStart) : 'soon'}.</div>`;
  } else {
    const built = now ? now.budget.carryIn : 0;
    headline = `<div class="insight-big${built < 0 ? ' negative' : ' positive'}">${signed(built)}</div>`
      + `<div class="insight-sub">Built up in Extra since ${shortDate(carryStart)}, carried into this pay period.</div>`;
  }

  const values = periods.map(p => extraLeftover(p.budget));
  const tallest = Math.max(...values.map(Math.abs), 1);
  const finished = periods.map((p, i) => (p.current ? -1 : i)).filter(i => i >= 0);
  const shown = selectedBar ?? finished.at(-1) ?? periods.length - 1;

  const bars = periods.map((p, i) => {
    const v = values[i];
    const cls = ['xbar', v < 0 ? 'neg' : '', p.current ? 'so-far' : '', i === shown ? 'selected' : ''].join(' ');
    return `<div class="xbar-slot"><button type="button" class="${cls}" data-bar="${i}" `
      + `style="height:${v ? Math.max(4, Math.round((Math.abs(v) / tallest) * 100)) : 2}%;" aria-label="${esc(p.label)}: ${signed(v)}"></button></div>`;
  }).join('');
  const labels = periods.map(p => `<span>${monthLabel(p.row)}</span>`).join('');
  const detail = `${esc(periods[shown].label)}: <b class="${values[shown] < 0 ? 'negative' : ''}">${signed(values[shown])}</b> left in Extra`;

  return `<div class="summary-card insight-card">
    <h3>Are we coming out ahead?</h3>
    ${headline}
    <div class="xbars">${bars}</div>
    <div class="period-labels">${labels}</div>
    <div class="insight-detail">${detail}</div>
  </div>`;
}

function scoreHtml() {
  const seen = new Map();
  for (const p of periods) {
    for (const c of p.budget.cards) if (!c.isExtra && !seen.has(c.id)) seen.set(c.id, c);
  }
  const categories = [...seen.values()].sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
  scoreRows = categories.map(c => ({
    name: c.name,
    cells: periods.map(p => {
      const card = p.budget.cards.find(x => !x.isExtra && x.id === c.id);
      return card ? { status: budgetStatus(card.spent, card.amount), spent: card.spent, amount: card.amount, current: p.current } : null;
    }),
  }));

  if (!scoreRows.length) {
    return '<div class="summary-card insight-card"><h3>Did we stay on budget?</h3><div class="empty">No categories in this range.</div></div>';
  }

  const columns = `grid-template-columns:minmax(0,76px) repeat(${periods.length}, minmax(0,1fr));`;
  const header = '<span></span>' + periods.map(p => `<span class="score-month">${monthLabel(p.row)}</span>`).join('');
  const rows = scoreRows.map((r, ri) => `<span class="score-name">${esc(r.name)}</span>` + r.cells.map((cell, ci) => {
    if (!cell) return '<span class="sq sq-none"></span>';
    const selected = selectedCell && selectedCell.row === ri && selectedCell.col === ci ? ' selected' : '';
    return `<button type="button" class="sq sq-${cell.status}${cell.current ? ' so-far' : ''}${selected}" data-cell="${ri}:${ci}" `
      + `aria-label="${esc(r.name)}, ${esc(periods[ci].label)}: ${STATUS_LABELS[cell.status]}"></button>`;
  }).join('')).join('');

  let detail = 'Tap a square for details.';
  const picked = selectedCell && scoreRows[selectedCell.row]?.cells[selectedCell.col];
  if (picked) {
    const r = scoreRows[selectedCell.row];
    detail = `${esc(r.name)}, ${esc(periods[selectedCell.col].label)}: <b>${money(picked.spent)}</b> of ${money(picked.amount)} · ${STATUS_LABELS[picked.status]}`;
  }
  const pattern = overBudgetPattern(scoreRows);

  return `<div class="summary-card insight-card">
    <h3>Did we stay on budget?</h3>
    <div class="scorecard" style="${columns}">${header}${rows}</div>
    <div class="score-legend">
      <span><i class="sq-key sq-under"></i>Under</span>
      <span><i class="sq-key sq-near"></i>Within $10</span>
      <span><i class="sq-key sq-over"></i>Over</span>
      <span><i class="sq-key so-far"></i>So far</span>
    </div>
    ${pattern ? `<div class="insight-pattern">${esc(pattern)}</div>` : ''}
    <div class="insight-detail">${detail}</div>
  </div>`;
}

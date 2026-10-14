// Insights: where the money goes, how fast it goes through a pay period,
// and how often each category stays on budget — across several pay periods.
import * as db from '../data.js';
import {
  money, sum, signedAmount, MONTHS_SHORT, buildBudget, snapshotCategories,
  periodsInRange, periodKey, groupByPeriod, budgetStatus, overBudgetPattern, paceLines, halfwayDay, coversOverages,
} from '../budget.js';
import { today, purchaseDate, dayOfPeriod } from '../paydays.js';
import { groupByMerchant, biggestPurchase } from '../merchants.js';
import { esc, errorMessage, selectChip } from './dom.js';

const chipsEl = document.getElementById('rangeChips');
const bodyEl = document.getElementById('insightsBody');

const TOP_STORES = 5;
const PACE_NEAR = 10; // within this many dollars of the usual pace = "right on" it
const STATUS_LABELS = { under: 'under budget', near: 'on budget', over: 'over budget' };

let ctx;
let range = '6';
let cache = null;        // rows loaded for periods from cache.fromYear on
let loadToken = 0;
let periods = [];        // what's on screen: [{ row, budget, current, label }]
let scoreRows = [];
let selectedCategoryId = null;
let paceCategoryId = 'all'; // 'all' or a category id
let paceDay = null;      // day tapped on the pace chart
let selectedCell = null; // { row, col } in the scorecard

// Called after anything is saved so the next Insights view refetches.
export function invalidateInsights() {
  cache = null;
}

// ctx: { get() → { payPeriods, categories, extraCategory, currentStartISO, categoryIdOf,
//                  periodLabel(row), periodDates(row) → { start, end } (local Dates) } }
export function initInsights(context) {
  ctx = context;

  chipsEl.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    selectChip(chipsEl, chip);
    range = chip.dataset.range;
    paceDay = null;
    selectedCell = null;
    renderInsights();
  });

  bodyEl.addEventListener('click', e => {
    const category = e.target.closest('[data-category]');
    const paceCategory = e.target.closest('[data-pace-category]');
    const day = e.target.closest('[data-pace-day]');
    const cell = e.target.closest('[data-cell]');
    if (category) selectedCategoryId = Number(category.dataset.category);
    else if (paceCategory) {
      const id = paceCategory.dataset.paceCategory;
      paceCategoryId = id === 'all' ? 'all' : Number(id);
    } else if (day) paceDay = Number(day.dataset.paceDay);
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
  const [expenses, fixedCosts, periodCategories, carry, overageStart] = await Promise.all([
    db.loadExpensesSince(fromYear),
    db.loadFixedCostsSince(fromYear),
    db.loadPeriodCategoriesFor(periodIds),
    db.loadAllCarryIn(),
    db.loadOverageStart(),
  ]);
  cache = { fromYear, expenses, fixedCosts, periodCategories, carry, overageStart };
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
  const { categories, extraCategory, currentStartISO, categoryIdOf, periodLabel, periodDates } = ctx.get();
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
      coverOverages: coversOverages(row.start_date, cache.overageStart),
    });
    const current = row.start_date === currentStartISO;
    const { start, end } = periodDates(row);
    return { row, budget, current, start, end, label: periodLabel(row) + (current ? ' (so far)' : '') };
  });
}

// ---------- Drawing ----------

function draw() {
  bodyEl.innerHTML = whereHtml() + paceHtml() + scoreHtml();
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const shortDate = d => `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;

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
      ${biggest ? `<div class="insight-note">Biggest purchase: ${esc(biggest.merchant || 'Unknown')}, ${money(biggest.amount)} on ${shortDate(purchaseDate(biggest))}</div>` : ''}`;
  }
  return `<div class="summary-card insight-card"><h3>Where does it go?</h3>${body}</div>`;
}

// "When does the money go?" — the running total of spending through a pay
// period: the usual pace (finished periods in the range), this period so far,
// and an even pace for reference. Tap a day to see its numbers.
function paceHtml() {
  const seen = new Map();
  for (const p of periods) {
    for (const c of p.budget.cards) if (c.expenses.length && !seen.has(c.id)) seen.set(c.id, c);
  }
  const wrap = body => `<div class="summary-card insight-card"><h3>When does the money go?</h3>${body}</div>`;
  if (!seen.size) return wrap('<div class="empty">No spending in this range yet.</div>');

  if (paceCategoryId !== 'all' && !seen.has(paceCategoryId)) paceCategoryId = 'all';
  const chosen = paceCategoryId === 'all' ? null : seen.get(paceCategoryId);
  const choices = [...seen.values()]
    .sort((a, b) => (a.isExtra - b.isExtra) || (a.sort_order - b.sort_order) || (a.id - b.id));
  const chips = `<button type="button" class="chip${chosen ? '' : ' selected'}" data-pace-category="all">All</button>`
    + choices.map(c =>
      `<button type="button" class="chip${c === chosen ? ' selected' : ''}" data-pace-category="${c.id}">`
      + `<span class="cat-dot" style="background:${esc(c.color)};"></span>${esc(c.name)}</button>`).join('');

  const now = today();
  const { usual, now: soFar } = paceLines(periods.map(p => {
    const expenses = chosen
      ? (p.budget.cards.find(c => c.id === chosen.id)?.expenses ?? [])
      : p.budget.cards.flatMap(c => c.expenses);
    return {
      length: dayOfPeriod(p.end, p.start),
      current: p.current,
      today: dayOfPeriod(now, p.start),
      spends: expenses.map(e => ({ day: dayOfPeriod(purchaseDate(e), p.start), amount: signedAmount(e) })),
    };
  }));

  // Headline: ahead of (red) or behind (green) the usual pace on today's day.
  const what = chosen ? ` on ${esc(chosen.name)}` : '';
  let headline = '';
  if (soFar && usual) {
    const day = soFar.length;
    const diff = Math.round(soFar.at(-1) - usual[Math.min(day, usual.length) - 1]);
    const spent = `${money(soFar.at(-1))} spent so far${what}`;
    headline = Math.abs(diff) <= PACE_NEAR
      ? `<div class="insight-big">Right on your usual pace</div><div class="insight-sub">Day ${day} · ${spent}</div>`
      : `<div class="insight-big ${diff > 0 ? 'negative' : 'positive'}">${money(Math.abs(diff))} ${diff > 0 ? 'ahead of' : 'behind'}</div>`
        + `<div class="insight-sub">your usual pace on day ${day} · ${spent}</div>`;
  } else if (!usual) {
    headline = '<div class="insight-sub">Not enough history yet. Your usual pace appears after your first full pay period.</div>';
  }

  // Chart: x = day of the period (0 = before payday), y = running total.
  const current = periods.find(p => p.current);
  const days = Math.max(usual?.length ?? 0, current ? dayOfPeriod(current.end, current.start) : 0);
  const values = [0, ...(usual ?? []), ...(soFar ?? [])];
  const total = usual?.at(-1) ?? 0;
  const high = Math.max(...values, 1) * 1.05;
  const low = Math.min(...values);
  const W = 300, H = 150, L = 38, R = 8, T = 8, B = 18;
  const x = d => L + (d / days) * (W - L - R);
  const y = v => T + ((high - v) / (high - low)) * (H - T - B);
  const pts = line => [0, ...line].map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const gridValues = total > 0 ? [0, total / 2, total] : [0, high / 1.05];
  const grid = gridValues.map(v => `<line class="pace-grid" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`
    + `<text x="${L - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${money(v)}</text>`).join('');
  const ticks = [1, 5, 10, 15].filter(d => d <= days)
    .map(d => `<text x="${x(d).toFixed(1)}" y="${H - 4}" text-anchor="${d === days ? 'end' : 'middle'}">Day ${d}</text>`).join('');
  if (paceDay > days) paceDay = null;

  let marks = '';
  if (usual) {
    marks += `<polygon class="pace-area" points="${pts(usual)} ${x(usual.length).toFixed(1)},${y(Math.max(0, low)).toFixed(1)}"/>`
      + `<line class="pace-even" x1="${x(0)}" y1="${y(0).toFixed(1)}" x2="${x(usual.length).toFixed(1)}" y2="${y(total).toFixed(1)}"/>`
      + `<polyline class="pace-usual" points="${pts(usual)}"/>`;
  }
  if (soFar) {
    marks += `<polyline class="pace-now" points="${pts(soFar)}"/>`
      + `<circle class="pace-dot" cx="${x(soFar.length).toFixed(1)}" cy="${y(soFar.at(-1)).toFixed(1)}" r="3.5"/>`;
  }
  if (paceDay) {
    marks += `<line class="pace-pick" x1="${x(paceDay).toFixed(1)}" x2="${x(paceDay).toFixed(1)}" y1="${T}" y2="${H - B}"/>`;
    if (usual) marks += `<circle class="pace-pick-usual" cx="${x(paceDay).toFixed(1)}" cy="${y(usual[Math.min(paceDay, usual.length) - 1]).toFixed(1)}" r="3"/>`;
    if (soFar && paceDay <= soFar.length) marks += `<circle class="pace-dot" cx="${x(paceDay).toFixed(1)}" cy="${y(soFar[paceDay - 1]).toFixed(1)}" r="3"/>`;
  }
  // One invisible column per day, centred on it, to tap.
  const column = x(1) - x(0);
  const columns = Array.from({ length: days }, (_, i) =>
    `<rect class="pace-hit" data-pace-day="${i + 1}" x="${(x(i + 1) - column / 2).toFixed(1)}" y="${T}" width="${column.toFixed(1)}" height="${H - T - B}"/>`).join('');

  const svg = `<svg class="pace-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Running total of spending through the pay period">`
    + `${grid}${ticks}${marks}${columns}</svg>`;

  const legend = [
    usual ? '<span><i class="pace-key usual"></i>Usual</span>' : '',
    soFar ? '<span><i class="pace-key now"></i>This period</span>' : '',
    usual ? '<span><i class="pace-key even"></i>Even pace</span>' : '',
  ].join('');

  let detail = 'Tap the chart to see a day.';
  if (paceDay) {
    const parts = [];
    if (usual) parts.push(`usual <b>${money(usual[Math.min(paceDay, usual.length) - 1])}</b>`);
    if (soFar) parts.push(paceDay <= soFar.length ? `this period <b>${money(soFar[paceDay - 1])}</b>` : 'not reached yet this period');
    detail = `Day ${paceDay}: ${parts.join(' · ')}`;
  }

  const half = halfwayDay(usual);
  const lead = half ? `<div class="insight-pattern">Half of ${chosen ? 'it' : 'the money'} usually goes by <b>day ${half}</b>.</div>` : '';

  return wrap(`<div class="chips insight-cats">${chips}</div>${headline}${svg}`
    + `<div class="pace-legend">${legend}</div><div class="insight-detail">${detail}</div>${lead}`);
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

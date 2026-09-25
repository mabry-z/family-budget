import * as db from '../data.js';
import { money, trendMonths, monthlyTotals } from '../budget.js';
import { esc, errorMessage, selectChip } from './dom.js';

const chipsEl = document.getElementById('rangeChips');
const chartsEl = document.getElementById('trendCharts');

let range = '6';
let cache = null; // { fromYear, rows }
let lastArgs = null;

// Called after anything is saved so the next Trends view refetches.
export function invalidateTrends() {
  cache = null;
}

export function initTrends() {
  chipsEl.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    selectChip(chipsEl, chip);
    range = chip.dataset.range;
    if (lastArgs) renderTrends(...lastArgs);
  });
}

function chartHtml(category, months, values) {
  const max = Math.max(...values, 0);
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  const bars = months.map((m, i) => {
    const value = values[i];
    const pct = max > 0 && value > 0 ? Math.max(6, Math.round((value / max) * 100)) : 0;
    const current = i === months.length - 1 ? ' current' : '';
    return `<div class="chart-bar-wrap"><span class="chart-value">${money(value)}</span>`
      + `<div class="bar-area"><div class="chart-bar${current}" style="height:${pct}%"></div></div>`
      + `<span class="chart-label">${m.label}</span></div>`;
  }).join('');
  return `<div class="chart-card">
    <div class="chart-top"><h3>${esc(category.name)}</h3><span class="chart-total">Avg ${money(avg)}/mo</span></div>
    <div class="chart-bars">${bars}</div>
  </div>`;
}

// categories: active, non-Extra categories to chart.
export async function renderTrends(categories, categoryIdOf) {
  lastArgs = [categories, categoryIdOf];
  const months = trendMonths(range, new Date());
  const fromYear = months[0].year;

  try {
    if (!cache || cache.fromYear > fromYear) {
      chartsEl.innerHTML = '<div class="empty">Loading…</div>';
      cache = { fromYear, rows: await db.loadExpensesSince(fromYear) };
    }
  } catch (err) {
    chartsEl.innerHTML = `<div class="empty">Couldn't load trends: ${esc(errorMessage(err))}</div>`;
    return;
  }

  chartsEl.innerHTML = categories.length
    ? categories.map(c => chartHtml(c, months, monthlyTotals(cache.rows, months, c.id, categoryIdOf))).join('')
    : '<div class="empty">No categories to chart.</div>';
}

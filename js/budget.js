// Pure budget math and period helpers — no DOM, no Supabase.

export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- Money ----------

export function money(n) {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US');
}

// Whole dollars only. Returns null for anything else ("12.50", "abc", "").
export function parseWhole(text) {
  const s = String(text ?? '').replace(/[$,\s]/g, '');
  return /^\d+$/.test(s) ? Number(s) : null;
}

export function sum(list, pick) {
  return list.reduce((total, item) => total + (Number(pick(item)) || 0), 0);
}

export function signedAmount(expense) {
  const amount = Number(expense.amount);
  return expense.transaction_type === 'refund' ? -amount : amount;
}

// ---------- Pay periods ----------
// A period is { year, month (1–12), startDay (1 or 16) }. startDay is only an
// identifier — 16 means "the mid-month paycheck", which normally starts on the
// 15th. Real start dates come from pay_periods.starts_on (see app.js).

// Normal-schedule period for a date (1st–14th / 15th–end), used when there's
// no confirmed start date to go by.
export function periodForDate(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    startDay: date.getDate() <= 14 ? 1 : 16,
  };
}

export function shiftPeriod(period, direction) {
  let { year, month, startDay } = period;
  if (direction > 0) {
    if (startDay === 1) startDay = 16;
    else { startDay = 1; month += 1; }
  } else {
    if (startDay === 16) startDay = 1;
    else { startDay = 16; month -= 1; }
  }
  if (month === 13) { month = 1; year += 1; }
  if (month === 0) { month = 12; year -= 1; }
  return { year, month, startDay };
}

// "2026-09-16" — sorts correctly as a string.
export function periodStartISO(period) {
  const pad = n => String(n).padStart(2, '0');
  return `${period.year}-${pad(period.month)}-${pad(period.startDay)}`;
}

export function samePeriod(a, b) {
  return periodStartISO(a) === periodStartISO(b);
}

// ---------- Budget ----------

// An emptied category keeps only what was spent (never below 0, never above
// its budget); the rest of its money belongs to Extra for that period.
export function effectiveBudget(amount, spent, emptied) {
  return emptied ? Math.max(0, Math.min(amount, spent)) : amount;
}

export function barFor(spent, budget, isExtra) {
  if (budget <= 0) {
    return spent > 0 ? { pct: 100, cls: 'fill-over' } : { pct: 0, cls: isExtra ? 'fill-accent' : 'fill-ok' };
  }
  const ratio = spent / budget;
  const cls = ratio > 1 ? 'fill-over'
    : isExtra ? 'fill-accent'
    : ratio >= 0.85 ? 'fill-warn'
    : 'fill-ok';
  return { pct: Math.round(Math.min(Math.max(ratio, 0), 1) * 100), cls };
}

// A period's category snapshot as buildBudget wants it: each non-Extra
// category with that period's amount, in display order.
// periodCategories: period_categories rows; categoriesById: Map of categories.
export function snapshotCategories(periodCategories, categoriesById) {
  return periodCategories
    .filter(pc => categoriesById.has(pc.category_id) && !categoriesById.get(pc.category_id).is_remainder)
    .map(pc => ({ ...categoriesById.get(pc.category_id), amount: pc.amount, emptied: pc.emptied }))
    .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
}

// One entry per card on the Overview, Extra last. Expenses whose category
// isn't part of this period land in Extra so nothing goes missing.
//
// Extra is never stored: starting − fixed costs − every other category's
// (effective) budget + whatever Extra carried in from the previous period.
export function buildBudget({ starting, carryIn, fixedCosts, periodCategories, extraCategory, expenses, categoryIdOf }) {
  const fixedTotal = sum(fixedCosts, f => f.amount);
  const inPeriod = new Set(periodCategories.map(c => c.id));
  const bucketOf = e => {
    const id = categoryIdOf(e);
    return inPeriod.has(id) ? id : extraCategory.id;
  };
  const withSpending = c => {
    const list = expenses.filter(e => bucketOf(e) === c.id);
    return { ...c, expenses: list, spent: sum(list, signedAmount) };
  };

  const categoryCards = periodCategories.map(withSpending).map(c => {
    const budget = effectiveBudget(c.amount, c.spent, c.emptied);
    return {
      ...c,
      isExtra: false,
      budget,
      moved: c.amount - budget,            // sent to Extra by emptying
      leftover: Math.max(0, c.amount - c.spent), // what emptying would move
    };
  });
  const moved = sum(categoryCards, c => c.moved);
  const extra = starting + carryIn - fixedTotal - sum(categoryCards, c => c.budget);
  const extraCard = { ...withSpending(extraCategory), isExtra: true, budget: extra, carryIn };

  const cards = [...categoryCards, extraCard].map(c => ({ ...c, bar: barFor(c.spent, c.budget, c.isExtra) }));
  const toSpend = starting + carryIn - fixedTotal; // everything left after bills, Extra included
  const spent = sum(cards, c => c.spent);
  return {
    cards, bucketOf, starting, carryIn, fixedTotal, extra, moved,
    toSpend, spent, left: toSpend - spent,
  };
}

export function cardTotals(expenses, cards) {
  const totals = new Map(cards.map(c => [c.value, 0]));
  for (const e of expenses) totals.set(e.card, (totals.get(e.card) ?? 0) + signedAmount(e));
  return [...totals].map(([card, total]) => ({ card, total }));
}

// ---------- Insights ----------
// Everything is counted by pay period, never calendar month, and only real
// spending counts (never money moved to Extra or carried over).

const RANGE_PERIODS = { 3: 6, 6: 12 }; // two pay periods a month

// Existing pay_periods rows in the range, oldest first, ending with the
// current period. range: '3' | '6' (months) | 'ytd'.
export function periodsInRange(rows, range, currentStartISO) {
  const upToNow = rows.filter(r => r.start_date <= currentStartISO);
  if (range === 'ytd') return upToNow.filter(r => r.start_date.slice(0, 4) === currentStartISO.slice(0, 4));
  return upToNow.slice(-RANGE_PERIODS[range]);
}

// Groups rows by the period they belong to. key: (year, month, startDay).
export const periodKey = (year, month, startDay) => `${year}-${month}-${startDay}`;

export function groupByPeriod(list, keyOf) {
  const groups = new Map();
  for (const item of list) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

// What was left in a period's Extra, not counting what it carried in.
export function extraLeftover(budget) {
  const extra = budget.cards.find(c => c.isExtra);
  return extra.budget - budget.carryIn - extra.spent;
}

export const NEAR_BUDGET = 10; // within this many dollars (and not over) = "on budget"

// 'under' | 'near' | 'over', judged against the category's original amount
// (a category moved to Extra still counts as under if it spent less).
export function budgetStatus(spent, amount) {
  if (spent > amount) return 'over';
  if (spent <= 0 || spent < amount - NEAR_BUDGET) return 'under';
  return 'near';
}

// One plain sentence about the finished periods in the scorecard.
// rows: [{ name, cells: [{ status, spent, amount, current } | null] }]
export function overBudgetPattern(rows) {
  let worst = null;
  let anyFinished = false;
  for (const row of rows) {
    const done = row.cells.filter(c => c && !c.current);
    if (done.length) anyFinished = true;
    const overs = done.filter(c => c.status === 'over');
    if (!overs.length) continue;
    const average = Math.round(sum(overs, c => c.spent - c.amount) / overs.length);
    const share = overs.length / done.length;
    if (!worst || share > worst.share || (share === worst.share && average > worst.average)) {
      worst = { name: row.name, overs: overs.length, done: done.length, share, average };
    }
  }
  if (!anyFinished) return '';
  if (!worst) return 'Every category stayed on budget.';
  const periods = worst.done === 1 ? 'period' : 'periods';
  return `${worst.name} went over in ${worst.overs} of ${worst.done} ${periods}, by ${money(worst.average)} on average.`;
}

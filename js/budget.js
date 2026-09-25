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
// A period is { year, month (1–12), startDay (1 or 16) }.

export function periodForDate(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    startDay: date.getDate() <= 15 ? 1 : 16,
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

export function periodLabel(period) {
  const endDay = period.startDay === 1 ? 15 : new Date(period.year, period.month, 0).getDate();
  return `${MONTHS_SHORT[period.month - 1]} ${period.startDay}–${endDay}, ${period.year}`;
}

// ---------- Budget ----------

// Extra is never stored: it's whatever is left after fixed costs and every other category.
export function extraAmount(starting, fixedCosts, periodCategories) {
  return starting - sum(fixedCosts, f => f.amount) - sum(periodCategories, c => c.amount);
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

// One entry per card on the Overview, Extra last. Expenses whose category
// isn't part of this period land in Extra so nothing goes missing.
export function buildBudget({ starting, fixedCosts, periodCategories, extraCategory, expenses, categoryIdOf }) {
  const fixedTotal = sum(fixedCosts, f => f.amount);
  const extra = extraAmount(starting, fixedCosts, periodCategories);
  const inPeriod = new Set(periodCategories.map(c => c.id));
  const bucketOf = e => {
    const id = categoryIdOf(e);
    return inPeriod.has(id) ? id : extraCategory.id;
  };

  const cards = [
    ...periodCategories.map(c => ({ ...c, budget: c.amount, isExtra: false })),
    { ...extraCategory, budget: extra, isExtra: true },
  ].map(card => {
    const list = expenses.filter(e => bucketOf(e) === card.id);
    const spent = sum(list, signedAmount);
    return { ...card, expenses: list, spent, bar: barFor(spent, card.budget, card.isExtra) };
  });

  const categoryBudgets = starting - fixedTotal;
  const spent = sum(cards, c => c.spent);
  return { cards, bucketOf, starting, fixedTotal, extra, categoryBudgets, spent, remaining: categoryBudgets - spent };
}

export function cardTotals(expenses, cards) {
  const totals = new Map(cards.map(c => [c.value, 0]));
  for (const e of expenses) totals.set(e.card, (totals.get(e.card) ?? 0) + signedAmount(e));
  return [...totals].map(([card, total]) => ({ card, total }));
}

// ---------- Trends ----------

// Calendar months ending with today's month. range: '3' | '6' | '9' | 'ytd'.
export function trendMonths(range, today) {
  const count = range === 'ytd' ? today.getMonth() + 1 : Number(range);
  const months = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1, label: MONTHS_SHORT[d.getMonth()] });
  }
  return months;
}

// Net spending per month (both pay periods of a month combined).
export function monthlyTotals(expenses, months, categoryId, categoryIdOf) {
  return months.map(m => sum(
    expenses.filter(e => e.year === m.year && e.month === m.month && categoryIdOf(e) === categoryId),
    signedAmount
  ));
}

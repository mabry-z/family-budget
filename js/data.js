// Every Supabase read and write the app makes.
import { supabase } from './supabase.js';

async function run(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

function inPeriod(query, period) {
  return query
    .eq('year', period.year)
    .eq('month', period.month)
    .eq('period_start_day', period.startDay);
}

// Creates the period from the current defaults the first time it's opened.
export function ensurePeriod(period) {
  return run(supabase.rpc('ensure_period', {
    p_year: period.year,
    p_month: period.month,
    p_start_day: period.startDay,
  }));
}

// Every period that exists, oldest first. Small: two a month.
export function loadPayPeriods() {
  return run(supabase.from('pay_periods')
    .select('id, year, month, start_day, start_date, starts_on, starting_amount')
    .order('start_date'));
}

// Confirms the day a period actually began (payday).
export function startPeriod(period, startsOnISO) {
  return run(supabase.rpc('start_period', {
    p_year: period.year,
    p_month: period.month,
    p_start_day: period.startDay,
    p_starts_on: startsOnISO,
  }));
}

// Extra carried in from earlier periods; 0 before carry-over begins.
export async function loadCarryIn(periodId) {
  const rows = await run(supabase.from('period_extra_carry').select('carry_in').eq('period_id', periodId));
  return rows.length ? rows[0].carry_in : 0;
}

export function setCategoryEmptied(periodId, categoryIds, emptied) {
  return run(supabase.from('period_categories')
    .update({ emptied })
    .eq('period_id', periodId)
    .in('category_id', categoryIds));
}

export function loadCategories() {
  return run(supabase.from('categories').select('*').order('sort_order').order('id'));
}

export function loadPeriodCategories(periodId) {
  return run(supabase.from('period_categories').select('category_id, amount, emptied').eq('period_id', periodId));
}

export function loadFixedCosts(period) {
  return run(inPeriod(
    supabase.from('fixed_costs').select('id, name, amount, is_paid, template_id'),
    period
  ).order('name'));
}

export function loadExpenses(period) {
  return run(inPeriod(
    supabase.from('expenses')
      .select('id, category, category_id, merchant, amount, card, transaction_type, created_at'),
    period
  ).order('created_at'));
}

// For Trends. Pages through results because Supabase caps each response at 1000 rows.
export async function loadExpensesSince(year) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const page = await run(
      supabase.from('expenses')
        .select('id, year, month, category, category_id, amount, transaction_type')
        .gte('year', year)
        .order('id')
        .range(from, from + pageSize - 1)
    );
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

export function addExpense(row) {
  return run(supabase.from('expenses').insert([row]));
}

export function updateExpense(id, fields) {
  return run(supabase.from('expenses').update(fields).eq('id', id));
}

// Supabase reports success even when row-level security silently blocks a
// delete, so ask for the deleted row back and check it actually went.
export async function deleteExpense(id) {
  const deleted = await run(supabase.from('expenses').delete().eq('id', id).select('id'));
  if (!deleted.length) {
    throw new Error('The database didn\'t delete it (it may not allow deletes on expenses).');
  }
}

export function setFixedPaid(id, isPaid) {
  return run(supabase.from('fixed_costs').update({ is_paid: isPaid }).eq('id', id));
}

export function saveSettings(args) {
  return run(supabase.rpc('save_settings', args));
}

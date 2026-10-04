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

// The signed-in user's household ({ name, role, members }), or null if they
// aren't in one. Every other read is limited to this household by the database.
export function loadHouseholdInfo() {
  return run(supabase.rpc('household_info'));
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
    supabase.from('fixed_costs')
      .select('id, name, amount, is_paid, template_id, paid_by_import_id, paid_import:card_imports(card, occurred_at)'),
    period
  ).order('name'));
}

export function loadExpenses(period) {
  return run(inPeriod(
    supabase.from('expenses')
      .select('id, category, category_id, merchant, amount, card, transaction_type, created_at, created_by, from_savings, card_import_id'),
    period
  ).order('created_at'));
}

// Pages through results because Supabase caps each response at 1000 rows.
async function selectAll(table, columns, filter = q => q) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const page = await run(filter(supabase.from(table).select(columns)).order('id').range(from, from + pageSize - 1));
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

// ---------- Insights ----------

export function loadExpensesSince(year) {
  return selectAll('expenses',
    'id, year, month, period_start_day, category, category_id, merchant, amount, transaction_type, created_at',
    q => q.gte('year', year).eq('from_savings', false)); // savings purchases never count
}

export function loadFixedCostsSince(year) {
  return selectAll('fixed_costs', 'id, year, month, period_start_day, amount', q => q.gte('year', year));
}

export async function loadPeriodCategoriesFor(periodIds) {
  if (!periodIds.length) return [];
  return run(supabase.from('period_categories')
    .select('period_id, category_id, amount, emptied')
    .in('period_id', periodIds));
}

// Extra carried into every period (only periods from carry_start on have a row).
export function loadAllCarryIn() {
  return run(supabase.from('period_extra_carry').select('period_id, carry_in'));
}

export async function loadCarryStart() {
  const rows = await run(supabase.from('budget_defaults').select('carry_start'));
  return rows.length ? rows[0].carry_start : null;
}

// First period whose overages come out of Extra (migration 011), or null —
// also null before 011 has been run, so the app keeps working without it.
export async function loadOverageStart() {
  try {
    const rows = await run(supabase.from('budget_defaults').select('overage_start'));
    return rows.length ? rows[0].overage_start : null;
  } catch {
    return null;
  }
}

// Every store name ever entered, for suggestions in the expense sheet.
export function loadMerchantHistory() {
  return selectAll('expenses', 'id, merchant, category, category_id, created_at', q => q.not('merchant', 'is', null));
}

// Stores hidden from suggestions, as merchantKey()s (see migration 006).
export async function loadHiddenMerchants() {
  const rows = await run(supabase.from('hidden_merchants').select('merchant_key'));
  return rows.map(r => r.merchant_key);
}

export function hideMerchant(key) {
  return run(supabase.from('hidden_merchants')
    .upsert([{ merchant_key: key }], { onConflict: 'household_id,merchant_key', ignoreDuplicates: true }));
}

export function unhideMerchant(key) {
  return run(supabase.from('hidden_merchants').delete().eq('merchant_key', key));
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

// ---------- Card alerts (migration 008) ----------

// Purchases read from card alert emails, waiting to be reviewed, oldest first.
export function loadPendingImports() {
  return run(supabase.from('card_imports')
    .select('id, card, account, last4, cardholder, cardholder_user_id, merchant, merchant_raw, amount_cents, occurred_at, unreadable')
    .eq('status', 'pending')
    .order('occurred_at'));
}

// Stores learned as bills (see matchBill in merchants.js).
export function loadBillMerchants() {
  return run(supabase.from('bill_merchants').select('merchant_key, template_id, bill_name'));
}

// Marks the bill paid with this period's amount set to what was charged,
// settles the alert and remembers the store (migration 008).
export function payBillFromImport(importId, fixedCostId, amount, merchantKey) {
  return run(supabase.rpc('pay_bill_from_import', {
    p_import_id: importId, p_fixed_cost_id: fixedCostId, p_amount: amount, p_merchant_key: merchantKey,
  }));
}

// 'added' or 'dismissed'. Only moves a pending one, so two phones can't
// both handle it; returns whether this call did.
export async function settleImport(id, status) {
  const rows = await run(supabase.from('card_imports')
    .update({ status }).eq('id', id).eq('status', 'pending').select('id'));
  return rows.length > 0;
}

// ---------- Phone notifications (migration 009) ----------

// Remembers this phone so new card purchases are sent to it. Upsert, so
// re-saving the same phone (e.g. every time the app opens) is harmless.
export function savePushSubscription({ endpoint, p256dh, auth }) {
  return run(supabase.from('push_subscriptions')
    .upsert({ endpoint, p256dh, auth }, { onConflict: 'endpoint' }));
}

export function deletePushSubscription(endpoint) {
  return run(supabase.from('push_subscriptions').delete().eq('endpoint', endpoint));
}

// Asks the notify-purchase function to send a test to this phone only.
export async function sendTestNotification(endpoint) {
  const { data, error } = await supabase.functions.invoke('notify-purchase', {
    body: { test: true, endpoint },
  });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error || error.message);
  }
  return data;
}

// Unticking a bill also drops its "Paid by … alert" note.
export function setFixedPaid(id, isPaid) {
  const fields = isPaid ? { is_paid: true } : { is_paid: false, paid_by_import_id: null };
  return run(supabase.from('fixed_costs').update(fields).eq('id', id));
}

export function saveSettings(args) {
  return run(supabase.rpc('save_settings', args));
}

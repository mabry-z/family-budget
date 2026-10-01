// Store names: grouping for Insights and suggestions for the expense sheet.
// Pure — no DOM, no Supabase. "ALDI", "Aldi" and " aldi " are one store,
// shown with whichever spelling has been used most.
import { signedAmount } from './budget.js';

const tidy = name => String(name ?? '').trim().replace(/\s+/g, ' ');
export const merchantKey = name => tidy(name).toLowerCase();

function mostUsed(spellings) {
  let best = '';
  let bestCount = 0;
  for (const [spelling, count] of spellings) {
    if (count > bestCount) { best = spelling; bestCount = count; }
  }
  return best;
}

// Spending per store, biggest total first. Refunds lower the total but
// aren't trips.
export function groupByMerchant(expenses) {
  const groups = new Map();
  for (const e of expenses) {
    const key = merchantKey(e.merchant);
    let g = groups.get(key);
    if (!g) groups.set(key, g = { spellings: new Map(), total: 0, trips: 0, purchases: 0 });
    const spelling = tidy(e.merchant);
    if (spelling) g.spellings.set(spelling, (g.spellings.get(spelling) ?? 0) + 1);
    g.total += signedAmount(e);
    if (e.transaction_type !== 'refund') {
      g.trips += 1;
      g.purchases += Number(e.amount);
    }
  }
  return [...groups.values()]
    .map(g => ({
      name: mostUsed(g.spellings) || 'Unknown',
      total: g.total,
      trips: g.trips,
      average: g.trips ? Math.round(g.purchases / g.trips) : 0,
    }))
    .sort((a, b) => (b.total - a.total) || (b.trips - a.trips) || a.name.localeCompare(b.name));
}

// The largest purchase (not refund), or null.
export function biggestPurchase(expenses) {
  let best = null;
  for (const e of expenses) {
    if (e.transaction_type === 'refund') continue;
    if (!best || Number(e.amount) > Number(best.amount)) best = e;
  }
  return best;
}

// Every store ever entered:
// key → { name, count, lastUsed (Date), byCategory: Map(categoryId → count) }.
export function merchantIndex(expenses, categoryIdOf) {
  const index = new Map();
  for (const e of expenses) {
    const key = merchantKey(e.merchant);
    if (!key) continue;
    let m = index.get(key);
    if (!m) index.set(key, m = { key, spellings: new Map(), count: 0, lastUsed: null, byCategory: new Map() });
    const spelling = tidy(e.merchant);
    m.spellings.set(spelling, (m.spellings.get(spelling) ?? 0) + 1);
    m.count += 1;
    const used = e.created_at ? new Date(e.created_at) : null;
    if (used && (!m.lastUsed || used > m.lastUsed)) m.lastUsed = used;
    const categoryId = categoryIdOf(e);
    m.byCategory.set(categoryId, (m.byCategory.get(categoryId) ?? 0) + 1);
  }
  for (const m of index.values()) m.name = mostUsed(m.spellings);
  return index;
}

// ---------- Bills paid on a card ----------

const BILL_STOP_WORDS = new Set(['the', 'and', 'bill', 'bills', 'payment', 'pay', 'monthly', 'card', 'inc']);
const words = s => merchantKey(s).split(/[^a-z0-9]+/).filter(Boolean);

// Which of a period's unpaid bills a card purchase could be, or null: the
// bill this store was last linked to (bill_merchants rows) first, then
// every bill whose name starts a word of the store ("TKS Internet" ↔
// "Tkscable") at a similar amount. Several (two Oura bills for one
// "Ouraring" store) → the review sheet asks which. Never by amount alone,
// so a $20 parking charge isn't offered as the $20 Netflix bill. Always
// confirmed by a person.
// → { bills: [bill, …], learned } | null
export function matchBill(merchant, dollars, bills, learned = []) {
  const key = merchantKey(merchant);
  const unpaid = bills.filter(b => !b.is_paid);
  if (!key || !unpaid.length) return null;

  const link = learned.find(l => l.merchant_key === key);
  const linked = link
    ? unpaid.find(b => link.template_id != null && b.template_id === link.template_id)
      ?? unpaid.find(b => merchantKey(b.name) === merchantKey(link.bill_name))
    : null;

  // A name match also needs a similar amount, so a $12 car wash isn't
  // offered as the $390 Car bill.
  const storeWords = words(merchant);
  const near = b => Math.abs(dollars - Number(b.amount)) <= Math.max(5, Number(b.amount) * 0.25);
  const byName = unpaid.filter(b => b !== linked && near(b) && words(b.name).some(w =>
    w.length >= 3 && !BILL_STOP_WORDS.has(w) && storeWords.some(sw => sw.startsWith(w))));

  const fits = linked ? [linked, ...byName] : byName;
  return fits.length ? { bills: fits, learned: !!linked } : null;
}

// A one-off store drops out of suggestions this long after it was used.
export const ONE_OFF_DAYS = 30;

// Suggested unless hidden, or used only once and not in the last 30 days.
export function isSuggested(m, hidden, now = new Date()) {
  if (hidden.has(m.key)) return false;
  if (m.count >= 2) return true;
  return !!m.lastUsed && now - m.lastUsed <= ONE_OFF_DAYS * 24 * 60 * 60 * 1000;
}

// Stores matching what's typed (start of the name or of any word), most used
// in this category first, then most used overall. Nothing until typing starts.
// `hidden` is a Set of keys the household has hidden.
export function suggestMerchants(index, typed, categoryId, hidden = new Set(), limit = 4) {
  const q = merchantKey(typed);
  if (!q) return [];
  const now = new Date();
  const matches = [...index.values()].filter(m =>
    m.key !== q && isSuggested(m, hidden, now)
    && (m.key.startsWith(q) || m.key.split(' ').some(word => word.startsWith(q))));
  return matches
    .sort((a, b) => ((b.byCategory.get(categoryId) ?? 0) - (a.byCategory.get(categoryId) ?? 0))
      || (b.count - a.count) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(m => ({ name: m.name, key: m.key }));
}

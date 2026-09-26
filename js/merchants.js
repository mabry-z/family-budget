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

// Every store ever entered: key → { name, count, byCategory: Map(categoryId → count) }.
export function merchantIndex(expenses, categoryIdOf) {
  const index = new Map();
  for (const e of expenses) {
    const key = merchantKey(e.merchant);
    if (!key) continue;
    let m = index.get(key);
    if (!m) index.set(key, m = { key, spellings: new Map(), count: 0, byCategory: new Map() });
    const spelling = tidy(e.merchant);
    m.spellings.set(spelling, (m.spellings.get(spelling) ?? 0) + 1);
    m.count += 1;
    const categoryId = categoryIdOf(e);
    m.byCategory.set(categoryId, (m.byCategory.get(categoryId) ?? 0) + 1);
  }
  for (const m of index.values()) m.name = mostUsed(m.spellings);
  return index;
}

// Stores matching what's typed (start of the name or of any word), most used
// in this category first, then most used overall. Nothing until typing starts.
export function suggestMerchants(index, typed, categoryId, limit = 4) {
  const q = merchantKey(typed);
  if (!q) return [];
  const matches = [...index.values()].filter(m =>
    m.key !== q && (m.key.startsWith(q) || m.key.split(' ').some(word => word.startsWith(q))));
  return matches
    .sort((a, b) => ((b.byCategory.get(categoryId) ?? 0) - (a.byCategory.get(categoryId) ?? 0))
      || (b.count - a.count) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(m => m.name);
}

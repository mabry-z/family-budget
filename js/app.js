import * as db from './data.js';
import { CARDS } from './config.js';
import {
  periodForDate, shiftPeriod, samePeriod, periodStartISO, periodLabel, buildBudget, cardTotals,
} from './budget.js';
import { showToast, errorMessage } from './ui/dom.js';
import { initOverview, renderOverview } from './ui/overview.js';
import { initBills, renderBills } from './ui/bills.js';
import { renderSummary } from './ui/summary.js';
import { initTrends, renderTrends, invalidateTrends } from './ui/trends.js';
import { initExpenseSheet, openExpenseSheet } from './ui/expense-sheet.js';
import { initSettingsSheet, openSettingsSheet } from './ui/settings-sheet.js';

const state = {
  period: periodForDate(new Date()),
  periodRow: null,       // pay_periods row: { id, starting_amount, start_date, ... }
  categories: [],        // every category, including archived ones and Extra
  periodCategories: [],  // this period's snapshot: [{ id, name, color, sort_order, amount }]
  extraCategory: null,
  fixedCosts: [],
  expenses: [],
  budget: null,
  activeScreen: 'overview',
};

const periodLabelEl = document.getElementById('periodLabel');

function todayPeriod() {
  return periodForDate(new Date());
}

// Old-app rows may only carry the category name; fall back to it, then to Extra.
function categoryIdOf(expense) {
  if (expense.category_id != null) return expense.category_id;
  const name = String(expense.category ?? '').toLowerCase();
  const match = state.categories.find(c => c.name.toLowerCase() === name);
  return match ? match.id : state.extraCategory.id;
}

// ---------- Loading ----------

let loadToken = 0;

async function loadAll() {
  const token = ++loadToken;
  const period = { ...state.period };
  renderPeriodLabel();
  document.body.classList.add('is-loading');
  invalidateTrends();

  try {
    const periodRow = await db.ensurePeriod(period);
    const [categories, periodCats, fixedCosts, expenses] = await Promise.all([
      db.loadCategories(),
      db.loadPeriodCategories(periodRow.id),
      db.loadFixedCosts(period),
      db.loadExpenses(period),
    ]);
    if (token !== loadToken) return; // the user moved to another period meanwhile

    const byId = new Map(categories.map(c => [c.id, c]));
    state.periodRow = periodRow;
    state.categories = categories;
    state.extraCategory = categories.find(c => c.is_remainder);
    state.periodCategories = periodCats
      .filter(pc => byId.has(pc.category_id) && !byId.get(pc.category_id).is_remainder)
      .map(pc => ({ ...byId.get(pc.category_id), amount: pc.amount }))
      .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
    state.fixedCosts = fixedCosts;
    state.expenses = expenses;
    render();
  } catch (err) {
    if (token === loadToken) showToast(`Couldn't load this period: ${errorMessage(err)}`);
  } finally {
    if (token === loadToken) document.body.classList.remove('is-loading');
  }
}

// ---------- Rendering ----------

function renderPeriodLabel() {
  periodLabelEl.textContent = periodLabel(state.period);
  periodLabelEl.classList.toggle('off-current', !samePeriod(state.period, todayPeriod()));
}

function render() {
  state.budget = buildBudget({
    starting: state.periodRow.starting_amount,
    fixedCosts: state.fixedCosts,
    periodCategories: state.periodCategories,
    extraCategory: state.extraCategory,
    expenses: state.expenses,
    categoryIdOf,
  });
  renderOverview(state.budget, state.expenses);
  renderBills(state.fixedCosts);
  renderSummary(state.budget, cardTotals(state.expenses, CARDS));
  if (state.activeScreen === 'trends') showTrends();
}

function showTrends() {
  const charted = state.categories.filter(c => c.is_active && !c.is_remainder);
  renderTrends(charted, categoryIdOf);
}

// ---------- Navigation ----------

function goToPeriod(period) {
  state.period = period;
  loadAll();
}

document.getElementById('prevPeriod').addEventListener('click', () => goToPeriod(shiftPeriod(state.period, -1)));
document.getElementById('nextPeriod').addEventListener('click', () => goToPeriod(shiftPeriod(state.period, 1)));
periodLabelEl.addEventListener('click', () => goToPeriod(todayPeriod()));
periodLabelEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToPeriod(todayPeriod()); }
});

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    state.activeScreen = tab.dataset.screen;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.screen').forEach(s => {
      s.classList.toggle('active', s.id === `screen-${state.activeScreen}`);
    });
    if (state.activeScreen === 'trends' && state.budget) showTrends();
  });
});

// ---------- Screens & sheets ----------

initOverview({
  onEditExpense: expense => openExpenseSheet(expense),
});

initBills({
  onTogglePaid: async (id, isPaid) => {
    const bill = state.fixedCosts.find(f => f.id === id);
    if (!bill) return;
    bill.is_paid = isPaid; // optimistic
    renderBills(state.fixedCosts);
    try {
      await db.setFixedPaid(id, isPaid);
    } catch (err) {
      bill.is_paid = !isPaid;
      renderBills(state.fixedCosts);
      showToast(`Couldn't update ${bill.name}: ${errorMessage(err)}`);
    }
  },
});

initTrends();

initExpenseSheet({
  getCategoryChoices: () => state.budget.cards.map(c => ({ id: c.id, name: c.name })),
  categoryIdOf: expense => state.budget.bucketOf(expense),
  onSave: async ({ id, category_id, ...fields }) => {
    const category = state.categories.find(c => c.id === category_id);
    // Keep the text column filled in too, so the old app on main still reads these rows.
    const row = { ...fields, category_id, category: category.name };
    if (id != null) {
      await db.updateExpense(id, row);
    } else {
      const p = state.period;
      await db.addExpense({ ...row, year: p.year, month: p.month, period_start_day: p.startDay });
    }
    await loadAll();
  },
  onDelete: async id => {
    await db.deleteExpense(id);
    await loadAll();
  },
});

initSettingsSheet({
  getSnapshot: () => {
    const expenseCountByCategory = new Map();
    for (const e of state.expenses) {
      const id = state.budget.bucketOf(e);
      expenseCountByCategory.set(id, (expenseCountByCategory.get(id) ?? 0) + 1);
    }
    const todayStartISO = periodStartISO(todayPeriod());
    return {
      period: { ...state.period },
      isPast: periodStartISO(state.period) < todayStartISO,
      todayStartISO,
      starting: state.periodRow.starting_amount,
      extraName: state.extraCategory.name,
      categories: state.periodCategories,
      fixedCosts: state.fixedCosts,
      expenseCountByCategory,
    };
  },
  onSave: async args => {
    await db.saveSettings(args);
    await loadAll();
  },
});

document.getElementById('openExpense').addEventListener('click', () => {
  if (state.budget) openExpenseSheet();
});
document.getElementById('openSettings').addEventListener('click', () => {
  if (state.budget) openSettingsSheet();
});

loadAll();

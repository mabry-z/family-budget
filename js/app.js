import * as db from './data.js';
import * as auth from './auth.js';
import { CARDS } from './config.js';
import {
  periodForDate, shiftPeriod, samePeriod, periodStartISO, buildBudget, cardTotals, snapshotCategories,
} from './budget.js';
import { merchantIndex, suggestMerchants } from './merchants.js';
import { today, toISO, fromISO, addDays, rangeLabel, expectedPayday } from './paydays.js';
import { showToast, errorMessage } from './ui/dom.js';
import { initOverview, renderOverview } from './ui/overview.js';
import { initBills, renderBills } from './ui/bills.js';
import { renderSummary } from './ui/summary.js';
import { initInsights, renderInsights, invalidateInsights } from './ui/insights.js';
import { initExpenseSheet, openExpenseSheet } from './ui/expense-sheet.js';
import { initSettingsSheet, openSettingsSheet } from './ui/settings-sheet.js';
import { initPaydaySheet, openPaydaySheet } from './ui/payday-sheet.js';
import { initSignIn, showSignIn, showNoHousehold, hideGate } from './ui/sign-in.js';
import { initHousehold, renderHousehold } from './ui/household.js';

// Start asking about the next paycheck this many days before its expected
// date — the bank usually deposits a day or two early.
const PAYDAY_ASK_DAYS_EARLY = 3;
const NOT_YET_KEY = 'cadence.paydayNotYet';

const state = {
  period: null,          // the period being viewed: { year, month, startDay }
  payPeriods: [],        // every pay_periods row, oldest first
  periodRow: null,       // pay_periods row for the viewed period
  carryIn: 0,            // Extra carried into the viewed period
  categories: [],        // every category, including archived ones and Extra
  periodCategories: [],  // this period's snapshot: [{ id, name, color, sort_order, amount, emptied }]
  extraCategory: null,
  fixedCosts: [],
  expenses: [],
  budget: null,
  merchants: new Map(),  // every store entered, for suggestions (see merchants.js)
  activeScreen: 'overview',
};

const periodLabelEl = document.getElementById('periodLabel');

// Old-app rows may only carry the category name; fall back to it, then to Extra.
function categoryIdOf(expense) {
  if (expense.category_id != null) return expense.category_id;
  const name = String(expense.category ?? '').toLowerCase();
  const match = state.categories.find(c => c.name.toLowerCase() === name);
  return match ? match.id : state.extraCategory.id;
}

// ---------- Periods and their real dates ----------

const rowToPeriod = row => ({ year: row.year, month: row.month, startDay: row.start_day });
const rowFor = period => state.payPeriods.find(r => r.start_date === periodStartISO(period));
const startedRows = () => state.payPeriods.filter(r => r.starts_on);

// The latest period whose pay has arrived (confirmed start on or before today).
function currentPeriod() {
  const todayISO = toISO(today());
  const last = startedRows().filter(r => r.starts_on <= todayISO).at(-1);
  return last ? rowToPeriod(last) : periodForDate(today());
}

// Confirmed start, or the expected payday for periods that haven't started.
function startOf(period) {
  const row = rowFor(period);
  return row?.starts_on ? fromISO(row.starts_on) : expectedPayday(period).date;
}

function periodRangeLabel(period) {
  return rangeLabel(startOf(period), addDays(startOf(shiftPeriod(period, 1)), -1));
}

// ---------- Loading ----------

let loadToken = 0;
let lastLoadedAt = 0;

// quiet: background refresh — don't dim the screen.
async function loadAll({ quiet = false } = {}) {
  const token = ++loadToken;
  const period = { ...state.period };
  renderPeriodLabel();
  if (!quiet) document.body.classList.add('is-loading');
  invalidateInsights();

  try {
    const periodRow = await db.ensurePeriod(period);
    const [payPeriods, carryIn, categories, periodCats, fixedCosts, expenses] = await Promise.all([
      db.loadPayPeriods(),
      db.loadCarryIn(periodRow.id),
      db.loadCategories(),
      db.loadPeriodCategories(periodRow.id),
      db.loadFixedCosts(period),
      db.loadExpenses(period),
    ]);
    if (token !== loadToken) return; // the user moved to another period meanwhile

    state.payPeriods = payPeriods;
    state.periodRow = periodRow;
    state.carryIn = carryIn;
    state.categories = categories;
    state.extraCategory = categories.find(c => c.is_remainder);
    state.periodCategories = snapshotCategories(periodCats, new Map(categories.map(c => [c.id, c])));
    state.fixedCosts = fixedCosts;
    state.expenses = expenses;
    lastLoadedAt = Date.now();
    render();
  } catch (err) {
    if (token === loadToken) showToast(`Couldn't load this period: ${errorMessage(err)}`);
  } finally {
    if (token === loadToken) document.body.classList.remove('is-loading');
  }
}

// ---------- Rendering ----------

function renderPeriodLabel() {
  periodLabelEl.textContent = periodRangeLabel(state.period);
  periodLabelEl.classList.toggle('off-current', !samePeriod(state.period, currentPeriod()));
}

function render() {
  renderPeriodLabel();
  state.budget = buildBudget({
    starting: state.periodRow.starting_amount,
    carryIn: state.carryIn,
    fixedCosts: state.fixedCosts,
    periodCategories: state.periodCategories,
    extraCategory: state.extraCategory,
    expenses: state.expenses,
    categoryIdOf,
  });
  renderOverview(state.budget, state.expenses);
  renderBills(state.fixedCosts);
  renderSummary(state.budget, cardTotals(state.expenses, CARDS));
  if (state.activeScreen === 'insights') renderInsights();
}

// Store names for suggestions; refreshed after saves and on return.
async function loadMerchants() {
  try {
    state.merchants = merchantIndex(await db.loadMerchantHistory(), categoryIdOf);
  } catch {
    // Suggestions are a nicety; keep the list we had.
  }
}

// ---------- Payday ----------

function readNotYet() {
  try { return localStorage.getItem(NOT_YET_KEY); } catch { return null; }
}

function writeNotYet(value) {
  try { localStorage.setItem(NOT_YET_KEY, value); } catch { /* private mode: ask again next load */ }
}

// "Not yet" holds for the rest of the day.
const notYetKey = period => `${periodStartISO(period)}@${toISO(today())}`;

// The next paycheck to confirm, if it's due (or nearly due) and not put off today.
function pendingPayday() {
  const last = startedRows().at(-1);
  if (!last) return null;
  const period = shiftPeriod(rowToPeriod(last), 1);
  const expected = expectedPayday(period);
  const now = today();
  const minDate = addDays(fromISO(last.starts_on), 1);
  if (now < addDays(expected.date, -PAYDAY_ASK_DAYS_EARLY) || now < minDate) return null;
  if (readNotYet() === notYetKey(period)) return null;

  const suggested = now < expected.date ? now : expected.date;
  return { period, expected, minDate, maxDate: now, defaultDate: suggested < minDate ? minDate : suggested };
}

function askAboutPayday() {
  const prompt = pendingPayday();
  if (prompt) openPaydaySheet(prompt);
}

// ---------- Refresh on return ----------
// Phones pause the page in the background, so reload whenever the app comes
// back into view — that's when the other person's changes show up.

const REFRESH_MIN_GAP_MS = 5000;

async function refreshOnReturn() {
  if (!state.budget || Date.now() - lastLoadedAt < REFRESH_MIN_GAP_MS) return;
  if (document.querySelector('.sheet-backdrop.open')) return; // don't disturb a sheet in progress
  lastLoadedAt = Date.now();

  // Someone may have started a new period (or the date moved on); follow
  // along if we were looking at the current one.
  const wasCurrent = samePeriod(state.period, currentPeriod());
  try {
    state.payPeriods = await db.loadPayPeriods();
  } catch {
    return; // offline; try again next time
  }
  if (wasCurrent) state.period = currentPeriod();
  await loadAll({ quiet: true });
  loadMerchants();
  askAboutPayday();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshOnReturn();
});
window.addEventListener('focus', refreshOnReturn);
window.addEventListener('pageshow', e => { if (e.persisted) refreshOnReturn(); });

// ---------- Navigation ----------

function goToPeriod(period) {
  state.period = period;
  loadAll();
}

document.getElementById('prevPeriod').addEventListener('click', () => goToPeriod(shiftPeriod(state.period, -1)));
document.getElementById('nextPeriod').addEventListener('click', () => goToPeriod(shiftPeriod(state.period, 1)));
periodLabelEl.addEventListener('click', () => goToPeriod(currentPeriod()));
periodLabelEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToPeriod(currentPeriod()); }
});

// The header shows the tab's name. Insights spans many periods, so it has no period bar.
const SCREEN_TITLES = { overview: 'Cadence', bills: 'Bills', insights: 'Insights', summary: 'Summary' };
const headerEl = document.getElementById('appHeader');
const screenTitleEl = document.getElementById('screenTitle');

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    state.activeScreen = tab.dataset.screen;
    screenTitleEl.textContent = SCREEN_TITLES[state.activeScreen];
    headerEl.classList.toggle('no-period', state.activeScreen === 'insights');
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.screen').forEach(s => {
      s.classList.toggle('active', s.id === `screen-${state.activeScreen}`);
    });
    if (state.activeScreen === 'insights' && state.budget) renderInsights();
  });
});

// ---------- Screens & sheets ----------

initOverview({
  onEditExpense: expense => openExpenseSheet(expense),
  onEmpty: async (categoryIds, emptied) => {
    try {
      await db.setCategoryEmptied(state.periodRow.id, categoryIds, emptied);
      await loadAll();
    } catch (err) {
      showToast(`Couldn't move the money: ${errorMessage(err)}`);
    }
  },
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

initInsights({
  get: () => ({
    payPeriods: state.payPeriods,
    categories: state.categories,
    extraCategory: state.extraCategory,
    currentStartISO: periodStartISO(currentPeriod()),
    categoryIdOf,
    periodLabel: row => periodRangeLabel(rowToPeriod(row)),
  }),
});

initExpenseSheet({
  getCategoryChoices: () => state.budget.cards.map(c => ({ id: c.id, name: c.name })),
  categoryIdOf: expense => state.budget.bucketOf(expense),
  suggestMerchants: (typed, categoryId) => suggestMerchants(state.merchants, typed, categoryId),
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
    loadMerchants();
  },
  onDelete: async id => {
    await db.deleteExpense(id);
    await loadAll();
    loadMerchants();
  },
});

initSettingsSheet({
  getSnapshot: () => {
    const expenseCountByCategory = new Map();
    for (const e of state.expenses) {
      const id = state.budget.bucketOf(e);
      expenseCountByCategory.set(id, (expenseCountByCategory.get(id) ?? 0) + 1);
    }
    const todayStartISO = periodStartISO(currentPeriod());
    return {
      period: { ...state.period },
      label: periodRangeLabel(state.period),
      isPast: periodStartISO(state.period) < todayStartISO,
      todayStartISO,
      startsOn: state.periodRow.starts_on ?? null,
      starting: state.periodRow.starting_amount,
      carryIn: state.carryIn,
      extraName: state.extraCategory.name,
      categories: state.budget.cards.filter(c => !c.isExtra),
      fixedCosts: state.fixedCosts,
      expenseCountByCategory,
    };
  },
  onSave: async (startsOn, args) => {
    const period = { year: args.p_year, month: args.p_month, startDay: args.p_start_day };
    if (startsOn) await db.startPeriod(period, startsOn);
    await db.saveSettings(args);
    await loadAll();
  },
});

initPaydaySheet({
  onStart: async (period, startsOnISO) => {
    await db.startPeriod(period, startsOnISO);
    state.payPeriods = await db.loadPayPeriods();
    state.period = currentPeriod();
    await loadAll();
    setTimeout(askAboutPayday, 400); // another paycheck may be waiting if the app sat unopened
  },
  onNotYet: period => writeNotYet(notYetKey(period)),
});

document.getElementById('openExpense').addEventListener('click', () => {
  if (state.budget) openExpenseSheet();
});
document.getElementById('openSettings').addEventListener('click', () => {
  if (state.budget) openSettingsSheet();
});

initHousehold({
  onChangePassword: async password => {
    await auth.changePassword(password);
    showToast('Password changed.', { ok: true });
  },
  onSignOut: signOut,
});

initSignIn({
  onSignIn: async (email, password) => {
    const session = await auth.signIn(email, password);
    await enterApp(session);
  },
  onSignOut: signOut,
});

// ---------- Signing in and out ----------

async function signOut() {
  try {
    await auth.signOut();
  } catch (err) {
    showToast(`Couldn't sign out: ${errorMessage(err)}`);
  }
}

// However the session ended, start over from a clean page.
auth.onSignedOut(() => window.location.reload());

// ---------- Start ----------

async function enterApp(session) {
  let household = null;
  try {
    household = await db.loadHouseholdInfo();
    if (!household) return showNoHousehold(session.user.email);
  } catch (err) {
    showToast(`Couldn't load your household: ${errorMessage(err)}`);
  }
  renderHousehold(household, session.user.email);
  hideGate();

  try {
    state.payPeriods = await db.loadPayPeriods();
  } catch (err) {
    showToast(`Couldn't load pay periods: ${errorMessage(err)}`);
  }
  state.period = currentPeriod();
  await loadAll();
  loadMerchants();
  askAboutPayday();
}

(async function start() {
  let session = null;
  try {
    session = await auth.getSession();
  } catch (err) {
    showToast(`Couldn't check your sign-in: ${errorMessage(err)}`);
  }
  if (session) await enterApp(session);
  else showSignIn();
})();

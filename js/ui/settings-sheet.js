import { CATEGORY_COLORS } from '../config.js';
import { money, parseWhole, periodLabel } from '../budget.js';
import { errorMessage, showFormError, openSheet, closeSheet, wireSheet } from './dom.js';

const backdrop = document.getElementById('settingsBackdrop');
const form = document.getElementById('settingsForm');
const scopeEl = document.getElementById('settingsScope');
const startingInput = document.getElementById('startingBudget');
const categoryRows = document.getElementById('categoryRows');
const addCategoryBtn = document.getElementById('addCategoryRow');
const extraInput = document.getElementById('extraAmount');
const extraHint = document.getElementById('extraHint');
const fixedLabel = document.getElementById('fixedLabel');
const fixedRows = document.getElementById('fixedCostRows');
const addFixedBtn = document.getElementById('addFixedRow');
const errorEl = document.getElementById('settingsError');
const submitBtn = document.getElementById('settingsSubmit');

const EXTRA_HINT = 'Auto-calculated: starting budget − fixed costs − all other categories';

let ctx;
let snapshot; // what the sheet was opened with; see openSettingsSheet

// A name + amount + ✕ row. `data` lands on row.dataset (ids, colour).
function makeRow({ name = '', amount = '', amountClass, data = {}, lockName = false }) {
  const row = document.createElement('div');
  row.className = 'fixed-row';
  Object.assign(row.dataset, data);
  row.innerHTML = '<input type="text" class="row-name" maxlength="40" placeholder="Name">'
    + `<div class="amount-field"><span>$</span><input type="text" class="${amountClass}" inputmode="numeric" placeholder="0"></div>`
    + '<button type="button" class="remove-btn" aria-label="Remove">✕</button>';
  row.querySelector('.row-name').value = name;
  row.querySelector('.row-name').disabled = lockName;
  row.querySelector(`.${amountClass}`).value = amount;
  row.querySelector('.remove-btn').hidden = lockName;
  return row;
}

function recomputeExtra() {
  const total = selector => [...form.querySelectorAll(selector)]
    .reduce((s, input) => s + (parseWhole(input.value) ?? 0), 0);
  const extra = (parseWhole(startingInput.value) ?? 0) - total('.fixed-amt') - total('.cat-amt');
  const negative = extra < 0;
  extraInput.value = extra.toLocaleString('en-US');
  extraInput.classList.toggle('negative', negative);
  extraHint.classList.toggle('negative', negative);
  extraHint.textContent = negative
    ? `Over-allocated by ${money(-extra)}. Lower a category or fixed cost, or raise the starting budget.`
    : EXTRA_HINT;
}

function nextColor() {
  const used = new Set([...categoryRows.children].map(r => r.dataset.color));
  return CATEGORY_COLORS.find(c => !used.has(c)) ?? CATEGORY_COLORS[categoryRows.children.length % CATEGORY_COLORS.length];
}

// Reads the rows back; skips rows left completely blank. Throws a user-facing message.
function readRows(container, amountClass, label) {
  const rows = [];
  const seen = new Set();
  for (const row of container.children) {
    const name = row.querySelector('.row-name').value.trim();
    const rawAmount = row.querySelector(`.${amountClass}`).value.trim();
    if (!name && !rawAmount && !row.dataset.id) continue;
    const amount = parseWhole(rawAmount);
    if (!name) throw `Every ${label} needs a name.`;
    if (amount === null) throw `${name}: amount must be a whole number of dollars.`;
    if (seen.has(name.toLowerCase())) throw `There are two ${label}s named "${name}".`;
    seen.add(name.toLowerCase());
    rows.push({ row, name, amount });
  }
  return rows;
}

// ctx: { getSnapshot(), onSave(args) }
export function initSettingsSheet(context) {
  ctx = context;
  wireSheet(backdrop);

  startingInput.addEventListener('input', recomputeExtra);
  form.addEventListener('input', e => {
    if (e.target.matches('.cat-amt, .fixed-amt')) recomputeExtra();
  });

  form.addEventListener('click', e => {
    const btn = e.target.closest('.remove-btn');
    if (!btn) return;
    const row = btn.closest('.fixed-row');
    if (row.parentElement === categoryRows && row.dataset.id) {
      const count = snapshot.expenseCountByCategory.get(Number(row.dataset.id)) ?? 0;
      if (count > 0) {
        const name = row.querySelector('.row-name').value.trim() || 'This category';
        showFormError(errorEl, `${name} has ${count} expense${count === 1 ? '' : 's'} this period. Move or delete them first.`);
        return;
      }
    }
    showFormError(errorEl, '');
    row.remove();
    recomputeExtra();
  });

  addCategoryBtn.addEventListener('click', () => {
    categoryRows.append(makeRow({ amountClass: 'cat-amt', data: { color: nextColor() } }));
  });
  addFixedBtn.addEventListener('click', () => {
    fixedRows.append(makeRow({ amountClass: 'fixed-amt' }));
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    let categories, fixed;
    const starting = parseWhole(startingInput.value);
    try {
      if (starting === null) throw 'Starting budget must be a whole number of dollars.';
      categories = readRows(categoryRows, 'cat-amt', 'category');
      fixed = readRows(fixedRows, 'fixed-amt', 'fixed cost');
      const reserved = snapshot.extraName.toLowerCase();
      const clash = categories.find(c => c.name.toLowerCase() === reserved);
      if (clash) throw `"${clash.name}" is reserved for the auto-calculated Extra category.`;
    } catch (message) {
      return showFormError(errorEl, String(message));
    }
    showFormError(errorEl, '');

    const { period } = snapshot;
    submitBtn.disabled = true;
    try {
      await ctx.onSave({
        p_year: period.year,
        p_month: period.month,
        p_start_day: period.startDay,
        p_today_start: snapshot.todayStartISO,
        p_starting: starting,
        p_categories: categories.map(({ row, name, amount }) => ({
          id: row.dataset.id ? Number(row.dataset.id) : null,
          name,
          color: row.dataset.color || null,
          amount,
        })),
        p_fixed: fixed.map(({ row, name, amount }) => ({
          id: row.dataset.id ? Number(row.dataset.id) : null,
          template_id: row.dataset.template ? Number(row.dataset.template) : null,
          name,
          amount,
        })),
      });
      closeSheet(backdrop);
    } catch (err) {
      showFormError(errorEl, errorMessage(err));
    } finally {
      submitBtn.disabled = false;
    }
  });
}

export function openSettingsSheet() {
  // { period, isPast, todayStartISO, starting, extraName, categories: [{id, name, color, amount}],
  //   fixedCosts: [{id, template_id, name, amount}], expenseCountByCategory: Map }
  snapshot = ctx.getSnapshot();
  const { period, isPast } = snapshot;
  const label = periodLabel(period);
  const half = period.startDay === 1 ? '1st–15th' : '16th–end-of-month';

  scopeEl.textContent = isPast
    ? `${label} is a past period. Changes here apply only to it; your defaults and other periods stay the same. Categories can't be added, renamed or removed in a past period.`
    : `Changes apply to ${label} and every period after it. Earlier periods keep their own amounts.`;

  startingInput.value = snapshot.starting;

  categoryRows.replaceChildren(...snapshot.categories.map(c => makeRow({
    name: c.name,
    amount: c.amount,
    amountClass: 'cat-amt',
    data: { id: c.id, color: c.color },
    lockName: isPast,
  })));
  addCategoryBtn.hidden = isPast;

  fixedLabel.textContent = isPast ? 'Fixed costs (this period)' : `Fixed costs (${half} periods)`;
  fixedRows.replaceChildren(...snapshot.fixedCosts.map(f => makeRow({
    name: f.name,
    amount: f.amount,
    amountClass: 'fixed-amt',
    data: f.template_id ? { id: f.id, template: f.template_id } : { id: f.id },
  })));

  showFormError(errorEl, '');
  recomputeExtra();
  openSheet(backdrop);
}

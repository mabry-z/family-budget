import { CARDS } from '../config.js';
import { parseWhole } from '../budget.js';
import { esc, errorMessage, showFormError, openSheet, closeSheet, wireSheet, selectChip } from './dom.js';

const backdrop = document.getElementById('expenseBackdrop');
const form = document.getElementById('expenseForm');
const titleEl = document.getElementById('expenseTitle');
const categoryChips = document.getElementById('categoryChips');
const merchantInput = document.getElementById('merchantInput');
const typeChips = document.getElementById('typeChips');
const amountInput = document.getElementById('amountInput');
const cardChips = document.getElementById('cardChips');
const errorEl = document.getElementById('expenseError');
const submitBtn = document.getElementById('expenseSubmit');
const deleteBtn = document.getElementById('expenseDelete');

let ctx;
let editing = null;

const selectedValue = group => group.querySelector('.chip.selected')?.dataset.value ?? null;

function selectByValue(group, value) {
  const chip = [...group.querySelectorAll('.chip')].find(c => c.dataset.value === String(value));
  selectChip(group, chip ?? group.querySelector('.chip'));
}

// ctx: { getCategoryChoices() → [{id, name}], categoryIdOf(expense),
//        onSave({id?, category_id, merchant, amount, card, transaction_type}), onDelete(id) }
export function initExpenseSheet(context) {
  ctx = context;
  wireSheet(backdrop);

  cardChips.innerHTML = CARDS.map(c =>
    `<button type="button" class="chip card-chip" data-value="${esc(c.value)}">`
    + `<span class="card-badge" style="background:${c.color};">${esc(c.badge)}</span>`
    + `<span class="card-label">${esc(c.label)}</span></button>`
  ).join('');

  for (const group of [categoryChips, typeChips, cardChips]) {
    group.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (chip) selectChip(group, chip);
    });
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const merchant = merchantInput.value.trim();
    const amount = parseWhole(amountInput.value);
    const categoryId = Number(selectedValue(categoryChips));

    if (!merchant) return showFormError(errorEl, 'Enter a merchant.');
    if (!amount) return showFormError(errorEl, 'Amount must be a whole number of dollars, more than 0.');
    showFormError(errorEl, '');

    submitBtn.disabled = true;
    try {
      await ctx.onSave({
        id: editing?.id,
        category_id: categoryId,
        merchant,
        amount,
        card: selectedValue(cardChips),
        transaction_type: selectedValue(typeChips),
      });
      closeSheet(backdrop);
    } catch (err) {
      showFormError(errorEl, `Couldn't save: ${errorMessage(err)}`);
    } finally {
      submitBtn.disabled = false;
    }
  });

  // Two taps instead of confirm(), which some browsers block silently.
  deleteBtn.addEventListener('click', async () => {
    if (!editing) return;
    if (!deleteBtn.dataset.armed) {
      deleteBtn.dataset.armed = 'true';
      deleteBtn.textContent = `Tap again to delete ${editing.merchant || 'this expense'}`;
      return;
    }
    deleteBtn.disabled = true;
    try {
      await ctx.onDelete(editing.id);
      closeSheet(backdrop);
    } catch (err) {
      showFormError(errorEl, `Couldn't delete: ${errorMessage(err)}`);
    } finally {
      deleteBtn.disabled = false;
    }
  });
}

// Pass an expense to edit it; nothing to add a new one.
export function openExpenseSheet(expense = null) {
  editing = expense;
  const choices = ctx.getCategoryChoices();

  categoryChips.innerHTML = choices.map(c =>
    `<button type="button" class="chip" data-value="${c.id}">${esc(c.name)}</button>`
  ).join('');

  if (expense) {
    const catId = ctx.categoryIdOf(expense);
    selectByValue(categoryChips, choices.some(c => c.id === catId) ? catId : choices.at(-1).id);
    merchantInput.value = expense.merchant || '';
    selectByValue(typeChips, expense.transaction_type || 'expense');
    amountInput.value = expense.amount;
    selectByValue(cardChips, CARDS.some(c => c.value === expense.card) ? expense.card : 'Other');
  } else {
    selectChip(categoryChips, categoryChips.querySelector('.chip'));
    merchantInput.value = '';
    selectByValue(typeChips, 'expense');
    amountInput.value = '';
    selectByValue(cardChips, CARDS[0].value);
  }

  titleEl.textContent = expense ? 'Edit expense' : 'Add expense';
  submitBtn.textContent = expense ? 'Save changes' : 'Add expense';
  deleteBtn.hidden = !expense;
  deleteBtn.textContent = 'Delete expense';
  delete deleteBtn.dataset.armed;
  showFormError(errorEl, '');
  openSheet(backdrop);
}

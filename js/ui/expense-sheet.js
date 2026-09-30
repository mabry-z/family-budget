import { CARDS } from '../config.js';
import { parseWhole, money } from '../budget.js';
import { esc, errorMessage, showFormError, openSheet, closeSheet, wireSheet, selectChip } from './dom.js';
import { badgeHtml, cardInfo, whenLabel, importDollars } from './imports.js';

const backdrop = document.getElementById('expenseBackdrop');
const form = document.getElementById('expenseForm');
const titleEl = document.getElementById('expenseTitle');
const categoryChips = document.getElementById('categoryChips');
const merchantInput = document.getElementById('merchantInput');
const suggestEl = document.getElementById('merchantSuggest');
const typeChips = document.getElementById('typeChips');
const amountInput = document.getElementById('amountInput');
const cardChips = document.getElementById('cardChips');
const errorEl = document.getElementById('expenseError');
const submitBtn = document.getElementById('expenseSubmit');
const deleteBtn = document.getElementById('expenseDelete');
const paidFromChips = document.getElementById('paidFromChips');
const paidFromHint = document.getElementById('paidFromHint');
const categoryField = document.getElementById('categoryField');
const categoryHint = document.getElementById('categoryHint');
const importNote = document.getElementById('importNote');
const dismissBtn = document.getElementById('importDismiss');
const billMatchEl = document.getElementById('billMatch');
const orPurchaseEl = document.getElementById('orPurchase');

let ctx;
let editing = null;
let importing = null; // a card_imports row being reviewed (see imports.js)

const selectedValue = group => group.querySelector('.chip.selected')?.dataset.value ?? null;

function selectByValue(group, value) {
  const chip = [...group.querySelectorAll('.chip')].find(c => c.dataset.value === String(value));
  selectChip(group, chip ?? group.querySelector('.chip'));
}

// Stores entered before, matching what's typed. Tap the name to fill it in,
// or the ✕ end to hide that store from suggestions.
function renderSuggestions() {
  const stores = ctx.suggestMerchants(merchantInput.value, Number(selectedValue(categoryChips)));
  suggestEl.innerHTML = stores.map(s =>
    `<span class="chip suggest-chip">`
    + `<button type="button" class="suggest-name" data-merchant="${esc(s.name)}">${esc(s.name)}</button>`
    + `<button type="button" class="suggest-hide" data-hide="${esc(s.key)}" aria-label="Stop suggesting ${esc(s.name)}">✕</button>`
    + `</span>`).join('');
  suggestEl.hidden = !stores.length;
}

const fromSavings = () => selectedValue(paidFromChips) === 'savings';

// Savings purchases don't count toward a category, so the choice is dimmed.
function updatePaidFrom() {
  const savings = fromSavings();
  categoryField.classList.toggle('muted', savings);
  paidFromHint.hidden = !savings;
  if (importing) submitBtn.textContent = savings ? 'Add as savings purchase' : 'Add to budget';
}

// "Chase Sapphire Reserve Visa" → "Sapphire Reserve".
function shortAccount(account, cardLabel) {
  return String(account || '')
    .replace(new RegExp('^' + cardLabel + '\\s+', 'i'), '')
    .replace(/\s+(visa|mastercard|card|credit card)$/i, '')
    .trim();
}

// The box at the top of the review sheet: who, which card, when, and what
// the bank said.
function importNoteHtml(imp) {
  const label = cardInfo(imp.card).label;
  if (imp.unreadable) {
    return `${badgeHtml(imp.card)}<div>This ${esc(label)} alert from ${esc(whenLabel(imp.occurred_at, { withDay: true }))} couldn’t be read. `
      + `Find it in Gmail’s <b>Needs review</b> folder and fill in the details here.</div>`;
  }
  const color = ctx.authorColorOf(imp.cardholder_user_id);
  const dot = color ? `<span class="author-dot" style="background:${esc(color)};"></span>` : '';
  const who = imp.cardholder ? `${dot}<span class="note-who">${esc(imp.cardholder)}</span> · ` : '';
  const account = shortAccount(imp.account, label);
  const cents = (imp.amount_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${badgeHtml(imp.card)}<div>${who}${account ? `${esc(account)} · ` : ''}${esc(whenLabel(imp.occurred_at, { withDay: true }))}`
    + `<br><b>$${cents}</b> · ${esc(imp.merchant)}</div>`;
}

// "Is this your TKS Internet bill?" — shown when a card purchase looks like
// one of the period's unpaid bills (imp.bill, see matchBill in merchants.js).
// Paying it sets that period's bill to what was charged, rounded.
function billMatchHtml(imp) {
  const { bill, learned } = imp.bill;
  const billAmount = Math.round(Number(bill.amount));
  const dollars = importDollars(imp);
  const cents = (imp.amount_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const label = cardInfo(imp.card).label;
  const detail = dollars === billAmount
    ? `${money(billAmount)} in Bills · not marked paid yet`
    : `${money(billAmount)} in Bills. ${esc(label)} charged $${cents}, so it’ll change to ${money(dollars)}.`;
  return `<div class="bill-match-head"><div class="check">✓</div>`
    + `<div class="bill-match-text"><b>Is this your ${esc(bill.name)} bill?</b><br>${detail}</div></div>`
    + `<button type="button" class="save-btn" data-pay-bill>Mark ${esc(bill.name)} paid</button>`
    + (learned ? '' : `<div class="hint">Cadence will recognize ${esc(imp.merchant)} as this bill from now on.</div>`);
}

// ctx: { getCategoryChoices() → [{id, name}], categoryIdOf(expense),
//        suggestMerchants(typed, categoryId) → [{name, key}], onHideMerchant(key),
//        suggestCategory(merchant) → categoryId | null, authorColorOf(userId),
//        onSave({id?, importId?, category_id, merchant, amount, card, transaction_type, from_savings}),
//        onDelete(id), onDismissImport(importId), onPayBill(imp, dollars) }
export function initExpenseSheet(context) {
  ctx = context;
  wireSheet(backdrop);

  merchantInput.addEventListener('input', renderSuggestions);
  suggestEl.addEventListener('click', async e => {
    const hide = e.target.closest('[data-hide]');
    if (hide) {
      hide.closest('.chip').remove(); // straight away; the list redraws once it's saved
      await ctx.onHideMerchant(hide.dataset.hide);
      renderSuggestions();
      return;
    }
    const chip = e.target.closest('[data-merchant]');
    if (!chip) return;
    merchantInput.value = chip.dataset.merchant;
    renderSuggestions();
  });

  cardChips.innerHTML = CARDS.map(c =>
    `<button type="button" class="chip card-chip" data-value="${esc(c.value)}">`
    + `<span class="card-badge" style="background:${c.color};">${esc(c.badge)}</span>`
    + `<span class="card-label">${esc(c.label)}</span></button>`
  ).join('');

  for (const group of [categoryChips, typeChips, cardChips, paidFromChips]) {
    group.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (chip) selectChip(group, chip);
    });
  }
  // After the selection above: the category changes which stores come first.
  categoryChips.addEventListener('click', () => renderSuggestions());
  paidFromChips.addEventListener('click', updatePaidFrom);

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
        importId: importing?.id,
        category_id: categoryId,
        merchant,
        amount,
        card: selectedValue(cardChips),
        transaction_type: selectedValue(typeChips),
        from_savings: fromSavings(),
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

  billMatchEl.addEventListener('click', async e => {
    const button = e.target.closest('[data-pay-bill]');
    if (!button || !importing?.bill) return;
    button.disabled = true;
    try {
      await ctx.onPayBill(importing, importDollars(importing));
      closeSheet(backdrop);
    } catch (err) {
      showFormError(errorEl, `Couldn't mark it paid: ${errorMessage(err)}`);
    } finally {
      button.disabled = false;
    }
  });

  dismissBtn.addEventListener('click', async () => {
    if (!importing) return;
    if (!dismissBtn.dataset.armed) {
      dismissBtn.dataset.armed = 'true';
      dismissBtn.textContent = 'Tap again to ignore it';
      return;
    }
    dismissBtn.disabled = true;
    try {
      await ctx.onDismissImport(importing.id);
      closeSheet(backdrop);
    } catch (err) {
      showFormError(errorEl, `Couldn't ignore: ${errorMessage(err)}`);
    } finally {
      dismissBtn.disabled = false;
    }
  });
}

// Pass an expense to edit it; nothing to add a new one; or a card_imports
// row (second argument) to review a purchase from a card alert.
export function openExpenseSheet(expense = null, imp = null) {
  editing = expense;
  importing = expense ? null : imp;
  const choices = ctx.getCategoryChoices();

  categoryChips.innerHTML = choices.map(c =>
    `<button type="button" class="chip" data-value="${c.id}">${esc(c.name)}</button>`
  ).join('');

  if (expense) {
    const catId = ctx.categoryIdOf(expense);
    selectByValue(categoryChips, choices.some(c => c.id === catId) ? catId : choices[0].id); // Extra
    merchantInput.value = expense.merchant || '';
    selectByValue(typeChips, expense.transaction_type || 'expense');
    amountInput.value = expense.amount;
    selectByValue(cardChips, CARDS.some(c => c.value === expense.card) ? expense.card : 'Other');
  } else if (importing) {
    const suggested = importing.unreadable ? null : ctx.suggestCategory(importing.merchant);
    const pick = choices.some(c => c.id === suggested) ? suggested : choices[0].id; // Extra
    selectByValue(categoryChips, pick);
    merchantInput.value = importing.unreadable ? '' : importing.merchant;
    selectByValue(typeChips, 'expense');
    amountInput.value = importing.unreadable ? '' : importDollars(importing);
    selectByValue(cardChips, CARDS.some(c => c.value === importing.card) ? importing.card : 'Other');
  } else {
    selectChip(categoryChips, categoryChips.querySelector('.chip'));
    merchantInput.value = '';
    selectByValue(typeChips, 'expense');
    amountInput.value = '';
    selectByValue(cardChips, CARDS[0].value);
  }
  selectByValue(paidFromChips, expense?.from_savings ? 'savings' : 'budget');

  importNote.hidden = !importing;
  importNote.innerHTML = importing ? importNoteHtml(importing) : '';
  const bill = importing?.bill;
  billMatchEl.hidden = orPurchaseEl.hidden = !bill;
  billMatchEl.innerHTML = bill ? billMatchHtml(importing) : '';
  categoryHint.hidden = !importing || importing.unreadable;
  if (importing && !importing.unreadable) {
    const suggested = ctx.suggestCategory(importing.merchant);
    const name = choices.find(c => c.id === suggested)?.name;
    categoryHint.textContent = name
      ? `Suggested: ${importing.merchant} went to ${name} last time.`
      : 'New store, so nothing to suggest yet. Next time it’ll remember.';
  }

  titleEl.textContent = expense ? 'Edit expense'
    : importing ? `New ${cardInfo(importing.card).label} purchase` : 'Add expense';
  submitBtn.textContent = expense ? 'Save changes' : importing ? 'Add to budget' : 'Add expense';
  deleteBtn.hidden = !expense;
  deleteBtn.textContent = 'Delete expense';
  delete deleteBtn.dataset.armed;
  dismissBtn.hidden = !importing;
  dismissBtn.textContent = 'Ignore';
  delete dismissBtn.dataset.armed;
  updatePaidFrom();
  showFormError(errorEl, '');
  renderSuggestions();
  openSheet(backdrop);
}

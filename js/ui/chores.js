// Chores tab (parents): waiting for review, each kid's money, chores to do
// and every chore. Plus the add/edit chore, send back and kid money sheets.
// See docs/chores-plan.md. Kids get js/ui/kid.js instead.
import * as db from '../data.js';
import { KID_COLORS } from '../config.js';
import { today, toISO } from '../paydays.js';
import {
  WEEKDAYS, WEEKDAY_ORDER, repeatLabel, payLabel, parseCents, cash, cashInput, dueNote, goalProgress, ledgerLabel,
} from '../chores.js';
import { esc, errorMessage, showToast, showFormError, openSheet, closeSheet, wireSheet, selectChip } from './dom.js';

const bodyEl = document.getElementById('choresBody');
const badgeEl = document.getElementById('choresBadge');

const choreBackdrop = document.getElementById('choreBackdrop');
const choreForm = document.getElementById('choreForm');
const choreTitleEl = document.getElementById('choreTitle');
const choreName = document.getElementById('choreName');
const choreKidChips = document.getElementById('choreKidChips');
const choreKidHint = document.getElementById('choreKidHint');
const ANYONE = 'anyone';
const choreAmount = document.getElementById('choreAmount');
const repeatChips = document.getElementById('choreRepeatChips');
const weekdayRow = document.getElementById('choreWeekdays');
const repeatHint = document.getElementById('choreRepeatHint');
const choreError = document.getElementById('choreError');
const choreSubmit = document.getElementById('choreSubmit');
const choreDelete = document.getElementById('choreDelete');

const sendBackBackdrop = document.getElementById('sendBackBackdrop');
const sendBackForm = document.getElementById('sendBackForm');
const sendBackWhat = document.getElementById('sendBackWhat');
const sendBackNote = document.getElementById('sendBackNote');
const sendBackError = document.getElementById('sendBackError');
const sendBackSubmit = document.getElementById('sendBackSubmit');

const moneyBackdrop = document.getElementById('kidMoneyBackdrop');
const moneyForm = document.getElementById('kidMoneyForm');
const moneyTitle = document.getElementById('kidMoneyTitle');
const moneyHead = document.getElementById('kidMoneyHead');
const moneyKindChips = document.getElementById('moneyKindChips');
const moneyAmount = document.getElementById('moneyAmount');
const moneyAmountLabel = document.getElementById('moneyAmountLabel');
const moneyHint = document.getElementById('moneyHint');
const moneyNote = document.getElementById('moneyNote');
const moneyError = document.getElementById('moneyError');
const moneySubmit = document.getElementById('moneySubmit');
const historyEl = document.getElementById('kidHistory');

const data = {
  loaded: false,
  kids: [],            // [{ user_id, display_name, color }]
  chores: [],
  tasks: [],
  balances: new Map(), // kid_id → dollars
  goals: new Map(),    // kid_id → { name, target }
};

let editing = null;     // chore being edited, or null when adding
let sendingBack = null; // task being sent back
let moneyKid = null;    // kid whose money sheet is open
let highlightTaskId = null;

const todayISO = () => toISO(today());
const kidById = id => data.kids.find(k => k.user_id === id);
const kidDot = kid => `<span class="kid-dot" style="background:${kid?.color ?? 'var(--ink-faint)'}"></span>`;
// A chore with no kid is for "Anyone" until a kid claims it.
const kidName = id => (id == null ? 'Anyone' : esc(kidById(id)?.display_name ?? 'Kid'));

// Two taps for anything that moves money by accident: the first arms the
// button for 4 seconds ("Tap again to …").
function armed(btn, armedLabel) {
  if (btn.dataset.armed === '1') return true;
  const label = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = armedLabel;
  btn.classList.add('armed');
  setTimeout(() => {
    if (!btn.isConnected) return;
    btn.dataset.armed = '';
    btn.textContent = label;
    btn.classList.remove('armed');
  }, 4000);
  return false;
}

// ---------- Loading ----------

export async function loadChores({ quiet = false } = {}) {
  try {
    await db.ensureChoreTasks(todayISO());
    const [kids, chores, tasks, balances, goals] = await Promise.all([
      db.loadKids(), db.loadChores(), db.loadChoreTasks(), db.loadBalances(), db.loadGoals(),
    ]);
    data.kids = kids.map((k, i) => ({ ...k, color: KID_COLORS[i % KID_COLORS.length] }));
    Object.assign(data, { chores, tasks, balances, goals, loaded: true });
  } catch (err) {
    // Before migration 013 there's nothing to show; say so only when asked.
    if (!quiet) showToast(`Couldn't load chores: ${errorMessage(err)}`);
  }
  renderChores();
}

export const choresReady = () => data.loaded;

// ---------- The screen ----------

function waitingCard(waiting) {
  if (!waiting.length) return '';
  return `<div class="review-card chores-waiting">
    <div class="review-head"><div class="review-title">Waiting for you</div><span class="count-pill">${waiting.length}</span></div>
    ${waiting.map(t => `
      <div class="wait-row${t.id === highlightTaskId ? ' flash' : ''}" data-task="${t.id}">
        <div class="wait-text">
          <div class="wait-title">${esc(t.chore?.title ?? 'Chore')}</div>
          <div class="wait-meta">${kidDot(kidById(t.kid_id))}${kidName(t.kid_id)} · ${esc(doneWhen(t))}</div>
        </div>
        <div class="wait-amt">${payLabel(t.amount)}</div>
        <div class="wait-actions">
          <button type="button" class="row-btn" data-action="send-back">Send back</button>
          <button type="button" class="row-btn approve" data-action="approve">Approve</button>
        </div>
      </div>`).join('')}
  </div>`;
}

function doneWhen(t) {
  if (!t.done_at) return 'done';
  const d = new Date(t.done_at);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return toISO(d) === todayISO() ? `done ${time}` : `done ${WEEKDAYS[d.getDay()]} ${time}`;
}

function kidCards() {
  if (!data.kids.length) {
    return '<div class="summary-card"><div class="empty">No kids in the household yet. Add their accounts first (see docs/chores-plan.md).</div></div>';
  }
  return `<div class="kid-cards">${data.kids.map(kid => {
    const balance = data.balances.get(kid.user_id) ?? 0;
    const goal = data.goals.get(kid.user_id);
    const prog = goalProgress(goal, balance);
    return `<button type="button" class="kid-card" data-kid="${kid.user_id}">
      <div class="kid-card-name">${kidDot(kid)}${esc(kid.display_name)}</div>
      <div class="kid-card-balance">${cash(balance)}</div>
      ${goal ? `<div class="kid-card-goal">${esc(goal.name)} · ${prog.reached ? 'reached!' : `${cash(prog.left)} to go`}</div>
        <div class="bar-track mini"><div class="bar-fill fill-ok" style="width:${prog.pct}%"></div></div>`
        : '<div class="kid-card-goal">No goal yet</div>'}
      <div class="kid-card-link">Pay out or bonus ›</div>
    </button>`;
  }).join('')}</div>`;
}

function todoCard(todo) {
  const rows = todo.map(t => {
    const note = t.status === 'sent_back'
      ? `<div class="todo-note">Sent back${t.note ? `: “${esc(t.note)}”` : ''}</div>` : '';
    const due = dueNote(t, todayISO());
    return `<div class="todo-row" data-task="${t.id}" data-chore="${t.chore_id}">
      <button type="button" class="check" data-action="done-for-kid" aria-label="Mark ${esc(t.chore?.title)} done for ${kidName(t.kid_id)}"></button>
      <div class="todo-text">
        <div class="todo-title">${esc(t.chore?.title ?? 'Chore')}</div>
        <div class="todo-meta">${kidDot(kidById(t.kid_id))}${kidName(t.kid_id)}${due ? ` · ${due}` : ''}</div>
        ${note}
      </div>
      <div class="todo-amt">${payLabel(t.amount)}</div>
    </div>`;
  }).join('');
  return `<div class="summary-card chores-card">
    <h3>To do</h3>
    ${rows || '<div class="empty">Nothing left to do today.</div>'}
    ${todo.length ? '<div class="insight-note">Tap the circle to mark one done for them — it’s approved straight away.</div>' : ''}
  </div>`;
}

function allChoresCard() {
  const rows = [...data.chores]
    .sort((a, b) => (kidById(a.kid_id)?.display_name ?? '').localeCompare(kidById(b.kid_id)?.display_name ?? '')
      || a.title.localeCompare(b.title))
    .map(c => `<button type="button" class="chore-row" data-chore="${c.id}">
      <div class="todo-text">
        <div class="todo-title">${esc(c.title)}</div>
        <div class="todo-meta">${kidDot(kidById(c.kid_id))}${kidName(c.kid_id)} · ${esc(repeatLabel(c))}</div>
      </div>
      <div class="todo-amt">${payLabel(c.amount)}</div>
      <span class="go">›</span>
    </button>`).join('');
  return `<div class="summary-card chores-card">
    <h3>All chores</h3>
    ${rows || '<div class="empty">No chores yet.</div>'}
    <button type="button" class="add-row-btn chores-add" data-action="add">+ Add chore</button>
  </div>`;
}

export function renderChores() {
  const waiting = data.tasks.filter(t => t.status === 'done');
  badgeEl.textContent = waiting.length;
  badgeEl.hidden = !waiting.length;
  if (!data.loaded) {
    bodyEl.innerHTML = '<div class="summary-card"><div class="empty">Loading chores…</div></div>';
    return;
  }
  const todo = data.tasks
    .filter(t => t.status === 'open' || t.status === 'sent_back')
    .sort((a, b) => (a.status === 'sent_back' ? 0 : 1) - (b.status === 'sent_back' ? 0 : 1)
      || (kidById(a.kid_id)?.display_name ?? '').localeCompare(kidById(b.kid_id)?.display_name ?? '')
      || a.due_on.localeCompare(b.due_on));
  bodyEl.innerHTML = waitingCard(waiting) + kidCards() + todoCard(todo) + allChoresCard();
  if (moneyKid && moneyBackdrop.classList.contains('open')) renderMoneyHead();
}

// A tapped notification: show the chore that's waiting.
export function showTask(taskId) {
  highlightTaskId = Number(taskId) || null;
  renderChores();
  const row = highlightTaskId && bodyEl.querySelector(`[data-task="${highlightTaskId}"]`);
  if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => { highlightTaskId = null; }, 3000);
}

// ---------- Add / edit chore ----------

function renderKidChips(selectedId) {
  choreKidChips.innerHTML = data.kids.map(k =>
    `<button type="button" class="chip${k.user_id === selectedId ? ' selected' : ''}" data-value="${k.user_id}">${esc(k.display_name)}</button>`).join('')
    + (data.kids.length > 1
      ? `<button type="button" class="chip${selectedId === ANYONE ? ' selected' : ''}" data-value="${ANYONE}">Anyone</button>` : '');
  choreKidHint.hidden = selectedId !== ANYONE;
}

function renderWeekdays(selected) {
  weekdayRow.innerHTML = WEEKDAY_ORDER.map(d =>
    `<button type="button" class="chip day-chip${selected.includes(d) ? ' selected' : ''}" data-day="${d}">${WEEKDAYS[d]}</button>`).join('');
}

function selectedRepeat() {
  return repeatChips.querySelector('.chip.selected')?.dataset.value ?? 'once';
}

function selectedDays() {
  return [...weekdayRow.querySelectorAll('.day-chip.selected')].map(c => Number(c.dataset.day));
}

function updateRepeatHint() {
  const repeat = selectedRepeat();
  weekdayRow.hidden = repeat !== 'weekly';
  const days = selectedDays();
  repeatHint.textContent = {
    once: 'Stays on their list until it’s done.',
    daily: 'A fresh one every day. A missed day just doesn’t pay.',
    weekly: days.length
      ? 'Due on the days picked. A missed day just doesn’t pay.'
      : 'No day picked: once a week, any day by Sunday.',
  }[repeat];
}

export function openChoreSheet(chore = null) {
  if (!data.kids.length) {
    showToast('Add the kids’ accounts first (see docs/chores-plan.md).');
    return;
  }
  editing = chore;
  choreTitleEl.textContent = chore ? 'Edit chore' : 'Add chore';
  choreSubmit.textContent = chore ? 'Save chore' : 'Add chore';
  choreDelete.hidden = !chore;
  choreDelete.textContent = 'Delete chore';
  choreDelete.dataset.armed = '';
  choreName.value = chore?.title ?? '';
  choreAmount.value = chore ? String(chore.amount) : '';
  renderKidChips(chore ? (chore.kid_id ?? ANYONE) : (data.kids.length === 1 ? data.kids[0].user_id : null));
  selectChip(repeatChips, repeatChips.querySelector(`[data-value="${chore?.repeat ?? 'once'}"]`));
  renderWeekdays(chore?.weekdays ?? []);
  updateRepeatHint();
  showFormError(choreError, '');
  openSheet(choreBackdrop);
}

async function submitChore(e) {
  e.preventDefault();
  const title = choreName.value.trim();
  const picked = choreKidChips.querySelector('.chip.selected')?.dataset.value;
  const kidId = picked === ANYONE ? null : picked;
  const amount = parseCents(choreAmount.value);
  if (!title) return showFormError(choreError, 'Give the chore a name.');
  if (!picked) return showFormError(choreError, 'Pick who it’s for.');
  if (amount == null) return showFormError(choreError, 'Enter what it pays, like 2 or 0.50 ($0 is fine).');
  if (amount > 1000) return showFormError(choreError, 'Keep it to $1,000 or less.');
  showFormError(choreError, '');
  choreSubmit.disabled = true;
  try {
    await db.saveChore({
      id: editing?.id ?? null, kidId, title, amount, repeat: selectedRepeat(), weekdays: selectedDays(),
    }, todayISO());
    closeSheet(choreBackdrop);
    await loadChores();
    showToast(editing ? 'Chore saved.' : kidId ? `Added for ${kidName(kidId)}.` : 'Added for anyone to grab.', { ok: true });
  } catch (err) {
    showFormError(choreError, errorMessage(err));
  } finally {
    choreSubmit.disabled = false;
  }
}

async function deleteEditing() {
  if (!editing || !armed(choreDelete, 'Tap again to delete')) return;
  choreDelete.disabled = true;
  try {
    await db.deleteChore(editing.id);
    closeSheet(choreBackdrop);
    await loadChores();
    showToast('Chore deleted. Its history and money stay.', { ok: true });
  } catch (err) {
    showFormError(choreError, errorMessage(err));
  } finally {
    choreDelete.disabled = false;
  }
}

// ---------- Review ----------

async function approve(task, btn) {
  btn.disabled = true;
  try {
    await db.reviewChore(task.id, true);
    showToast(`Approved: ${payLabel(task.amount)} to ${kidName(task.kid_id)}.`, { ok: true });
  } catch (err) {
    showToast(errorMessage(err), { ok: /already reviewed/i.test(errorMessage(err)) });
  }
  await loadChores();
}

function openSendBack(task) {
  sendingBack = task;
  sendBackWhat.innerHTML = `<strong>${esc(task.chore?.title ?? 'Chore')}</strong><br>${kidName(task.kid_id)} will see it on their list again.`;
  sendBackNote.value = '';
  showFormError(sendBackError, '');
  openSheet(sendBackBackdrop);
}

async function submitSendBack(e) {
  e.preventDefault();
  if (!sendingBack) return;
  sendBackSubmit.disabled = true;
  try {
    await db.reviewChore(sendingBack.id, false, sendBackNote.value.trim() || null);
    closeSheet(sendBackBackdrop);
    showToast(`Sent back to ${kidName(sendingBack.kid_id)}.`, { ok: true });
    await loadChores();
  } catch (err) {
    showFormError(sendBackError, errorMessage(err));
  } finally {
    sendBackSubmit.disabled = false;
  }
}

// An "Anyone" chore: ask which kid did it, right in the row.
function pickKidFor(task, btn) {
  const row = btn.closest('.todo-row');
  if (row.querySelector('.pick-kid')) return;
  const picker = document.createElement('div');
  picker.className = 'pick-kid';
  picker.innerHTML = `<span>Who did it?</span>${data.kids.map(k =>
    `<button type="button" class="row-btn" data-action="done-as" data-kid="${k.user_id}">${esc(k.display_name)}</button>`).join('')}`;
  row.querySelector('.todo-text').append(picker);
  setTimeout(() => picker.remove(), 8000);
}

async function doneAs(task, kidId, btn) {
  btn.disabled = true;
  try {
    await db.markChoreDone(task.id, kidId);
    showToast(`Done for ${kidName(kidId)}: ${payLabel(task.amount)} added.`, { ok: true });
  } catch (err) {
    showToast(errorMessage(err));
  }
  await loadChores();
}

async function doneForKid(task, btn) {
  if (task.kid_id == null) return pickKidFor(task, btn);
  if (!armed(btn, '')) {
    btn.closest('.todo-row')?.classList.add('arming');
    showToast(`Tap again to mark it done for ${kidName(task.kid_id)} (approved, ${payLabel(task.amount)}).`, { ok: true });
    setTimeout(() => btn.closest('.todo-row')?.classList.remove('arming'), 4000);
    return;
  }
  btn.disabled = true;
  try {
    await db.markChoreDone(task.id);
    showToast(`Done for ${kidName(task.kid_id)}: ${payLabel(task.amount)} added.`, { ok: true });
  } catch (err) {
    showToast(errorMessage(err));
  }
  await loadChores();
}

// ---------- A kid's money ----------

const moneyKind = () => moneyKindChips.querySelector('.chip.selected')?.dataset.value ?? 'payout';

function renderMoneyHead() {
  const balance = data.balances.get(moneyKid.user_id) ?? 0;
  const goal = data.goals.get(moneyKid.user_id);
  const prog = goalProgress(goal, balance);
  moneyHead.innerHTML = `<div class="left-label">Balance</div>
    <div class="left-amount">${cash(balance)}</div>
    ${goal ? `<div class="kid-card-goal">Saving for ${esc(goal.name)} (${cash(goal.target)}) · ${prog.reached ? 'reached!' : `${cash(prog.left)} to go`}</div>
      <div class="bar-track"><div class="bar-fill fill-ok" style="width:${prog.pct}%"></div></div>` : ''}`;
}

function updateMoneyForm({ resetAmount = false } = {}) {
  const kind = moneyKind();
  const balance = data.balances.get(moneyKid.user_id) ?? 0;
  moneySubmit.textContent = kind === 'payout' ? 'Pay out' : 'Add bonus';
  moneyAmountLabel.textContent = kind === 'payout' ? 'Amount paid' : 'Bonus amount';
  moneyNote.placeholder = kind === 'payout' ? 'e.g. Cash, or Lego castle' : 'e.g. Great report card';
  moneyHint.textContent = kind === 'payout'
    ? `Takes it off ${moneyKid.display_name}’s balance (up to ${cash(balance)}). Doesn’t touch the budget.`
    : `Adds to ${moneyKid.display_name}’s balance. They get a notification.`;
  if (resetAmount) moneyAmount.value = kind === 'payout' && balance > 0 ? cashInput(balance) : '';
}

async function renderHistory() {
  historyEl.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const entries = await db.loadLedger(moneyKid.user_id);
    historyEl.innerHTML = entries.length ? entries.map(e => `
      <div class="ledger-row">
        <div class="ledger-text"><div>${esc(ledgerLabel(e))}</div><div class="todo-meta">${esc(shortWhen(e.created_at))}</div></div>
        <div class="ledger-amt${e.amount > 0 ? ' plus' : ''}">${e.amount > 0 ? '+' : '−'}${cash(Math.abs(e.amount))}</div>
        <button type="button" class="remove-btn" data-entry="${e.id}" aria-label="Remove this entry">✕</button>
      </div>`).join('') : '<div class="empty">Nothing yet.</div>';
  } catch (err) {
    historyEl.innerHTML = `<div class="empty">Couldn’t load history: ${esc(errorMessage(err))}</div>`;
  }
}

function shortWhen(ts) {
  return new Date(ts).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function openMoneySheet(kidId) {
  moneyKid = kidById(kidId);
  if (!moneyKid) return;
  moneyTitle.textContent = moneyKid.display_name;
  selectChip(moneyKindChips, moneyKindChips.querySelector('[data-value="payout"]'));
  moneyNote.value = '';
  showFormError(moneyError, '');
  renderMoneyHead();
  updateMoneyForm({ resetAmount: true });
  openSheet(moneyBackdrop);
  renderHistory();
}

async function submitMoney(e) {
  e.preventDefault();
  const amount = parseCents(moneyAmount.value);
  const kind = moneyKind();
  if (!amount) return showFormError(moneyError, 'Enter an amount, like 5 or 2.50.');
  showFormError(moneyError, '');
  moneySubmit.disabled = true;
  try {
    const note = moneyNote.value.trim() || null;
    if (kind === 'payout') await db.payOut(moneyKid.user_id, amount, note);
    else await db.addBonus(moneyKid.user_id, amount, note);
    showToast(kind === 'payout'
      ? `Paid out ${cash(amount)} to ${moneyKid.display_name}.`
      : `Bonus of ${cash(amount)} for ${moneyKid.display_name}.`, { ok: true });
    await loadChores();
    moneyNote.value = '';
    updateMoneyForm({ resetAmount: true });
    renderHistory();
  } catch (err) {
    showFormError(moneyError, errorMessage(err));
  } finally {
    moneySubmit.disabled = false;
  }
}

async function removeEntry(btn) {
  if (!armed(btn, '?')) return;
  btn.disabled = true;
  try {
    await db.removeLedgerEntry(Number(btn.dataset.entry));
    await loadChores();
    renderHistory();
    showToast('Entry removed.', { ok: true });
  } catch (err) {
    showToast(errorMessage(err));
    btn.disabled = false;
  }
}

// ---------- Wiring ----------

export function initChores() {
  [choreBackdrop, sendBackBackdrop, moneyBackdrop].forEach(wireSheet);

  bodyEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    const taskId = Number(e.target.closest('[data-task]')?.dataset.task);
    const task = data.tasks.find(t => t.id === taskId);
    if (btn?.dataset.action === 'approve' && task) return approve(task, btn);
    if (btn?.dataset.action === 'send-back' && task) return openSendBack(task);
    if (btn?.dataset.action === 'done-for-kid' && task) return doneForKid(task, btn);
    if (btn?.dataset.action === 'done-as' && task) return doneAs(task, btn.dataset.kid, btn);
    if (btn?.dataset.action === 'add') return openChoreSheet();
    const kidCard = e.target.closest('.kid-card');
    if (kidCard) return openMoneySheet(kidCard.dataset.kid);
    const choreRow = e.target.closest('.chore-row, .todo-row');
    if (choreRow) {
      const chore = data.chores.find(c => c.id === Number(choreRow.dataset.chore));
      if (chore) openChoreSheet(chore);
    }
  });

  choreKidChips.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    selectChip(choreKidChips, chip);
    choreKidHint.hidden = chip.dataset.value !== ANYONE;
  });
  repeatChips.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    selectChip(repeatChips, chip);
    updateRepeatHint();
  });
  weekdayRow.addEventListener('click', e => {
    const chip = e.target.closest('.day-chip');
    if (!chip) return;
    chip.classList.toggle('selected');
    updateRepeatHint();
  });
  choreForm.addEventListener('submit', submitChore);
  choreDelete.addEventListener('click', deleteEditing);

  sendBackForm.addEventListener('submit', submitSendBack);

  moneyKindChips.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    selectChip(moneyKindChips, chip);
    updateMoneyForm({ resetAmount: true });
  });
  moneyForm.addEventListener('submit', submitMoney);
  historyEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-entry]');
    if (btn) removeEntry(btn);
  });
}

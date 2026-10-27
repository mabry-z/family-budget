// The whole app for a kid: their balance, savings goal, chores and history.
// No tabs, no budget (the database wouldn't give them any anyway). On an
// iPad the page widens: money on the left, chores on the right.
// See docs/chores-plan.md.
import * as db from '../data.js';
import { money } from '../budget.js';
import { today, toISO } from '../paydays.js';
import { kidTaskGroups, payLabel, parseDollars, dueNote, goalProgress, ledgerLabel } from '../chores.js';
import { esc, errorMessage, showToast, showFormError, openSheet, closeSheet, wireSheet } from './dom.js';

const bodyEl = document.getElementById('kidBody');
const goalBackdrop = document.getElementById('goalBackdrop');
const goalForm = document.getElementById('goalForm');
const goalName = document.getElementById('goalName');
const goalTarget = document.getElementById('goalTarget');
const goalError = document.getElementById('goalError');
const goalSubmit = document.getElementById('goalSubmit');
const goalClear = document.getElementById('goalClear');

const data = { loaded: false, me: null, tasks: [], balance: 0, goal: null, ledger: [] };
const todayISO = () => toISO(today());

export async function loadKid({ quiet = false } = {}) {
  try {
    await db.ensureChoreTasks(todayISO());
    const [tasks, balances, goals, ledger] = await Promise.all([
      db.loadChoreTasks(), db.loadBalances(), db.loadGoals(), db.loadLedger(null, 8),
    ]);
    // Theirs, plus "Anyone" chores nobody has claimed yet.
    data.tasks = tasks.filter(t => t.kid_id === data.me.user_id || t.kid_id == null);
    data.balance = balances.get(data.me.user_id) ?? 0;
    data.goal = goals.get(data.me.user_id) ?? null;
    data.ledger = ledger;
    data.loaded = true;
  } catch (err) {
    if (!quiet) showToast(`Couldn't load your chores: ${errorMessage(err)}`);
  }
  renderKid();
}

function balanceCard(waiting) {
  const pending = waiting.reduce((n, t) => n + t.amount, 0);
  return `<div class="summary-card kid-balance" style="grid-area:bal">
    <div class="left-label">You’ve earned</div>
    <div class="kid-big">${money(data.balance)}</div>
    <div class="left-note">${pending > 0 ? `+${money(pending)} being checked by a parent` : 'Finish chores to earn more'}</div>
  </div>`;
}

function goalCard() {
  if (!data.goal) {
    return `<div class="summary-card kid-goal" style="grid-area:goal">
      <h3>My goal</h3>
      <div class="kid-goal-empty">Saving up for something?</div>
      <button type="button" class="save-btn" data-action="goal">Set a goal</button>
    </div>`;
  }
  const prog = goalProgress(data.goal, data.balance);
  return `<div class="summary-card kid-goal" style="grid-area:goal">
    <h3>My goal <button type="button" class="notify-link goal-edit" data-action="goal">Change</button></h3>
    <div class="kid-goal-name">${esc(data.goal.name)}</div>
    <div class="kid-goal-nums"><b>${money(Math.max(0, data.balance))}</b> of ${money(data.goal.target)}</div>
    <div class="bar-track kid-bar"><div class="bar-fill fill-ok" style="width:${prog.pct}%"></div></div>
    <div class="kid-goal-left${prog.reached ? ' reached' : ''}">${prog.reached ? 'You did it! Ask a parent about getting it.' : `${money(prog.left)} to go`}</div>
  </div>`;
}

// "Up for grabs · By Sun" — an "Anyone" chore goes to whoever finishes it first.
function metaLine(t) {
  const parts = [];
  if (t.kid_id == null) parts.push('<span class="grab-tag">Up for grabs</span> first to finish gets it');
  const due = dueNote(t, todayISO());
  if (due) parts.push(due);
  return parts.length ? `<div class="kid-row-meta">${parts.join(' · ')}</div>` : '';
}

function choresCard({ todo, waiting, finished }) {
  const todoRows = todo.map(t => `
    <div class="kid-row${t.status === 'sent_back' ? ' sent-back' : ''}">
      <div class="kid-row-text">
        <div class="kid-row-title">${esc(t.chore?.title ?? 'Chore')}</div>
        ${t.status === 'sent_back'
          ? `<div class="kid-row-note">Take another look${t.note ? `: “${esc(t.note)}”` : ''}</div>`
          : metaLine(t)}
      </div>
      <div class="kid-row-amt">${payLabel(t.amount)}</div>
      <button type="button" class="done-btn" data-action="done" data-task="${t.id}">Done</button>
    </div>`).join('');

  const waitingRows = waiting.map(t => `
    <div class="kid-row waiting">
      <div class="kid-row-text">
        <div class="kid-row-title">${esc(t.chore?.title ?? 'Chore')}</div>
        <div class="kid-row-meta">Waiting for a parent to check · <button type="button" class="notify-link" data-action="undo" data-task="${t.id}">Not done yet?</button></div>
      </div>
      <div class="kid-row-amt">${payLabel(t.amount)}</div>
    </div>`).join('');

  const finishedRows = finished.map(t => `
    <div class="kid-row finished">
      <span class="kid-check">✓</span>
      <div class="kid-row-text"><div class="kid-row-title">${esc(t.chore?.title ?? 'Chore')}</div></div>
      <div class="kid-row-amt plus">${t.amount > 0 ? `+${money(t.amount)}` : ''}</div>
    </div>`).join('');

  const empty = !todo.length && !waiting.length
    ? `<div class="kid-empty">${finished.length ? 'All done for today. Nice work!' : 'Nothing on your list right now.'}</div>` : '';

  return `<div class="summary-card kid-chores" style="grid-area:chores">
    <h3>My chores</h3>
    ${todoRows}${empty}
    ${waiting.length ? `<div class="kid-section">Being checked</div>${waitingRows}` : ''}
    ${finished.length ? `<div class="kid-section">Done today</div>${finishedRows}` : ''}
  </div>`;
}

function historyCard() {
  if (!data.ledger.length) return '';
  return `<div class="summary-card kid-history" style="grid-area:hist">
    <h3>Recent</h3>
    ${data.ledger.map(e => `<div class="summary-row"><span>${esc(ledgerLabel(e))}</span>
      <span class="${e.amount > 0 ? 'plus' : ''}">${e.amount > 0 ? '+' : '−'}${money(Math.abs(e.amount))}</span></div>`).join('')}
  </div>`;
}

export function renderKid() {
  if (!data.loaded) {
    bodyEl.innerHTML = '<div class="summary-card"><div class="empty">Loading your chores…</div></div>';
    return;
  }
  const groups = kidTaskGroups(data.tasks, todayISO());
  bodyEl.innerHTML = `<div class="kid-layout">${balanceCard(groups.waiting)}${choresCard(groups)}${goalCard()}${historyCard()}</div>`;
}

// ---------- Actions ----------

async function markDone(btn) {
  btn.disabled = true;
  btn.textContent = '✓';
  btn.classList.add('pressed');
  try {
    await db.markChoreDone(Number(btn.dataset.task));
    showToast('Nice! A parent will check it.', { ok: true });
  } catch (err) {
    showToast(/someone else/i.test(errorMessage(err)) ? 'Too late, someone else already did that one.' : errorMessage(err));
  }
  await loadKid({ quiet: true });
}

async function undo(btn) {
  btn.disabled = true;
  try {
    await db.undoChoreDone(Number(btn.dataset.task));
  } catch (err) {
    showToast(errorMessage(err));
  }
  await loadKid({ quiet: true });
}

function openGoalSheet() {
  goalName.value = data.goal?.name ?? '';
  goalTarget.value = data.goal ? String(data.goal.target) : '';
  goalClear.hidden = !data.goal;
  showFormError(goalError, '');
  openSheet(goalBackdrop);
}

async function submitGoal(e) {
  e.preventDefault();
  const name = goalName.value.trim();
  const target = parseDollars(goalTarget.value);
  if (!name) return showFormError(goalError, 'What are you saving for?');
  if (!target) return showFormError(goalError, 'How much does it cost? Whole dollars.');
  showFormError(goalError, '');
  goalSubmit.disabled = true;
  try {
    await db.setGoal(name, target);
    closeSheet(goalBackdrop);
    await loadKid();
  } catch (err) {
    showFormError(goalError, errorMessage(err));
  } finally {
    goalSubmit.disabled = false;
  }
}

async function clearGoal() {
  goalClear.disabled = true;
  try {
    await db.clearGoal();
    closeSheet(goalBackdrop);
    await loadKid();
  } catch (err) {
    showFormError(goalError, errorMessage(err));
  } finally {
    goalClear.disabled = false;
  }
}

export function initKid(me) {
  data.me = me;
  wireSheet(goalBackdrop);
  bodyEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    if (btn.dataset.action === 'done') markDone(btn);
    else if (btn.dataset.action === 'undo') undo(btn);
    else if (btn.dataset.action === 'goal') openGoalSheet();
  });
  goalForm.addEventListener('submit', submitGoal);
  goalClear.addEventListener('click', clearGoal);
}

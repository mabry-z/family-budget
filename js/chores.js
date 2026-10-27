// Chores: pure helpers (no DOM, no Supabase). See docs/chores-plan.md.
import { KID_EMAIL_DOMAIN } from './config.js';

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Shown Monday first, the way a school week reads.
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

// The email behind a kid's name sign-in ("Luke" → luke@kids.cadence.invalid).
// Must match the list in supabase/migrations/013_chores.sql.
export function kidEmail(name) {
  const slug = String(name ?? '').trim().toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
  return slug ? `${slug}@${KID_EMAIL_DOMAIN}` : '';
}

export const isKidSignIn = email => String(email ?? '').toLowerCase().endsWith(`@${KID_EMAIL_DOMAIN}`);

// "Every day", "Mon & Thu", "Once a week", "One time".
export function repeatLabel(chore) {
  if (chore.repeat === 'daily') return 'Every day';
  if (chore.repeat === 'weekly') {
    const days = WEEKDAY_ORDER.filter(d => (chore.weekdays ?? []).includes(d)).map(d => WEEKDAYS[d]);
    if (!days.length) return 'Once a week';
    if (days.length === 1) return `Every ${days[0]}`;
    return days.slice(0, -1).join(', ') + ' & ' + days.at(-1);
  }
  return 'One time';
}

// Chore money is dollars and cents (migration 014): "$2", "$0.50",
// "$12.25". The budget elsewhere stays whole dollars (money() in budget.js).
export const roundCents = n => Math.round((Number(n) || 0) * 100) / 100;

export function cash(n) {
  const v = roundCents(n);
  const abs = Math.abs(v);
  const text = Number.isInteger(abs)
    ? abs.toLocaleString('en-US')
    : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '−$' : '$') + text;
}

// "$2" or "$0.50", or "No pay" for $0 chores.
export const payLabel = amount => (Number(amount) > 0 ? cash(amount) : 'No pay');

// For a text box: "2", "0.50".
export const cashInput = n => {
  const v = roundCents(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
};

// Dollars and cents from a text box ("2", "0.5", ".50", "$1.25"), or null.
export function parseCents(text) {
  const clean = String(text ?? '').replace(/[$,\s]/g, '');
  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(clean)) return null;
  return roundCents(clean);
}

// Whole dollars from a text box (savings goals), or null.
export function parseDollars(text) {
  const clean = String(text ?? '').replace(/[$,\s]/g, '');
  if (!/^\d+$/.test(clean)) return null;
  return Number(clean);
}

const statusRank = { sent_back: 0, open: 1, done: 2, approved: 3, expired: 4 };

// Tasks a kid should see, grouped: to do (sent back first), waiting for a
// parent, and finished today.
export function kidTaskGroups(tasks, todayISO) {
  const byDue = (a, b) => (statusRank[a.status] - statusRank[b.status])
    || a.due_on.localeCompare(b.due_on) || a.id - b.id;
  return {
    todo: tasks.filter(t => t.status === 'open' || t.status === 'sent_back').sort(byDue),
    waiting: tasks.filter(t => t.status === 'done').sort(byDue),
    finished: tasks.filter(t => t.status === 'approved' && dayOfISO(t.reviewed_at) === todayISO).sort(byDue),
  };
}

// The local calendar day of a timestamp, 'YYYY-MM-DD'.
export function dayOfISO(timestamp) {
  if (!timestamp) return null;
  const d = new Date(timestamp);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// "Due Sun" for a weekly task due later in the week; nothing for today's.
export function dueNote(task, todayISO) {
  if (task.due_on <= todayISO) return '';
  const [y, m, d] = task.due_on.split('-').map(Number);
  return `By ${WEEKDAYS[new Date(y, m - 1, d).getDay()]}`;
}

// Goal progress for display: { pct, left, reached }.
export function goalProgress(goal, balance) {
  if (!goal) return null;
  const have = Math.max(0, balance);
  return {
    pct: Math.min(100, Math.round((have / goal.target) * 100)),
    left: roundCents(Math.max(0, goal.target - have)),
    reached: have >= goal.target,
  };
}

// History line: "Unload dishwasher", "Paid out", "Bonus · Report card".
export function ledgerLabel(entry) {
  if (entry.kind === 'payout') return entry.note ? `Paid out · ${entry.note}` : 'Paid out';
  if (entry.kind === 'bonus') return entry.note ? `Bonus · ${entry.note}` : 'Bonus';
  return entry.note || 'Chore';
}

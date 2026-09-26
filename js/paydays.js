// Dates, federal holidays and the payday rule. Pure — no DOM, no Supabase.
//
// Pay arrives on the 1st and 15th; when that falls on a weekend or a federal
// holiday it comes the business day before.

import { MONTHS_SHORT } from './budget.js';

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- Local calendar dates ----------

export function fromISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function toISO(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function today() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// "Fri, Oct 30"
export function shortDay(date) {
  return `${WEEKDAYS_SHORT[date.getDay()]}, ${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}`;
}

// "Sep 15–30, 2026" / "Oct 30 – Nov 12, 2026" / "Dec 31, 2026 – Jan 13, 2027"
export function rangeLabel(start, end) {
  const mon = d => MONTHS_SHORT[d.getMonth()];
  if (start.getFullYear() !== end.getFullYear()) {
    return `${mon(start)} ${start.getDate()}, ${start.getFullYear()} – ${mon(end)} ${end.getDate()}, ${end.getFullYear()}`;
  }
  if (start.getMonth() !== end.getMonth()) {
    return `${mon(start)} ${start.getDate()} – ${mon(end)} ${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${mon(start)} ${start.getDate()}–${end.getDate()}, ${end.getFullYear()}`;
}

// ---------- Federal holidays ----------

function nthWeekday(year, month, weekday, n) {
  const first = new Date(year, month, 1);
  return new Date(year, month, 1 + ((weekday - first.getDay() + 7) % 7) + (n - 1) * 7);
}

function lastWeekday(year, month, weekday) {
  const last = new Date(year, month + 1, 0);
  return new Date(year, month, last.getDate() - ((last.getDay() - weekday + 7) % 7));
}

// Fixed-date holidays on a Saturday are observed Friday; on a Sunday, Monday.
function observed(date) {
  if (date.getDay() === 6) return addDays(date, -1);
  if (date.getDay() === 0) return addDays(date, 1);
  return date;
}

const holidayCache = new Map();

function holidaysObservedIn(year) {
  if (!holidayCache.has(year)) {
    const list = [
      ["New Year's Day", observed(new Date(year, 0, 1))],
      ['Martin Luther King Jr. Day', nthWeekday(year, 0, 1, 3)],
      ["Washington's Birthday", nthWeekday(year, 1, 1, 3)],
      ['Memorial Day', lastWeekday(year, 4, 1)],
      ['Juneteenth', observed(new Date(year, 5, 19))],
      ['Independence Day', observed(new Date(year, 6, 4))],
      ['Labor Day', nthWeekday(year, 8, 1, 1)],
      ['Columbus Day', nthWeekday(year, 9, 1, 2)],
      ['Veterans Day', observed(new Date(year, 10, 11))],
      ['Thanksgiving', nthWeekday(year, 10, 4, 4)],
      ['Christmas Day', observed(new Date(year, 11, 25))],
    ];
    holidayCache.set(year, new Map(list.map(([name, date]) => [toISO(date), name])));
  }
  return holidayCache.get(year);
}

// Checks the next year too: New Year's Day on a Saturday is observed Dec 31.
export function federalHoliday(date) {
  const iso = toISO(date);
  return holidaysObservedIn(date.getFullYear()).get(iso)
    ?? holidaysObservedIn(date.getFullYear() + 1).get(iso)
    ?? null;
}

function whyNotPayable(date) {
  if (date.getDay() === 6) return 'a Saturday';
  if (date.getDay() === 0) return 'a Sunday';
  const holiday = federalHoliday(date);
  return holiday ? holiday : null;
}

// ---------- Paydays ----------

// The payday that opens a period (startDay 1 → the 1st, 16 → the 15th).
export function nominalPayday(period) {
  return new Date(period.year, period.month - 1, period.startDay === 1 ? 1 : 15);
}

// { date, nominal, reason }: reason explains why it moved ("a Sunday"), or null.
export function expectedPayday(period) {
  const nominal = nominalPayday(period);
  const reason = whyNotPayable(nominal);
  let date = nominal;
  while (whyNotPayable(date)) date = addDays(date, -1);
  return { date, nominal, reason };
}

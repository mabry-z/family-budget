import { MONTHS_SHORT } from '../budget.js';
import { shortDay, toISO } from '../paydays.js';
import { errorMessage, showFormError, openSheet, closeSheet, wireSheet } from './dom.js';

const backdrop = document.getElementById('paydayBackdrop');
const form = document.getElementById('paydayForm');
const questionEl = document.getElementById('paydayQuestion');
const detailEl = document.getElementById('paydayDetail');
const dateInput = document.getElementById('paydayDate');
const errorEl = document.getElementById('paydayError');
const submitBtn = document.getElementById('paydaySubmit');
const notYetBtn = document.getElementById('paydayNotYet');

let ctx;
let prompt; // see openPaydaySheet

// ctx: { onStart(period, startsOnISO), onNotYet(period) }
export function initPaydaySheet(context) {
  ctx = context;
  wireSheet(backdrop);

  notYetBtn.addEventListener('click', () => {
    ctx.onNotYet(prompt.period);
    closeSheet(backdrop);
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const value = dateInput.value;
    if (!value || value < dateInput.min || value > dateInput.max) {
      return showFormError(errorEl, 'Pick a date between the last period’s start and today.');
    }
    showFormError(errorEl, '');
    submitBtn.disabled = true;
    try {
      await ctx.onStart(prompt.period, value);
      closeSheet(backdrop);
    } catch (err) {
      showFormError(errorEl, errorMessage(err));
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// prompt: { period, expected: { date, nominal, reason }, minDate, maxDate, defaultDate }
export function openPaydaySheet(p) {
  prompt = p;
  const { nominal, date, reason } = p.expected;
  const payName = `${MONTHS_SHORT[nominal.getMonth()]} ${nominal.getDate()}`;

  questionEl.textContent = `Has your ${payName} pay arrived?`;
  detailEl.textContent = reason
    ? `It's expected ${shortDay(date)}, because ${payName} is ${reason}. Pick the day it actually landed in your account.`
    : `It's expected ${shortDay(date)}. Pick the day it actually landed in your account.`;

  dateInput.min = toISO(p.minDate);
  dateInput.max = toISO(p.maxDate);
  dateInput.value = toISO(p.defaultDate);
  showFormError(errorEl, '');
  openSheet(backdrop);
}

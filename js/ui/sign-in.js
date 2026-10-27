// The full-screen gate shown instead of the app: a splash while the saved
// session is checked, the sign-in form, or "no household yet". Kids sign in
// with their name and PIN instead (see kidEmail() in js/chores.js); the
// iPad remembers which way it was last used.
import { errorMessage, showFormError } from './dom.js';
import { kidEmail } from '../chores.js';

const gate = document.getElementById('authGate');
const form = document.getElementById('signInForm');
const emailInput = document.getElementById('signInEmail');
const passwordInput = document.getElementById('signInPassword');
const errorEl = document.getElementById('signInError');
const submitBtn = document.getElementById('signInSubmit');
const forgotBtn = document.getElementById('forgotPassword');
const forgotHint = document.getElementById('forgotHint');
const noHousehold = document.getElementById('noHousehold');
const noHouseholdEmail = document.getElementById('noHouseholdEmail');
const noHouseholdSignOut = document.getElementById('noHouseholdSignOut');
const titleEl = document.getElementById('signInTitle');
const emailLabel = document.getElementById('signInEmailLabel');
const passwordLabel = document.getElementById('signInPasswordLabel');
const kidToggle = document.getElementById('kidSignInToggle');

const KID_MODE_KEY = 'cadence.kidSignIn';
let kidMode = false;

function readKidMode() {
  try { return localStorage.getItem(KID_MODE_KEY) === '1'; } catch { return false; }
}

function setKidMode(on) {
  kidMode = on;
  try { localStorage.setItem(KID_MODE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  titleEl.textContent = on ? 'Kids sign in' : 'Sign in';
  emailLabel.textContent = on ? 'Your name' : 'Email';
  emailInput.type = on ? 'text' : 'email';
  emailInput.autocapitalize = on ? 'words' : 'off';
  emailInput.value = '';
  passwordLabel.textContent = on ? 'PIN' : 'Password';
  passwordInput.inputMode = on ? 'numeric' : 'text';
  passwordInput.value = '';
  kidToggle.textContent = on ? 'Parents: sign in with email' : 'Kids: sign in with your name';
  forgotBtn.textContent = on ? 'Forgot your PIN?' : 'Forgot password?';
  forgotHint.textContent = on
    ? 'Ask a parent to reset it.'
    : 'Ask your household’s owner to reset it. Once you’re signed in, you can change your password in Settings.';
  forgotHint.hidden = true;
  showFormError(errorEl, '');
}

function showGate(panel) {
  document.body.classList.add('gated');
  gate.hidden = false;
  form.hidden = panel !== form;
  noHousehold.hidden = panel !== noHousehold;
}

// ctx: { onSignIn(email, password), onSignOut() }
export function initSignIn(ctx) {
  forgotBtn.addEventListener('click', () => { forgotHint.hidden = !forgotHint.hidden; });
  kidToggle.addEventListener('click', () => { setKidMode(!kidMode); emailInput.focus(); });
  setKidMode(readKidMode());
  noHouseholdSignOut.addEventListener('click', () => ctx.onSignOut());

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const email = kidMode ? kidEmail(emailInput.value) : emailInput.value.trim();
    const password = kidMode ? passwordInput.value.replace(/\s/g, '') : passwordInput.value;
    if (!email || !password) {
      return showFormError(errorEl, kidMode ? 'Type your name and PIN.' : 'Enter your email and password.');
    }
    showFormError(errorEl, '');
    submitBtn.disabled = true;
    try {
      await ctx.onSignIn(email, password);
      passwordInput.value = '';
    } catch (err) {
      const message = errorMessage(err);
      showFormError(errorEl, kidMode && /don’t match/.test(message) ? 'That name and PIN don’t match.' : message);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

export function showSignIn() {
  showGate(form);
  emailInput.focus();
}

export function showNoHousehold(email) {
  noHouseholdEmail.textContent = email;
  showGate(noHousehold);
}

export function hideGate() {
  gate.hidden = true;
  document.body.classList.remove('gated');
}

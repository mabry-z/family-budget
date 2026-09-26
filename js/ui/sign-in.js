// The full-screen gate shown instead of the app: a splash while the saved
// session is checked, the sign-in form, or "no household yet".
import { errorMessage, showFormError } from './dom.js';

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

function showGate(panel) {
  document.body.classList.add('gated');
  gate.hidden = false;
  form.hidden = panel !== form;
  noHousehold.hidden = panel !== noHousehold;
}

// ctx: { onSignIn(email, password), onSignOut() }
export function initSignIn(ctx) {
  forgotBtn.addEventListener('click', () => { forgotHint.hidden = !forgotHint.hidden; });
  noHouseholdSignOut.addEventListener('click', () => ctx.onSignOut());

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) return showFormError(errorEl, 'Enter your email and password.');
    showFormError(errorEl, '');
    submitBtn.disabled = true;
    try {
      await ctx.onSignIn(email, password);
      passwordInput.value = '';
    } catch (err) {
      showFormError(errorEl, errorMessage(err));
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

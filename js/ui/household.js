// Settings → Household: who's in it, change password, sign out.
import { esc, errorMessage, showFormError, openSheet, closeSheet, wireSheet } from './dom.js';

const infoEl = document.getElementById('householdInfo');
const settingsBackdrop = document.getElementById('settingsBackdrop');
const openPasswordBtn = document.getElementById('openPassword');
const signOutBtn = document.getElementById('signOutBtn');

const passwordBackdrop = document.getElementById('passwordBackdrop');
const passwordForm = document.getElementById('passwordForm');
const usernameInput = document.getElementById('passwordUsername');
const newPasswordInput = document.getElementById('newPassword');
const confirmPasswordInput = document.getElementById('confirmPassword');
const passwordError = document.getElementById('passwordError');
const passwordSubmit = document.getElementById('passwordSubmit');

const MIN_PASSWORD = 8;
const ROLE_LABELS = { owner: 'Owner', member: 'Member' };

let signedInEmail = '';

// ctx: { onChangePassword(password), onSignOut() }
export function initHousehold(ctx) {
  wireSheet(passwordBackdrop);

  openPasswordBtn.addEventListener('click', () => {
    closeSheet(settingsBackdrop);
    passwordForm.reset();
    usernameInput.value = signedInEmail; // lets password managers update the right entry
    showFormError(passwordError, '');
    openSheet(passwordBackdrop);
  });

  passwordForm.addEventListener('submit', async e => {
    e.preventDefault();
    const password = newPasswordInput.value;
    if (password.length < MIN_PASSWORD) {
      return showFormError(passwordError, `Use at least ${MIN_PASSWORD} characters.`);
    }
    if (password !== confirmPasswordInput.value) {
      return showFormError(passwordError, 'The two passwords don’t match.');
    }
    showFormError(passwordError, '');
    passwordSubmit.disabled = true;
    try {
      await ctx.onChangePassword(password);
      closeSheet(passwordBackdrop);
    } catch (err) {
      showFormError(passwordError, errorMessage(err));
    } finally {
      passwordSubmit.disabled = false;
    }
  });

  // Two taps instead of confirm(): some browsers block pop-up dialogs.
  let armedTimer = null;
  signOutBtn.addEventListener('click', () => {
    if (armedTimer) {
      clearTimeout(armedTimer);
      armedTimer = null;
      signOutBtn.disabled = true;
      signOutBtn.textContent = 'Signing out…';
      // On success the page reloads to the sign-in screen; otherwise let them retry.
      Promise.resolve(ctx.onSignOut()).finally(() => {
        signOutBtn.disabled = false;
        signOutBtn.textContent = 'Sign out';
      });
      return;
    }
    signOutBtn.textContent = 'Tap again to sign out';
    armedTimer = setTimeout(() => {
      armedTimer = null;
      signOutBtn.textContent = 'Sign out';
    }, 4000);
  });
}

// info: household_info() result ({ name, role, members: [{ email, role, is_me }] }) or null.
export function renderHousehold(info, email) {
  signedInEmail = email;
  if (!info) {
    infoEl.innerHTML = `<div class="empty">Couldn’t load your household. Signed in as ${esc(email)}.</div>`;
    return;
  }
  const members = (info.members ?? []).map(m => `
    <div class="member-row">
      <span class="email">${esc(m.email)}${m.is_me ? ' (you)' : ''}</span>
      <span class="role">${ROLE_LABELS[m.role] ?? esc(m.role)}</span>
    </div>`).join('');
  infoEl.innerHTML = `<div class="household-name">${esc(info.name)}</div>${members}`;
}

// Settings → Notifications: a "Turn on notifications" button, which becomes a
// card saying they're on for this phone (with "Send a test" / "Turn off").
// Each phone turns them on for itself.
import * as push from '../notifications.js';
import { errorMessage, showToast } from './dom.js';

const el = document.getElementById('notificationsInfo');

const HINTS = {
  off: 'Get a notification on this phone when a new card purchase comes in.',
  blocked: 'Turn them back on in your phone’s Settings → Notifications → Cadence.',
  'home-screen': 'Open Cadence from its home-screen icon to turn on notifications.',
  unsupported: 'This browser can’t show notifications from Cadence.',
};

function statusCard(label, cls) {
  return `<div class="household-card"><div class="member-row"><span>Card purchases</span>`
    + `<span class="notify-status ${cls}">${label}</span></div></div>`;
}

function render(state) {
  if (state === 'on') {
    el.innerHTML = `<div class="household-card">
        <div class="member-row"><span>Card purchases</span><span class="notify-status on">On for this phone</span></div>
        <div class="member-row notify-actions">
          <button type="button" class="notify-link" data-action="test">Send a test</button>
          <button type="button" class="notify-link" data-action="off">Turn off</button>
        </div>
      </div>`;
    return;
  }
  if (state === 'off') {
    el.innerHTML = `<button type="button" class="save-btn" data-action="on">Turn on notifications</button>`
      + `<div class="hint">${HINTS.off}</div>`;
    return;
  }
  const label = state === 'blocked' ? 'Blocked' : 'Not available here';
  el.innerHTML = statusCard(label, 'warn') + `<div class="hint">${HINTS[state]}</div>`;
}

export async function refreshNotifications() {
  render(await push.notificationState());
}

export function initNotifications() {
  el.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    try {
      switch (btn.dataset.action) {
        case 'on': {
          const state = await push.turnOn();
          render(state);
          if (state === 'on') {
            await push.sendTest().catch(() => {}); // a first one, so they see what it looks like
            showToast('Notifications are on for this phone.', { ok: true });
          }
          break;
        }
        case 'test':
          await push.sendTest();
          showToast('Test sent. It should pop up in a moment.', { ok: true });
          break;
        case 'off':
          render(await push.turnOff());
          showToast('Notifications are off for this phone.', { ok: true });
          break;
      }
    } catch (err) {
      const what = btn.dataset.action === 'test' ? 'send a test' : 'change notifications';
      showToast(`Couldn't ${what}: ${errorMessage(err)}`);
    } finally {
      btn.disabled = false;
    }
  });
  refreshNotifications();
}

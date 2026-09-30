// Phone notifications for new card purchases (see docs/notifications-plan.md):
// the service worker (sw.js), this phone's permission and its subscription.
// The Settings section is js/ui/notifications.js.
import * as db from './data.js';
import { VAPID_PUBLIC_KEY } from './config.js';

const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isHomeScreen = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let registration = null;

// Registered on every start so a tapped notification can find the app.
export async function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    registration = await navigator.serviceWorker.register('./sw.js');
  } catch {
    registration = null; // e.g. a private window; notifications just stay unavailable
  }
}

async function ready() {
  if (!registration) await registerWorker();
  return registration ? navigator.serviceWorker.ready : null;
}

async function currentSubscription() {
  const reg = await ready();
  return reg ? reg.pushManager.getSubscription() : null;
}

// 'on' | 'off' | 'blocked' | 'home-screen' (iPhone Safari: open from the
// icon instead) | 'unsupported'.
export async function notificationState() {
  if (!supported) return isIOS && !isHomeScreen ? 'home-screen' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const sub = Notification.permission === 'granted' ? await currentSubscription() : null;
  return sub ? 'on' : 'off';
}

function keyBytes(base64url) {
  const base64 = (base64url + '='.repeat((4 - base64url.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

function toRow(sub) {
  const { endpoint, keys } = sub.toJSON();
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

// Must run from a tap: the phone asks "Allow notifications?".
export async function turnOn() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return notificationState();
  const reg = await ready();
  if (!reg) throw new Error('This phone couldn’t start notifications.');
  const sub = await reg.pushManager.getSubscription()
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
  await db.savePushSubscription(toRow(sub));
  return 'on';
}

// Forgets this phone in Cadence first, so no more are sent even if the
// phone's own unsubscribe fails.
export async function turnOff() {
  const sub = await currentSubscription();
  if (!sub) return notificationState();
  await db.deletePushSubscription(sub.endpoint);
  await sub.unsubscribe().catch(() => {});
  return notificationState();
}

export async function sendTest() {
  const sub = await currentSubscription();
  if (!sub) throw new Error('Notifications aren’t on for this phone.');
  return db.sendTestNotification(sub.endpoint);
}

// On each start: makes sure Cadence still has this phone (the phone can
// change its address). Quietly does nothing before migration 009.
export async function resync() {
  if (!supported || Notification.permission !== 'granted') return;
  const sub = await currentSubscription().catch(() => null);
  if (sub) await db.savePushSubscription(toRow(sub)).catch(() => {});
}

// Before signing out: the next person on this phone shouldn't get the
// previous person's notifications.
export async function forgetThisPhone() {
  if (!supported) return;
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return;
  await db.deletePushSubscription(sub.endpoint).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

// A notification tapped while Cadence is already open (see sw.js).
export function onReviewRequest(callback) {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'review-import') callback(e.data.importId);
  });
}

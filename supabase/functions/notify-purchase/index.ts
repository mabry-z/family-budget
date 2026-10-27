// Sends phone notifications: new card purchases (see
// docs/notifications-plan.md) and chores (docs/chores-plan.md). Pasted into
// the Supabase dashboard by hand as the Edge Function "notify-purchase",
// with "Verify JWT" turned off.
//
// Ways in:
//   { import_id }            — from the card_imports trigger (migration 009).
//                              Anyone can call this, so it trusts nothing but
//                              the id: it only announces a purchase that's
//                              still pending, is less than 15 minutes old and
//                              hasn't been announced, and marks it announced.
//                              Parents' phones only — never the kids'.
//   { chore_task_id }        — from the chore_tasks trigger (migration 013):
//                              done → both parents; approved / sent back →
//                              the kid. Same rules: recent, announced once.
//   { ledger_id }            — a bonus (migration 013) → the kid.
//   { test: true, endpoint } — Settings → "Send a test", signed in. Only goes
//                              to that person's own phone.
//
// Secrets (Edge Functions → Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.
//
// No imports on purpose: the dashboard couldn't package a Web Push library,
// so this talks to Supabase with fetch() and does the Web Push signing and
// encryption (RFC 8291 / 8292) with the built-in WebCrypto.

const SITE = 'https://mabry-z.github.io/family-budget/';
const FRESH_MS = 15 * 60 * 1000;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SECRET_KEY = (() => {
  try {
    return JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default;
  } catch {
    return undefined;
  }
})() ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ---------- Talking to the database (bypasses RLS: server only) ----------

function adminHeaders(extra = {}) {
  // New secret keys go only in apikey; an old service_role key is a JWT and
  // goes in both.
  const auth = SECRET_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${SECRET_KEY}` } : {};
  return { apikey: SECRET_KEY, ...auth, ...extra };
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: adminHeaders({
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const eq = value => 'eq.' + encodeURIComponent(value);

// ---------- Web Push ----------

const enc = new TextEncoder();

function b64u(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(text) {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// The VAPID signature that proves the message comes from Cadence (RFC 8292).
async function vapidHeader(endpoint, publicKey, privateKey) {
  const pub = unb64u(publicKey);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d: privateKey,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: SITE,
  })));
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${publicKey}`;
}

// Encrypts the message so only that phone can read it (RFC 8291, aes128gcm).
async function encrypt(payload, p256dh, authSecret) {
  const uaPublic = unb64u(p256dh);
  const auth = unb64u(authSecret);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(enc.encode(payload), new Uint8Array([2])); // 2 = last (only) record
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plain));

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// Returns the push service's HTTP status (201 = delivered to Apple/Google).
async function sendPush(sub, message) {
  const body = await encrypt(JSON.stringify(message), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(sub.endpoint, Deno.env.get('VAPID_PUBLIC_KEY'), Deno.env.get('VAPID_PRIVATE_KEY')),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(24 * 3600),
      Urgency: 'high',
    },
    body,
  });
  if (!res.ok) console.error('Push failed', res.status, await res.text());
  return res.status;
}

// Sends to each phone; forgets phones that have turned notifications off
// (Apple/Google answer 404 or 410 for those).
async function sendAll(subs, message) {
  let sent = 0;
  await Promise.all(subs.map(async s => {
    try {
      const status = await sendPush(s, message);
      if (status >= 200 && status < 300) sent++;
      else if (status === 404 || status === 410) await rest(`push_subscriptions?id=${eq(s.id)}`, { method: 'DELETE' });
    } catch (err) {
      console.error('Push failed', err);
    }
  }));
  return sent;
}

// ---------- Who gets what ----------

async function parentIds(householdId) {
  const rows = await rest(`household_members?household_id=${eq(householdId)}&role=in.(owner,member)&select=user_id`);
  return (rows ?? []).map(r => r.user_id);
}

async function subsFor(userIds) {
  if (!userIds.length) return [];
  return await rest(`push_subscriptions?user_id=in.(${userIds.map(encodeURIComponent).join(',')})&select=id,endpoint,p256dh,auth`) ?? [];
}

// ---------- The ways in ----------

// Whole dollars, as the app shows money.
const dollars = cents => '$' + Math.max(1, Math.round(cents / 100)).toLocaleString('en-US');

async function announcePurchase(importId) {
  const cutoff = new Date(Date.now() - FRESH_MS).toISOString();
  const rows = await rest(
    `card_imports?id=${eq(importId)}&notified_at=is.null&status=eq.pending&created_at=gt.${encodeURIComponent(cutoff)}`
      + '&select=id,household_id,card,merchant,amount_cents,unreadable',
    { method: 'PATCH', body: { notified_at: new Date().toISOString() }, prefer: 'return=representation' },
  );
  const imp = rows?.[0];
  if (!imp) return reply({ sent: 0, reason: 'nothing to announce' });

  const subs = await subsFor(await parentIds(imp.household_id));
  // Star alerts have no store: "Star Card · $5", "Tap to add the store".
  const message = imp.unreadable
    ? { title: `Couldn’t read a ${imp.card} alert`, body: 'Tap to check it' }
    : imp.merchant
      ? { title: `${imp.merchant} · ${dollars(imp.amount_cents)}`, body: `${imp.card} · Tap to review` }
      : { title: `${imp.card} · ${dollars(imp.amount_cents)}`, body: 'Tap to add the store' };
  const sent = await sendAll(subs ?? [], { ...message, tag: `import-${imp.id}`, importId: imp.id });
  return reply({ sent });
}

// Chore money is dollars and cents (migration 014): "$2", "$0.50".
const wholeDollars = n => {
  const v = Math.round(Number(n) * 100) / 100;
  return '$' + (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2));
};

async function kidName(userId) {
  const rows = await rest(`household_members?user_id=${eq(userId)}&select=display_name`);
  return rows?.[0]?.display_name || 'Your kid';
}

async function announceChore(taskId) {
  const cutoff = new Date(Date.now() - FRESH_MS).toISOString();
  const found = await rest(`chore_tasks?id=${eq(taskId)}&select=status`);
  const status = found?.[0]?.status;
  if (!['done', 'approved', 'sent_back'].includes(status)) return reply({ sent: 0, reason: 'nothing to announce' });

  // Claims this change: only one call gets the row back.
  const rows = await rest(
    `chore_tasks?id=${eq(taskId)}&status=${eq(status)}&updated_at=gt.${encodeURIComponent(cutoff)}`
      + `&or=(notified_status.is.null,notified_status.neq.${status})`
      + '&select=id,household_id,kid_id,status,amount,note,chore:chores(title)',
    { method: 'PATCH', body: { notified_status: status }, prefer: 'return=representation' },
  );
  const task = rows?.[0];
  if (!task) return reply({ sent: 0, reason: 'nothing to announce' });

  const title = task.chore?.title ?? 'A chore';
  const data = { tag: `chore-${task.id}-${status}`, choreTaskId: task.id };
  let subs;
  let message;
  if (status === 'done') {
    subs = await subsFor(await parentIds(task.household_id));
    message = {
      title: `${await kidName(task.kid_id)} finished ${title}`,
      body: task.amount > 0 ? `${wholeDollars(task.amount)} · Tap to review` : 'Tap to review',
    };
  } else if (status === 'approved') {
    subs = await subsFor([task.kid_id]);
    message = task.amount > 0
      ? { title: `Approved! +${wholeDollars(task.amount)}`, body: title }
      : { title: 'Approved!', body: title };
  } else {
    subs = await subsFor([task.kid_id]);
    message = { title: `Take another look: ${title}`, body: task.note || 'A parent sent it back.' };
  }
  const sent = await sendAll(subs, { ...message, ...data });
  return reply({ sent });
}

async function announceBonus(ledgerId) {
  const cutoff = new Date(Date.now() - FRESH_MS).toISOString();
  const rows = await rest(
    `kid_ledger?id=${eq(ledgerId)}&kind=eq.bonus&notified_at=is.null&created_at=gt.${encodeURIComponent(cutoff)}`
      + '&select=id,kid_id,amount,note',
    { method: 'PATCH', body: { notified_at: new Date().toISOString() }, prefer: 'return=representation' },
  );
  const entry = rows?.[0];
  if (!entry) return reply({ sent: 0, reason: 'nothing to announce' });
  const sent = await sendAll(await subsFor([entry.kid_id]), {
    title: `Bonus! +${wholeDollars(entry.amount)}`,
    body: entry.note || 'A bonus from your parents',
    tag: `bonus-${entry.id}`,
    open: 'chores',
  });
  return reply({ sent });
}

async function sendTest(req, endpoint) {
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SECRET_KEY, Authorization: req.headers.get('Authorization') ?? '' },
  });
  const user = who.ok ? await who.json() : null;
  if (!user?.id) return reply({ error: 'Sign in first.' }, 401);

  const subs = await rest(`push_subscriptions?user_id=${eq(user.id)}&endpoint=${eq(endpoint)}&select=id,endpoint,p256dh,auth`);
  if (!subs?.length) return reply({ error: 'Notifications aren’t on for this phone.' }, 404);

  const me = await rest(`household_members?user_id=${eq(user.id)}&select=role`);
  const sent = await sendAll(subs, {
    title: 'Notifications are on',
    body: me?.[0]?.role === 'kid'
      ? 'You’ll hear here when a parent checks your chores.'
      : 'New card purchases and finished chores will show up here.',
    tag: 'test',
  });
  if (!sent) return reply({ error: 'The phone’s notification service turned it away. Try turning notifications off and on.' }, 502);
  return reply({ sent });
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    if (body.test && typeof body.endpoint === 'string') return await sendTest(req, body.endpoint);
    const importId = Number(body.import_id);
    if (Number.isInteger(importId) && importId > 0) return await announcePurchase(importId);
    const taskId = Number(body.chore_task_id);
    if (Number.isInteger(taskId) && taskId > 0) return await announceChore(taskId);
    const ledgerId = Number(body.ledger_id);
    if (Number.isInteger(ledgerId) && ledgerId > 0) return await announceBonus(ledgerId);
    return reply({ error: 'Nothing to do' }, 400);
  } catch (err) {
    console.error(err);
    return reply({ error: 'Something went wrong' }, 500);
  }
});

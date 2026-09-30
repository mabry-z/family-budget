# Phone notifications for card purchases

## How it works

1. A card purchase reaches Cadence through the Gmail script (see
   `card-imports-plan.md`) and is saved in `card_imports`.
2. A trigger on `card_imports` (migration 009) calls the Supabase Edge
   Function **notify-purchase** with the new purchase's id.
3. The function sends a notification to every phone in the household that
   turned notifications on (both people get every purchase):
   **"Target · $42"** / **"Chase · Tap to review"**. An alert Cadence can't
   read says "Couldn't read a Chase alert" / "Tap to check it".
4. Tapping it opens Cadence on that purchase, ready to pick a category.
   Nothing counts until someone adds it, same as before.

Each purchase is announced once (`card_imports.notified_at`), and only
while it's still pending and less than 15 minutes old. The function's URL
is public, so it trusts nothing but the purchase id.

**Settings → Notifications** (per phone): "Turn on notifications" asks the
phone for permission, saves the phone in `push_subscriptions` and sends a
first test. Once on, a card says "On for this phone" with **Send a test**
and **Turn off**. Signing out turns it off for that phone. On iPhone it only
works from the home-screen icon (iOS 16.4+); in Safari the section says so.

## Pieces

- `sw.js` — the service worker: shows the notification, and a tap opens
  Cadence (`?review=<id>`, or a message to an already-open Cadence). No
  fetch handler and no caching, so updates load as before.
- `js/notifications.js` — permission, subscribe/unsubscribe, test.
  `js/ui/notifications.js` — the Settings section.
- `js/config.js` — `VAPID_PUBLIC_KEY`, the public half of the signing key.
- `supabase/migrations/009_purchase_notifications.sql` — `push_subscriptions`
  (each person sees only their own phones), `card_imports.notified_at`, the
  trigger (uses `pg_net`).
- `supabase/functions/notify-purchase/index.ts` — the sender. Pasted into
  the dashboard by hand. Secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
  (the private half exists only there). "Verify JWT" must be off.

## Setup (one time, in this order)

1. **Database**: run migration 009 in the SQL Editor.
2. **Sender**: Edge Functions → Deploy a new function → Via Editor, name
   `notify-purchase`, paste the function, Deploy. In its settings, turn off
   "Verify JWT". Edge Functions → Secrets: add `VAPID_PUBLIC_KEY` (the value
   in `js/config.js`) and `VAPID_PRIVATE_KEY`.
3. **App**: commit and push.
4. **Each phone**: open Cadence from the home-screen icon → Settings →
   Turn on notifications → Allow.

## Later

Other notifications (payday question, bills due, over budget) can use the
same phones and sender; timed ones would need a scheduled job.

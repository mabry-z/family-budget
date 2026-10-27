# Plan: Chores

Status (2026-10-27): **live.** Kid accounts created, migration 013 run,
notify-purchase v4 deployed, app pushed. Checked signed in as Luke: no
budget rows, tables, views or members visible; parents unchanged. Left:
step 5 of "Setup" on each iPad. Read `CLAUDE.md` first. Owner's answers are at
the end.

## Goals

1. A **Chores** tab for parents (owner + member): add chores, assign each to
   a kid with a dollar amount, one-time or repeating.
2. Kids sign in on their own iPads and see **only their own** chores, total
   and savings goal — never the budget, never each other.
3. Kid taps **Done** → both parents get a notification → either parent
   **Approves** (amount added to the kid's total) or **Sends back** (with an
   optional note).
4. Each kid has a **running balance** that never resets with pay periods;
   it only goes down when a parent records a **Pay out**.
5. Kids set their own **savings goal** (name + amount) and see progress.
6. Chores and kid money are **separate from the budget**: nothing here
   touches categories, Extra, carry-over, Insights or Summary.

## People and sign-in

- New role **kid** in `household_members` (alongside owner | member), plus a
  `display_name` (e.g. "Ava") used everywhere in Chores.
- Kids sign in with a **name and a 6-digit PIN** instead of an email.
  Behind the scenes each kid is a normal Supabase account with a made-up
  email, `<name>@kids.cadence.invalid` (`.invalid` can never be a real
  address); the sign-in screen has "Kids: sign in with your name", and the
  iPad remembers that choice. (6 digits because Supabase's minimum password
  length is 6.)
- Accounts are created by the owner in the Supabase dashboard, exactly like
  Lydia's (sign-ups stay off), then added to the household by migration.
- iPads stay signed in, same as the phones.

## Security (the important part)

Today every budget table lets **any** household member read and write it.
A kid account would therefore be able to read the budget through the API
even if the app hid the screens. So:

- New helper `is_parent()` — true when the signed-in person is owner or
  member of their household.
- Every budget table's "household members" policy and every budget
  function (`ensure_period`, `save_settings`, `start_period`, imports,
  bills, `household_info`, …) additionally requires `is_parent()`.
  Parents notice no difference, so the live app keeps working.
- Chore tables: kids can read only rows assigned to them; they **cannot**
  write tables directly. Everything a kid does goes through functions that
  check the rules (a kid can only mark their *own open* chore done, and can
  only edit their own goal). Approvals, pay-outs and chore setup are
  parent-only functions.
- Read-only check afterwards (by the owner, signed in as a kid): budget
  tables return nothing; the other kid's chores and balance return nothing.

## Data model (migration 013)

- `chores` — the chore itself: `title`, `amount` (whole dollars),
  `kid_id`, `repeat` (none | daily | weekly), `weekdays` (for weekly, e.g.
  Mon/Thu), `active`, `created_by`.
- `chore_tasks` — each time a chore is due: `chore_id`, `kid_id`, `due_on`,
  `status` (open | done | approved | sent_back | expired), `done_at`,
  `reviewed_by`, `reviewed_at`, `note`, and the `amount` copied at the time
  (so changing a chore's price later doesn't change past earnings).
- `kid_ledger` — every money movement: `kid_id`, `amount` (+ earned,
  − paid out), `kind` (chore | payout | bonus), `task_id`, `created_by`,
  `created_at`. **Balance = sum of the ledger**, never stored (same idea as
  Extra).
- `kid_goals` — one active goal per kid: `name`, `target`, `created_at`,
  `reached_at`.

Functions: `ensure_chore_tasks()` (creates today's/this week's tasks for
repeating chores the first time anyone opens Chores — no scheduled job
needed), `mark_chore_done(task)`, `undo_chore_done(task)` (kid, before
review), `review_chore(task, approve, note)`, `pay_out(kid, amount)`,
`add_bonus(kid, amount, note)`, `set_goal(name, target)`, `clear_goal()`,
`chores_info()` (kids, balances, pending count for the tab badge).

## Rules

- Whole dollars only.
- One-time chores stay open until done (or a parent deletes them).
- Daily chores: one task per day. Weekly: one task per chosen weekday (or
  one per week, due by Sunday, if no day is picked). A repeating task not
  done by the end of its day/week quietly becomes **expired — no money
  comes off**; it just doesn't pay.
- Done → waiting for a parent. Either parent can approve; the first one
  wins, and the other's notification just opens an already-reviewed chore.
- Sent back → open again, showing the parent's note.
- Approved → amount added to the kid's balance immediately.
- Pay out: a parent enters an amount (default = full balance, can be less);
  it can't take the balance below $0.
- Goal: the kid types a name and amount. Progress = balance ÷ target. When
  the balance reaches it, the kid sees "You did it!" and parents see the
  goal reached on that kid's card. Paying out doesn't erase the goal; the
  kid clears or changes it.
- Nothing in Chores affects the budget.

## Notifications

Reuse the phones/iPads in `push_subscriptions` and the same sender
(generalised from notify-purchase, or a second Edge Function
`notify-chore`):

- To both parents: "Ava finished Unload dishwasher · $2" → opens the review.
- To the kid: "Approved! +$2" or "Sent back: Unload dishwasher" (+ note).
- Kids turn notifications on in their small Settings sheet (iPadOS 16.4+,
  from the home-screen icon — same as iPhone).

## App changes

Parent:
- Fifth tab **Chores** (period bar hidden, like Insights; the + button adds
  a chore here instead of an expense). Badge with the number waiting.
- Sections: **Waiting for you** (Approve / Send back), **Kids** (balance,
  goal progress, Pay out, Bonus, history), **Chores** (by kid, tap to
  edit, repeating ones marked).
- Add/edit chore sheet: title, kid, amount, repeat (once / daily / weekly
  + weekdays).

Kid:
- After sign-in the app opens straight to their own screen: greeting,
  balance, goal, and their chores (To do / Checking / Done today). No tab
  bar, no + button, no period bar, no budget anywhere.
- Small settings: notifications, appearance, sign out (and change PIN).
- **iPad layout**: the app is phone-width (430px) today. In kid mode the
  page widens on iPad: balance + goal on the left, chores on the right,
  with big tap targets. Parents' screens stay as they are (they'd work on
  an iPad, just phone-width).

## Rollout (no downtime)

1. Owner creates the two kid accounts in the Supabase dashboard.
2. Owner runs **013_chores.sql** (adds kids to the household, new tables
   and functions, and the parent-only checks on budget tables — invisible
   to the current app).
3. Build the app; owner tests on localhost as a parent and as a kid.
4. Owner deploys the notification sender change.
5. Commit and push (only when the owner says so). Kids sign in on their
   iPads and add Cadence to the home screen.

## Setup (one time, in this order)

1. **Kid accounts**: Supabase → Authentication → Users → Add user → Create
   new user. Email `luke@kids.cadence.invalid`, password = Luke's 6-digit
   PIN, tick "Auto Confirm User". Same for `adeline@kids.cadence.invalid`.
2. **Database**: SQL Editor → paste `013_chores.sql` → Run.
3. **Sender**: Edge Functions → notify-purchase → Code → paste the new
   `supabase/functions/notify-purchase/index.ts` → Deploy. (Done
   2026-10-27, version 4, Verify JWT still off.) (Do this before
   the kids turn on notifications: the old version would send them card
   purchases.)
4. **App**: test on localhost, then commit and push.
5. **Each iPad**: Safari → Cadence → Share → Add to Home Screen → open the
   icon → "Kids: sign in with your name" → name + PIN → Settings → Turn on
   notifications.

## Owner's answers (2026-10-27)

1. Two kids (8 and 10), each with their own iPad → optimise kid view for
   iPad.
2. Pay-outs stay **separate** from the budget; kids' purchases are normal
   budget expenses as today.
3. Both one-time and repeating chores; a missed chore never takes money off.
4. Either parent can approve; kids see only their own chores and total.
5. Running balance until paid out — no reset with pay periods.
6. Kids can set their own savings goal.
7. Kids: **Luke** and **Adeline**.
8. A parent can mark a chore done for a kid (it's approved straight away).
9. A **Bonus** button for money outside of chores.
10. A chore can be for **Anyone**: it shows on both kids' lists until one
    of them marks it done; that kid claims it (and its money).

## Cents (migration 014)

Chore amounts, bonuses, pay-outs and balances are dollars and cents
(`numeric(8,2)`), e.g. $0.50. Shown as "$2" when whole, "$0.50" otherwise.
The budget and savings goals stay whole dollars.

## "Anyone" chores

- `chores.kid_id` is null. Each task starts with no kid and shows on every
  kid's list ("Up for grabs").
- The first kid to tap Done claims it (`kid_id` set, then the usual review);
  the other kid's Done says someone else already did it, and it leaves
  their list.
- "Not done yet?" hands it back to everyone — unless a parent had sent it
  back, in which case it stays with that kid to fix.
- A parent marking it done for a kid picks which kid did it.

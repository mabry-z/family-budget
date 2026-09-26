# Plan: accounts and households

Status (2026-09-26): **approved; 004 run; sign-in app built on `redesign`
(not pushed); 005 written, not run.** Next: owner tests locally, push, 005. Read
`CLAUDE.md` first for how the app works and the owner's rules. The owner's
answers to the original questions are at the end of this file.

Done so far (2026-09-26, by the owner in the Supabase dashboard): Email
sign-in on, "Allow new users to sign up" **off**, Site URL and redirect URLs
set (the Pages URL and http://localhost:8000), and both accounts created and
confirmed: mabryz@gmail.com (owner) and mabrylh@gmail.com.

## Goals

1. Only signed-in people can see or change a budget.
2. Each budget belongs to a **household**; members see only their own
   household's data — enforced by the database, not just the app.
3. Sign in once per device and **stay signed in** (months), without
   re-entering anything each visit.
4. The owner and the owner's wife share one household ("Mabry Household");
   other households can be added later without seeing each other.
5. All existing data moves into the owner's household with nothing lost.

## Why a PIN alone isn't enough

The Supabase URL and publishable key are in the page source, and today's
row-level-security policies let that key read and write every budget table.
A PIN screen in the app would only hide the UI. Isolation has to come from
Supabase Auth plus RLS policies keyed on the signed-in user.

## Scope of this piece of work

In: sign-in, households in the database, moving all data into Mabry
Household, locking the database to signed-in household members, a Household
section in Settings (name, members, change password, sign out).

Out (later, see "Before sharing with other households"): creating new
households or joining one from the app, invite codes, emailed password
resets, per-household pay schedules and cards, first-time setup.

## Rollout: two migrations, no downtime

Splitting the database work in two means the old live app keeps working
until the new one is pushed, and the owner can try the new app (locally,
signed in, on real data) before anything is locked down.

1. **Owner runs `004_households.sql`.** Additive: creates the household,
   adds both accounts, tags every row with it, and updates the functions.
   Access stays open, so the live app keeps working unchanged.
2. **Build the new app** (sign-in etc.). The owner signs in on
   http://localhost:8000 and tests it on the real data.
3. **Push the new app.** From now on both phones sign in once.
4. **Owner runs `005_lock_down.sql`.** Removes access for anyone not signed
   in and limits every table to the caller's household.
5. Read-only check: with the publishable key and no session, every table
   returns nothing. The owner checks both phones still work.

## Migration 004 — households (backwards compatible)

At the top: household name and the two emails. Stops with a clear error if
either account doesn't exist. Safe to re-run.

New tables:

- `households` — `id uuid pk default gen_random_uuid()`, `name` (unique),
  `created_at`.
- `household_members` — `household_id`, `user_id` (→ `auth.users`, on
  delete cascade), `role` ('owner' | 'member'), pk (`household_id`,
  `user_id`), unique `user_id` (one household per user for now).

Helper:

- `current_household_id()` — `security definer`, `stable`: the household of
  `auth.uid()`. **Temporary fallback in 004 only:** when nobody is signed in
  (the old app), it returns the single existing household, so the old app's
  writes land in Mabry Household. 005 removes the fallback.

Columns: `household_id uuid not null default current_household_id()
references households` on `budget_defaults`, `categories`,
`fixed_cost_templates`, `pay_periods`, `period_categories`, `expenses`,
`fixed_costs` (added, filled with Mabry Household, then made not null). The
default means neither app has to pass it.

Constraints:

- `pay_periods`: unique (`household_id`, `year`, `month`, `start_day`)
  instead of (`year`, `month`, `start_day`).
- `categories_single_remainder`: one Extra per household.
- `budget_defaults`: one row per household (`household_id` becomes the key;
  the old `id = 1` column is dropped).
- `expenses_card_check` stays global for now.

Functions updated — each also filters by `current_household_id()`
explicitly (belt and braces on top of RLS) and raises "This account isn't
part of a household yet." if there is none:

- `ensure_period`, `save_settings`, `start_period`; `on conflict` targets
  include `household_id`.
- `expenses_link_category` trigger — looks up categories within
  `new.household_id`.
- `period_extra_carry` view — joins `budget_defaults` on `household_id`,
  running sum `partition by household_id`.

New function: `household_info()` (`security definer`) — the caller's
household name, their role, and the members' emails (emails live in
`auth.users`, which the app can't read directly).

Access in 004: the new tables get policies for signed-in members only
(read your own household). The budget tables get their final "household
members" policy for signed-in users, but the existing open policies stay
and RLS isn't switched on for any table that lacks it yet (it may be off on
`expenses`/`fixed_costs`), so the live app keeps working.

## Migration 005 — lock down

- `current_household_id()` without the fallback (not signed in → null).
- Drop every existing policy on the budget tables (including whatever the
  original app set on `expenses` and `fixed_costs`).
- On each budget table: `for all to authenticated using (household_id =
  current_household_id()) with check (household_id =
  current_household_id())`.
- Revoke table and function access from `anon`.
- `budget_settings` (old, unused): RLS on with no policies, so nothing can
  reach it through the API. Dropped in the later cleanup.

## App changes

- `js/auth.js` — session start-up, `onAuthStateChange`, sign-in, sign-out,
  change password. supabase-js keeps the session in localStorage and
  refreshes it automatically, so people stay signed in until they sign out
  or clear site data.
- Sign-in screen in the Cadence style (email, password, Sign in), shown
  instead of the app when there's no session. "Forgot password?" explains
  that the owner resets it (see below).
- Signed in but in no household: a short message and a Sign out button.
- Settings → **Household** section: household name, members' emails,
  **Change password**, **Sign out**.
- `app.js` start-up waits for the session before loading; signing out clears
  the screen and shows sign-in. Refresh-on-return keeps working.
- Nothing else in the budget screens changes — the database filters by
  household automatically.

Forgotten passwords: Supabase's built-in email sender only delivers to the
Supabase project's team members, so emailed resets wait for custom SMTP
(needed before other households anyway). Until then the owner resets a
password in the Supabase dashboard (Authentication → Users), and anyone
signed in can change their own password in Settings.

## Before sharing with other households

These assume the owner's setup and would need to become per-household
settings (separate, later pieces of work — the owner wants to discuss them
first):

- **Creating and joining households** — `create_household(name)` (seeds
  defaults and categories), invite codes (`household_invites`: code,
  household, created_by, expires in 7 days, used_by/used_at), turning
  sign-ups back on.
- **First-time setup** — a guided, tutorial-style walkthrough explaining how
  the app works, and possibly different default amounts for new households.
- **Pay schedule** — paydays are hard-coded to the 1st and 15th with the
  weekend/federal-holiday rule. Others may be paid biweekly, weekly or
  monthly, which changes how periods are identified. Biggest item.
- **Cards** — the card list is global (`js/config.js` + a database
  constraint). Needs a per-household `cards` table editable in Settings.
- **Custom SMTP** (e.g. Resend) for sign-up confirmation and password-reset
  emails.

## Owner's answers (2026-09-26)

1. Household name: **Mabry Household**.
2. Sign-in: **email + password**.
3. Accounts: **mabryz@gmail.com** (owner), **mabrylh@gmail.com** (member).
4. Old-tables cleanup (drop `budget_settings`, stop writing
   `expenses.category`): **separate**, later.
5. Other households: **wait**. Build accounts for the two of them first;
   the "Before sharing" items come later, after discussion.

# Plan: accounts and households

Status: **planned, not built.** Read `CLAUDE.md` first for how the app works
and the owner's rules. Get the open questions below answered before building.

## Goals

1. Only signed-in people can see or change a budget.
2. Each budget belongs to a **household**; members see only their own
   household's data — enforced by the database, not just the app.
3. Sign in once per device and **stay signed in** (months), without
   re-entering anything each visit.
4. The owner and the owner's wife share one household; other households can be
   added later without seeing each other.
5. All existing data moves into the owner's household with nothing lost.

## Why a PIN alone isn't enough

The Supabase URL and publishable key are in the page source, and today's
row-level-security policies let that key read and write every budget table.
A PIN screen in the app would only hide the UI. Isolation has to come from
Supabase Auth plus RLS policies keyed on the signed-in user.

## Sign-in

- Supabase Auth, **email + password** (recommended). supabase-js keeps the
  session in localStorage and refreshes it automatically, so people stay
  signed in until they sign out or clear site data.
- Magic links (emailed one-time links) are the alternative; they need email
  every sign-in.
- Supabase's built-in email sender only delivers to the project's own team
  members and is heavily rate-limited. For the owner and the owner's wife, create
  both accounts in the Supabase dashboard (Authentication → Users → Add
  user, with a password) — no email needed. **Before other households sign
  up**, connect a custom SMTP provider (e.g. Resend) in Supabase settings for
  sign-up confirmation and password-reset emails.
- An optional quick-unlock PIN on top of a signed-in session can come later;
  it's a convenience, not security.

## Database changes (migration 004)

New tables:

- `households` — `id uuid pk default gen_random_uuid()`, `name`, `created_at`.
- `household_members` — `household_id`, `user_id` (→ `auth.users`),
  `role` ('owner' | 'member'), pk (`household_id`, `user_id`).
  One household per user for now.
- `household_invites` — `code` (short random text, pk), `household_id`,
  `created_by`, `expires_at` (7 days), `used_by`, `used_at`.

Helper:

- `current_household_id()` — `security definer`, `stable`: the household of
  `auth.uid()`. Used in column defaults and RLS policies.

Add `household_id uuid not null default current_household_id()` to:
`categories`, `fixed_cost_templates`, `pay_periods`, `period_categories`,
`expenses`, `fixed_costs`. The default means the app's inserts don't need to
pass it.

Constraint changes:

- `pay_periods`: unique (`household_id`, `year`, `month`, `start_day`)
  instead of (`year`, `month`, `start_day`).
- `categories_single_remainder`: unique per household.
- `budget_defaults`: key by `household_id` instead of `id = 1`
  (`starting_amount`, `carry_start` per household).
- `expenses_card_check` stays global for now (see open questions).

Row-level security:

- Drop the current `"app access"` policies (anon + authenticated, `true`).
- On every budget table (including `expenses`, `fixed_costs`,
  `budget_defaults`, and the three new tables):
  `for all to authenticated using (household_id = current_household_id())
  with check (household_id = current_household_id())`.
  Members/invites get narrower policies (read your own household's rows).
- Revoke table access from `anon`.
- The `period_extra_carry` view is `security_invoker`, so it inherits the
  policies; its `budget_defaults` join must match on `household_id` and the
  running sum must be `partition by household_id`.

Functions to update (all scope to `current_household_id()`, and raise a clear
error if the caller has no household):

- `ensure_period`, `save_settings`, `start_period` — every lookup of
  `pay_periods`, `categories`, `fixed_cost_templates`, `budget_defaults`,
  `fixed_costs`, `expenses` filters by household; `on conflict` targets
  include `household_id`.
- `expenses_link_category` trigger — look up categories within
  `new.household_id`.

New functions (`security definer`, granted to `authenticated`):

- `create_household(name)` — creates the household, makes the caller its
  owner, seeds `budget_defaults` (3500, carry from the first period) and the
  default categories (Gas 250, Groceries 450, Eat Out 100, Extra). No fixed
  costs.
- `create_invite()` — owner only; returns a code valid 7 days.
- `join_household(code)` — adds the caller as a member and marks the code
  used.

## Moving the existing data

Order matters, because the moment the new policies apply, the currently
deployed app (which has no sign-in) stops working:

1. **Owner, in the Supabase dashboard:** enable Email sign-in; set the Site
   URL / redirect URL to https://mabry-z.github.io/family-budget/; create
   both accounts (owner + wife) with passwords.
2. **Build the new app with sign-in first** and keep it unpushed. It can't
   be tested against real data until step 3 (there's no separate test
   database), so review it carefully and check the pure pieces locally.
3. **Owner runs migration 004.** At the top it has the household name and
   the two account emails. It creates the household, adds both as members,
   sets `household_id` on every existing row, then switches the policies.
   From here the old live app shows errors.
4. **Immediately push the new app.** Downtime is the minute or two Pages
   takes to deploy.
5. Read-only checks: with the publishable key and no session, every table
   must return nothing (proves the lock-down). Owner signs in on both phones
   and checks the numbers match.

## App changes

- `js/auth.js` — session start-up, `onAuthStateChange`, sign-out.
- Sign-in screen in the Cadence style: email, password, "Forgot password?".
  Shown instead of the app when there's no session.
- After sign-in, if the user has no household: "Create a household" or
  "Join with an invite code".
- Settings → new **Household** section: household name, members,
  "Invite someone" (shows a code to share), **Sign out**.
- `app.js` start-up waits for the session before loading; refresh-on-return
  keeps working (supabase-js refreshes the token).
- Nothing else in the budget screens changes — the database filters by
  household automatically.

## Before sharing with other households

These assume the owner's setup and would need to become per-household
settings (separate, later pieces of work):

- **Pay schedule** — paydays are hard-coded to the 1st and 15th with the
  weekend/federal-holiday rule. Others may be paid biweekly, weekly or
  monthly, which changes how periods are identified. Biggest item.
- **Cards** — the card list is global (`js/config.js` + a database
  constraint). Needs a per-household `cards` table editable in Settings.
- **Custom SMTP** for sign-up and password-reset emails (see Sign-in).
- Default categories for new households.

## Open questions for the owner

1. Household name (e.g. "Mabry household")?
2. Email + password sign-in, or magic links?
3. The wife's email address for her account (to put in migration 004).
4. Fold the old-tables cleanup (drop `budget_settings`, stop writing
   `expenses.category`) into 004, or keep it separate?
5. Is sharing with other households soon enough that the pay-schedule and
   cards work should be planned now, or after accounts ship?

## Rough size

- Accounts + household for the owner and the owner's wife (everything above except
  "Before sharing"): about the size of the original Cadence redesign — one
  big migration, sign-in/household UI, careful testing.
- Each "Before sharing" item is its own medium piece of work.

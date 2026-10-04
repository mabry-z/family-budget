# Cadence — family budget app

Static HTML/CSS/JS (ES modules, no build step) served by GitHub Pages from
`main` at https://mabry-z.github.io/family-budget/, with a Supabase
(Postgres) backend. Mobile-first (max width 430px), dark "glass" design.

## Files

- `index.html` — markup and empty containers; all content is rendered by JS.
- `manifest.json`, `icons/` — home-screen name and icon (the C monogram;
  PNGs drawn with a PowerShell System.Drawing script, no image tools here).
- `css/cadence.css` — colour tokens for dark (`:root`) and light
  (`:root[data-theme="light"]`), the Cadence design, then "App additions".
  Use tokens only — no colour literals outside those two blocks.
- `js/config.js` — Supabase URL/publishable key, the card list, category colours.
- `js/supabase.js` — client. `js/data.js` — every Supabase read/write/RPC.
- `js/budget.js` — pure budget math and period helpers (no DOM, no Supabase).
- `js/paydays.js` — pure date helpers, federal holidays, payday rule.
- `js/merchants.js` — pure store-name grouping (Insights) and suggestions
  (expense sheet).
- `js/notifications.js` — phone notifications: permission, subscribe,
  test (with `sw.js`, the service worker at the root: push + tap only, no
  caching).
- `js/auth.js` — Supabase Auth: session, sign in/out, change password.
- `js/theme.js` — light/dark: a plain script in `<head>` (runs before the
  page draws) that sets `<html data-theme>` from this phone's choice
  (Auto / Light / Dark, default Dark) kept in localStorage.
- `js/app.js` — sign-in gate, state, loading, period navigation, tabs, wiring.
- `js/ui/*.js` — one module per screen/sheet (overview, bills, insights,
  summary, expense-sheet, settings-sheet, stores-sheet, payday-sheet,
  sign-in, household, appearance, imports, notifications)
  plus `dom.js` helpers.
- `supabase/migrations/NNN_*.sql` — run by hand, in order (see Workflow).
- `dev/serve.ps1` — local static server (http://localhost:8000).
- `docs/households-plan.md` — plan and rollout for accounts + households.
- `docs/insights-plan.md` — the Insights tab (replaced Trends) and its rules.
- `docs/card-imports-plan.md` — card alert emails → Cadence, "Paid from
  savings", and the one-time setup steps.
- `docs/notifications-plan.md` — card purchase notifications and setup.
- `supabase/functions/notify-purchase/index.ts` — Edge Function that sends
  them; pasted into the dashboard by hand (Verify JWT off; secrets
  `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`).
- `gmail-script/cadence-alerts.gs` — Google Apps Script (runs in the owner's
  Google account, pasted in by hand) that reads card alert emails;
  `test-readers.cjs` tests its readers (needs Node).

## Data model (Supabase, schema `public`)

- Sign-in is Supabase Auth, email + password; sign-ups are off (accounts are
  added in the dashboard). `households` + `household_members` (role owner |
  member, one household per user). Every budget table has `household_id`
  defaulting to `current_household_id()`, and RLS policy "household
  members" limits rows to it. `household_info()` feeds Settings → Household.
  Only household: **Mabry Household** (mabryz@gmail.com owner,
  mabrylh@gmail.com member).
- A pay period is identified everywhere by `(year, month, start_day)`.
  `start_day` is 1 or 16 and is only a label: **16 means "the mid-month
  paycheck", whose normal start is the 15th.** Normal ranges are 1st–14th
  and 15th–end of month.
- `pay_periods` — one row per period; `start_date` is generated from the
  label (used for ordering and "this period onward"); `starts_on` is the real
  start (payday), null until confirmed; `starting_amount`.
- `budget_defaults` — one row per household: default `starting_amount`
  (3500 originally), `carry_start` (2026-09-16 — moved from the Oct 1 default so the Sep 15 period carries),
  `overage_start` (2026-10-01 — migration 011; null = overages off).
- `categories` — defaults (`default_amount`, `color`, `sort_order`,
  `is_active` = archived when false). Exactly one row has
  `is_remainder = true`: **Extra**.
- `period_categories` — per-period snapshot of category amounts, plus
  `emptied` ("moved leftover to Extra").
- `fixed_cost_templates` — defaults per `half` (1 or 16).
  `fixed_costs` — per-period rows (`is_paid`, `template_id`).
- `expenses` — `category_id` plus legacy `category` text (a trigger keeps
  `category_id` in step when only the name is written). `card` must be one
  of the values in the `expenses_card_check` constraint (see migration 002).
- `hidden_merchants` — stores hidden from the expense sheet's suggestions
  (`merchant_key` = `merchantKey()` in `js/merchants.js`). Migration 006.
- `card_imports` — purchases read from card alert emails (Chase, Military
  Star — Star has no store, `merchant` null until reviewed, migration 010); `status`
  pending | added | dismissed (Ignore) | bill. Written only by `import_card_alert(p_key,
  p_alert)` (anon may call it; it needs the household's import key, kept
  hashed in `card_import_keys`; `new_card_import_key()` is for the SQL
  editor only). `household_members.cardholder_name` maps the name on an
  alert to a person. Migration 008.
- Bills paid on a card: `pay_bill_from_import()` ticks the bill, sets that
  period's `fixed_costs.amount` to the charge, sets `paid_by_import_id`
  and remembers the store in `bill_merchants` (→ template, or bill name).
  Matching is `matchBill()` in `js/merchants.js`.
- `expenses.from_savings` — paid from savings: shown, never counted.
  `expenses.card_import_id` — the alert it came from (unique).
- `push_subscriptions` — phones with notifications on (own rows only).
  `card_imports.notified_at` — announced once. A trigger on `card_imports`
  calls notify-purchase via `pg_net`. Migration 009.
- `period_extra_carry` (view) — Extra carried into each period (ignores
  savings purchases; takes off overages from `overage_start` on, 011).
- Functions: `ensure_period` (creates a period from defaults the first time
  it's opened), `save_settings`, `start_period`.
- `budget_settings` is the old app's table — no longer used.

## Rules the app must keep

- Whole dollars only — never cents.
- **Extra is never stored**: starting − fixed costs − other categories'
  (effective) budgets + carry-in. An emptied category's budget is what it
  spent (clamped to 0..amount); the rest goes to that period's Extra.
- Extra's leftover carries into the next period, **negative too**, from
  `carry_start` (Sep 16, 2026 — the Sep 15 period) on. Calculated live, never stored.
- **Overages come out of Extra** (periods from `overage_start` on): what a
  category spends past its (effective) budget shows as one automatic
  "<name> overage" entry in Extra per category per period (updates as
  spending changes; tapping it opens the category). The category still
  shows "$X over". Overages aren't spending: Insights and "Spent so far"
  leave them out; they lower Extra's leftover and so the carry-in, which
  goes negative when Extra runs out. Calculated live in `buildBudget`
  (`coverOverages`) and in the view — never stored.
- Settings saved on the current or a future period change the defaults, that
  period and every later existing period — never earlier ones. Saved on a
  past period: only that period changes (category names locked there).
- Removing a category that has expenses in the affected periods is blocked
  ("move or delete them first").
- Payday: the 1st and 15th; on a weekend or federal holiday it's the
  business day before. The bank often deposits 1–2 days early, so the app
  **asks every period** ("Has your … pay arrived?"), starting 3 days before
  the expected payday; "Not yet" snoozes until the next day.
- Expenses stay in the period they were added to; changing a start date
  doesn't move them.
- Insights counts by **pay period**, never calendar month, and counts
  expenses only (never moved or carried money). Its per-period numbers come
  from `buildBudget`, so they always match the Overview. The scorecard
  judges each category against its **original** amount (emptied ones too);
  "within $10" and not over = amber.
- Store suggestions: a store is suggested once used twice, or used in the
  last 30 days; hidden stores never are. Hiding only affects suggestions
  (never expenses or Insights). Manage in Settings → Store suggestions.
- Header: C monogram + tab name ("Cadence" on Overview) in the wordmark
  font; the period bar is hidden on Insights.
- **Savings purchases never count**: not in category cards, Extra,
  carry-over, "Spent so far" or Insights. They do show in Recent activity,
  Summary ("Paid from savings · not counted") and Card spending.
- Card alert purchases count only once reviewed and added; they go into the
  period the purchase happened in, with the cardholder's dot.
- Notifications: every phone that turned them on gets every card purchase,
  once ("Target · $42" / "Chase · Tap to review"); tapping opens its review.
- Cards: Chase, AMEX, Star Card (label "Star"), USAA, Other. Adding one means
  updating `js/config.js` and the `expenses_card_check` constraint.

## Workflow (the owner's preferences)

- **Plan first** for anything sizeable; wait for approval before building.
- **Read-only checks only** against the live Supabase data. Since 005 the
  publishable key alone gets "permission denied" everywhere (that's the
  check that the lock-down holds); real data is only visible signed in, and
  only the owner signs in. Never save, delete or create real data while
  testing — the owner tests anything that writes. Browsing to a period that
  doesn't exist yet creates it, so stay on existing periods.
- **Migrations are run by the owner** in the Supabase SQL editor. Write them
  to `supabase/migrations/NNN_name.sql` (next number: **012**), make them
  safe to re-run, put the file on the clipboard
  (`Get-Content -Raw -Encoding UTF8 <file> | Set-Clipboard` — without
  `-Encoding UTF8`, Windows PowerShell garbles "·", "’", "—" into "Â·" etc.) and give short click-by-click
  steps. Use "Run and enable RLS" if Supabase asks.
- The live site and the database are shared, so schema changes must keep
  the currently deployed code working until the new code is pushed.
- Commit and push only when asked. Commit with
  `git -c user.name="mabry-z" -c user.email="mabryz@gmail.com" commit ...`
  (no global git identity on this PC). Work on `redesign`, fast-forward
  `main` to it, push both; Pages deploys `main` in about a minute.
- This PC has no Python or Node. Local testing:
  `powershell -ExecutionPolicy Bypass -File dev/serve.ps1`, or the
  `cadence` entry in `.claude/launch.json`.
- Explain things in plain language; the owner isn't a developer.

## Open items

- Cleanup (after households): drop `budget_settings`, and stop writing the
  legacy `expenses.category` text.
- Before other households: see "Before sharing" in the plan.

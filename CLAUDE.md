# Cadence — family budget app

Static HTML/CSS/JS (ES modules, no build step) served by GitHub Pages from
`main` at https://mabry-z.github.io/family-budget/, with a Supabase
(Postgres) backend. Mobile-first (max width 430px), dark "glass" design.

## Files

- `index.html` — markup and empty containers; all content is rendered by JS.
- `css/cadence.css` — the Cadence design, then an "App additions" section.
- `js/config.js` — Supabase URL/publishable key, the card list, category colours.
- `js/supabase.js` — client. `js/data.js` — every Supabase read/write/RPC.
- `js/budget.js` — pure budget math and period helpers (no DOM, no Supabase).
- `js/paydays.js` — pure date helpers, federal holidays, payday rule.
- `js/app.js` — state, loading, period navigation, tabs, wiring.
- `js/ui/*.js` — one module per screen/sheet (overview, bills, trends,
  summary, expense-sheet, settings-sheet, payday-sheet) plus `dom.js` helpers.
- `supabase/migrations/NNN_*.sql` — run by hand, in order (see Workflow).
- `dev/serve.ps1` — local static server (http://localhost:8000).
- `docs/households-plan.md` — plan for accounts + households (not built yet).

## Data model (Supabase, schema `public`)

- A pay period is identified everywhere by `(year, month, start_day)`.
  `start_day` is 1 or 16 and is only a label: **16 means "the mid-month
  paycheck", whose normal start is the 15th.** Normal ranges are 1st–14th
  and 15th–end of month.
- `pay_periods` — one row per period; `start_date` is generated from the
  label (used for ordering and "this period onward"); `starts_on` is the real
  start (payday), null until confirmed; `starting_amount`.
- `budget_defaults` — single row (id = 1): default `starting_amount`
  (3500 originally), `carry_start` (2026-10-01).
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
- `period_extra_carry` (view) — Extra carried into each period.
- Functions: `ensure_period` (creates a period from defaults the first time
  it's opened), `save_settings`, `start_period`.
- `budget_settings` is the old app's table — no longer used.

## Rules the app must keep

- Whole dollars only — never cents.
- **Extra is never stored**: starting − fixed costs − other categories'
  (effective) budgets + carry-in. An emptied category's budget is what it
  spent (clamped to 0..amount); the rest goes to that period's Extra.
- Extra's leftover carries into the next period, **negative too**, from
  `carry_start` (Oct 1, 2026) on. Calculated live, never stored.
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
- Trends counts expenses only (never moved or carried money).
- Cards: Chase, AMEX, Star Card (label "Star"), USAA, Other. Adding one means
  updating `js/config.js` and the `expenses_card_check` constraint.

## Workflow (the owner's preferences)

- **Plan first** for anything sizeable; wait for approval before building.
- **Read-only checks only** against the live Supabase data (the anon key via
  curl or the browser). Never save, delete or create real data while
  testing — the owner tests anything that writes. Browsing to a period that
  doesn't exist yet creates it, so stay on existing periods.
- **Migrations are run by the owner** in the Supabase SQL editor. Write them
  to `supabase/migrations/NNN_name.sql` (next number: **004**), make them
  safe to re-run, put the file on the clipboard
  (`Get-Content -Raw <file> | Set-Clipboard`) and give short click-by-click
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

- `004`: accounts + households — see `docs/households-plan.md`.
- Cleanup (after households): drop `budget_settings`, and stop writing the
  legacy `expenses.category` text.
- Until households ship, the database policies allow the publishable key
  full access to the budget tables.

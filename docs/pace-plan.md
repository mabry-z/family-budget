# Plan: purchase dates + "When does the money go?"

Status (2026-10-14): **done and live.** Migration 012 (first written as 011;
renumbered because "overages" took 011) run by the owner. Owner's answers: ahead = red, behind =
green; tap-a-day included. Read
`CLAUDE.md` and `docs/insights-plan.md` first.

Two parts, built in this order:

1. **Purchase date** on the expense sheet (one migration, 012).
2. **"When does the money go?"** replaces "Are we coming out ahead?" on
   Insights (no database changes). It uses the purchase dates from part 1.

Mock-ups:
- Date field (option A, chosen): https://claude.ai/artifact/CpSrFgmFmnGxhmt5J5rqeQ
- Pace card (option A, chosen): https://claude.ai/artifact/HUsgcH3zdbKVoQE2XL5y9X

---

## Part 1: Purchase date

### What the owner asked for

A **Date** row at the bottom of the expense sheet, under Card, with three
chips: **Today**, **Yesterday**, **Pick a day**. "Pick a day" opens the
phone's calendar, and the chip then shows the chosen day ("Sat, Oct 10").
The Overview, Recent activity and Insights show this date instead of the
day the expense was typed in.

### Details

- **Starts on today.** Entering something the same day needs no extra tap.
- **Changed 2026-10-14 (owner):** a *new* expense may also be dated in the
  period before; it is then added to that period ("Goes in Sep 30 – Oct 13"
  under the chips, and a toast after saving). So "Yesterday" shows on payday.
  Editing still keeps an expense in its own period.
- **Only days in the expense's pay period** can be picked, from the
  period's start (payday) to its last day, never after today. Expenses stay
  in the period they were added to, as now.
  - A chip whose day is outside that range is hidden. For example, on
    payday "Yesterday" belongs to the previous period, so only Today and
    Pick a day show.
  - Adding to an **earlier** period (after browsing back): the date starts
    on that period's last day, and only "Pick a day" shows.
- **Card alerts**: the date is the purchase time on the alert, shown
  read-only ("Sat, Oct 10 · 6:42 PM", "From the Chase alert"). It is saved
  when the purchase is added.
- **Editing** an expense shows its saved date, and it can be changed within
  that expense's period. An expense that came from a card alert stays
  locked to the alert's date.
- **Expenses entered before this change** have no saved date. They keep
  showing the day they were entered, or the alert's date if they came from
  an alert. Nothing old is rewritten.
- **Order**: Overview lists and Recent activity sort newest purchase date
  first. Expenses on the same day sort by when they were entered.
- Dates are calendar days in the phone's own time zone. No times are shown
  for typed-in expenses.

### Migration 012 (`supabase/migrations/012_purchase_date.sql`)

- `alter table expenses add column if not exists spent_on date;`
  It allows blanks and has no default, so the code that's live now keeps
  working (its new expenses simply have no date, and fall back as above).
  Safe to re-run.
- No RLS or function changes.

### Build

- `js/data.js`: read `spent_on` and the linked alert's `occurred_at`
  wherever expenses are loaded (Overview and Insights). `spent_on` is saved
  with adds and edits.
- `js/budget.js` (pure): `purchaseDate(expense)` = `spent_on`, else the
  alert's date, else the day it was entered. Everything that shows or
  sorts by an expense's date uses it.
- `js/ui/expense-sheet.js` + `index.html`: the Date field (chips, plus a
  hidden phone date picker limited to the period's days), the read-only
  alert version, and the defaults above.
- `js/app.js`: give the sheet the period's first and last day, and save
  `spent_on`. For card alerts, save the alert's date.
- `js/ui/overview.js`: show and sort by `purchaseDate`.
  `js/ui/insights.js`: "Biggest purchase … on Oct 10" uses it too.
- `css/cadence.css`: reuses the existing chip and date-box styles.
- `CLAUDE.md`: `expenses.spent_on` in the data model; next migration 013.

---

## Part 2: "When does the money go?"

### What the owner asked for

Replace the middle Insights card with a pace line for the pay period:

- **Usual pace**: running total of spending through a pay period, averaged
  over the finished periods in the range (3 months, 6 months, YTD). Blue
  line, lightly shaded underneath.
- **This period**: the running total so far, as a solid line ending in a dot
  at today.
- **Even pace**: a dotted straight line from $0 to the usual total, for
  reference.
- **Headline**: "$110 behind your usual pace" (green) or "$80 ahead of your
  usual pace" (red), with "on day 9 · $710 spent so far" underneath.
- **Sentence**: "Half of the money usually goes by day 6."
- **Category chips**: All, then each category with spending in the range,
  then Extra, as on "Where does it go?". The chart, headline and sentence
  follow the chosen chip.

Card order stays: Where does it go? → **When does the money go?** → Did we
stay on budget?

### How the numbers are worked out

- **What counts**: the same spending as the rest of Insights. Expenses only,
  never bills, moved money or carry-over. Savings purchases never count.
  Refunds subtract. Each expense counts in the category the Overview puts it
  in (off-list categories land in Extra), using the `buildBudget` cards
  already built for the scorecard.
- **Which day of the period**: the purchase date (`purchaseDate`, part 1)
  minus the period's start date, plus one. The start date is the confirmed
  payday (`starts_on`), or the expected payday when it was never confirmed
  (older periods), using the same rule as the period bar. A purchase dated
  before its period started counts on day 1; one after it ended counts on
  the last day.
- **Period length**: from its start to the day before the next period's
  start (14–17 days). The chart runs to the longest finished period in the
  range. When averaging day 16 or 17, a shorter period counts with its final
  total, so the usual line flattens out instead of dropping.
- **Usual pace** = for each day, the average running total across the
  finished periods in the range. The current period is never part of
  "usual".
- **Ahead/behind** = this period's total so far minus the usual running
  total on today's day number. Within $10 either way: "Right on your usual
  pace" in plain ink.
- **"Half … by day N"** = the first day the usual line reaches half of the
  usual total.

### Edge cases

- No finished periods in the range yet: "Not enough history yet. Your usual
  pace appears after your first full pay period." This period's line is
  still drawn.
- A chosen category with no spending this period: the "this period" line
  stays flat at $0.
- Today past the usual line's last day (a long period): compare with the
  usual final total.
- "All" with no spending in the range: "No spending in this range yet."

### Build

- `js/budget.js` (pure): `dayOfPeriod(date, start)`,
  `paceLines(periods, categoryId)` → `{ usual: [...], now: [...], today }`,
  `halfwayDay(usual)`. Remove `extraLeftover`.
- `js/ui/insights.js`: `paceHtml()` replaces `aheadHtml()`. It draws the
  chart as inline SVG coloured with the theme tokens (works in light and
  dark), with its own category chips remembered separately from "Where does
  it go?". The carry and `carry_start` loads stay, because `buildBudget`
  still needs them for the scorecard.
- `js/app.js`: pass each period's real start date into Insights (the same
  logic as `startOf`).
- `css/cadence.css`: chart and legend styles using tokens only; remove the
  `.xbar*` and `.period-labels` styles.
- `CLAUDE.md` and `docs/insights-plan.md`: describe the new card and its
  rules.

---

## Rollout and testing

1. Owner runs migration 012 in the Supabase SQL editor (steps given then).
   The live site keeps working before the new code is pushed.
2. Test locally, signed in. **Read-only for me**; the owner tests anything
   that saves:
   - Add an expense with Yesterday and one with Pick a day. Check the
     Overview shows those dates and sorts them correctly.
   - On payday, check "Yesterday" isn't offered.
   - Review a card alert: the date is the alert's, and can't be changed.
   - Insights: for a couple of finished periods, the end of the "All" pace
     line equals that period's total spending on the Overview.
3. Commit and push only when asked.

## Owner's answers (2026-10-14)

1. Ahead of pace = **red**, behind = **green**: yes.
2. Tap-a-day on the pace chart: **include it**. Tapping marks the day and
   shows "Day 4: usual $505 · this period $480" (usual only for days not
   reached yet).

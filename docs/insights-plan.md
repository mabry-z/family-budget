# Plan: Insights tab (replaces Trends) + tab titles

Status (2026-09-26): **done and live.** Read
`CLAUDE.md` first. No database changes are needed.

## What the owner asked for

- Replace Trends with **Insights**, as in the mockup, with sections in this
  order:
  1. **Where does it go?** — category chips **including Extra**; for the
     chosen category: top merchants (total, trips, average per trip) and the
     biggest single purchase.
  2. **Are we coming out ahead?** — Extra left over each pay period (bars,
     red when negative) and the total built up since `carry_start`.
  3. **Did we stay on budget?** — one square per category per pay period:
     green under, amber within $10 of the budget, red over; plus one plain
     sentence naming the most notable pattern.
- Time ranges: **3 months, 6 months, YTD**. Counted in **pay periods**, not
  calendar months.
- Header: the **C monogram + the tab's name** ("Bills", "Insights",
  "Summary"). Overview keeps "Cadence".

## Details decided in the plan (owner to confirm)

- **Period bar hidden on Insights** — Insights covers many periods, so the
  ‹ period › selector would do nothing there. It stays on Overview, Bills
  and Summary.
- **Which periods count:** every existing pay period that starts within the
  range (last 3 or 6 months, or since Jan 1), up to and including the
  current one. The current period is marked "so far" (lighter bar, outlined
  square) because it isn't finished.
- **Extra left over** per period = that period's Extra − what it carried in
  − Extra spending: the same numbers the Overview shows, computed with
  `buildBudget` so the two can never disagree. Periods before Oct 1 still
  get a bar (they just didn't carry forward); the headline total is the
  carry-over built up since Oct 1.
- **Scorecard:** a category is judged against its **original** amount for
  that period (an emptied category would otherwise always look "on
  budget"). Amber = spent between budget − $10 and the budget. A category
  that didn't exist in a period shows an empty cell. Archived categories
  appear only for periods they were part of. With many periods (YTD late in
  the year, up to 24) the squares shrink to fit; no sideways scrolling.
- **Pattern sentence:** the category that went over most often, e.g. "Eat
  Out went over in 3 of 6 periods, by $34 on average." If nothing went
  over: "Every category stayed on budget."
- **Merchants:** grouped ignoring capitals and extra spaces ("ALDI" = "Aldi"),
  shown with the most-used spelling. Refunds reduce the total but don't
  count as trips. Top 5, then "+ N more places". Blank merchants show as
  "Unknown". Extra's merchants are expenses that landed in Extra.
- **Empty states:** e.g. "No spending in this range yet." Extra carry-over
  starts Oct 1, so the "coming out ahead" total starts at $0.

## Build

- `js/budget.js` (pure, no DOM): `periodsInRange`, per-period Extra
  leftover, scorecard statuses, merchant grouping, the pattern sentence.
  Remove `trendMonths` / `monthlyTotals`.
- `js/data.js`: load everything for the range in a few queries — pay periods
  (already loaded), all `period_extra_carry` rows, `period_categories` and
  `fixed_costs` for the range's periods, expenses since the range start
  (adds merchant and period fields to the existing Trends query).
- `js/ui/insights.js` replaces `js/ui/trends.js`; cached until something is
  saved, like Trends today.
- `index.html`: Insights screen markup; tab renamed Insights (same slot);
  header wordmark gets an id so `app.js` can set it per tab and hide the
  period bar on Insights.
- `css/cadence.css`: Insights styles in the Cadence glass style; remove the
  Trends chart styles.
- `CLAUDE.md`: file list and "Trends counts expenses only" rule → Insights.

Testing: read-only. Locally the owner signs in and checks the numbers
against Overview for a couple of periods. Commit/push when asked.

## Owner's answers (2026-09-26)

1. Hide the period bar on Insights: **yes**.
2. Current period shown as "so far": **yes**.
3. Emptied categories judged against the **original** amount (option A).
4. Loose store-name matching: **yes**, plus **store suggestions** in the
   expense sheet: stores entered before appear as tappable chips under
   Merchant, filtered as you type, most-used first, stores used in the
   chosen category ranked higher. Nothing shows until typing starts
   (owner: an always-on list would be cluttered).
5. Squares shrink to fit: **yes**.
6. Tab titles use the Cadence wordmark font (Unbounded), like "Cadence".

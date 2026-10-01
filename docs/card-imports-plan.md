# Card alerts → Cadence, and "Paid from savings"

## How it works

1. A card is used. Chase emails a purchase alert to the owner's Gmail
   (both cards' alerts go there; the name on the alert says whose card).
2. A Gmail filter keeps alerts out of the inbox, so there's no notification.
3. `gmail-script/cadence-alerts.gs` runs every minute in the owner's Google
   account (Google Apps Script). It reads each new alert and sends it to
   `import_card_alert` (migration 008) with the household's import key.
4. Once Cadence has it, the email goes to the Trash. An alert that looks like
   a purchase but can't be read goes to Gmail's **Needs review** folder and
   still shows in Cadence, flagged.
5. Cadence shows **"N new from Chase"** at the top of Overview. Nothing
   counts until someone taps one, picks a category (suggested from the
   store's history, else Extra) and adds it — or taps **Ignore** (e.g. a
   bill paid on the card that's already in Bills). Either phone can do it;
   the second one is turned away.
6. An added purchase is a normal expense in the period it happened in, with
   the dot of whoever's name was on the alert.

**Bills paid on a card**: if a purchase looks like one of its period's
unpaid bills — a store already linked to that bill, or the bill's name
starting a word of the store at a similar amount ("TKS Internet" ↔
"Tkscable") — the review sheet asks "Is this your TKS Internet bill?".
Never by amount alone (a $20 parking charge was offered as Netflix). When
several fit (two $6 Oura bills for "Ouraring Inc.") it asks "Is this one
of your Oura bills?" with a **Mark … paid** button for each; once one is
paid, the next charge only fits the other. **Mark … paid** ticks the bill,
sets **that period's** amount to what was charged (rounded: under 50¢ down,
50¢ or more up; the default in Settings doesn't change), adds a "Paid by
Chase alert" note in Bills, and remembers the store for next time.

**Paid from savings**: every expense (typed in or from an alert) has
Paid from Budget / Savings. Savings purchases show in Recent activity
("Savings", "Not in budget") and in Summary ("Paid from savings · not
counted"), and in Card spending, but never count toward a category, Extra,
carry-over or Insights.

## Pieces

- `supabase/migrations/008_card_imports.sql` — `card_imports`,
  `card_import_keys`, `import_card_alert()`, `new_card_import_key()`,
  `expenses.from_savings`, `expenses.card_import_id`,
  `household_members.cardholder_name`, carry view ignores savings.
  `010_alerts_without_store.sql` — the store becomes optional (Star).
- `gmail-script/cadence-alerts.gs` — readers (one per card company; Chase
  so far) + the Gmail loop. `gmail-script/test-readers.cjs` checks the
  readers against real alert wording (needs Node, so not on the owner's PC).
- App: `js/ui/imports.js` (Overview card), `js/ui/expense-sheet.js` (review
  mode, Paid from), `js/app.js` (loading, period of a purchase, adding),
  `js/data.js`, `js/ui/overview.js`, `js/ui/summary.js`.

## Setup (one time, in this order)

**1. Database** — before the new app code goes live (the new code reads
the new columns).
1. Open the Supabase dashboard → the Cadence project → **SQL Editor** →
   **New query**.
2. Paste all of `supabase/migrations/008_card_imports.sql`, click **Run**.
   It should say "Success. No rows returned".
3. New query again, paste `select public.new_card_import_key();` and click
   **Run**. Copy the long value starting `cad_` — it's shown only once.
   (Running it again makes a new key and the old one stops working.)

**2. App** — commit and push (the owner approves first).

**3. Gmail script**
1. Go to script.google.com, signed in as mabryz@gmail.com → **New project**.
   Click "Untitled project" and name it **Cadence card alerts**.
2. Delete what's in the editor, paste all of `gmail-script/cadence-alerts.gs`,
   press Ctrl+S.
3. Gear icon (**Project Settings**) on the left → scroll to
   **Script properties** → **Add script property**: name
   `CADENCE_IMPORT_KEY`, value the `cad_…` key → **Save script properties**.
4. Back to **Editor** (`<>` icon). In the function menu at the top pick
   **setup**, click **Run**. Google asks for permission: **Review
   permissions** → choose the account → **Advanced** → **Go to Cadence card
   alerts (unsafe)** (it's unverified because it's your own script) →
   **Allow**. The log says "Set up."

**4. Gmail filter** (on a computer, at gmail.com)
1. Open a Chase purchase alert and note the sender's address.
2. Search bar → the sliders icon. **From**: that address. **Has the
   words**: `"transaction alert" "made a"`.
3. **Search** — check only purchase alerts match (fraud warnings must not).
4. Sliders icon again → **Create filter** → tick **Skip the Inbox
   (Archive it)** → **Create filter**.

**5. Chase** — purchase alerts by email for both cards, lowest threshold
(currently $1). Then buy something small and watch it appear.

## Military Star

Star's alert emails (from DoNotReply@aafes.com, subject "Your MILITARY STAR
Card Transaction Exceeds the Limit"; "Transaction Notification" is only the
heading inside) give the amount, the card's last 4 and a time, but **no
store and no name**. So a Star purchase shows as *"Star purchase"* in Overview and the
notification says "Star Card · $5" / "Tap to add the store". The review sheet
has the amount and Star filled in. Type the store: if it's been used
before, its category is picked (until a category is tapped by hand),
otherwise Extra. No dot (one shared card). No bill matching (no store to
match on).

The time in the email is **US Central** with no zone written on it (a
purchase at 11:14 in Europe said "04:14"); the email itself arrives within
moments, like Chase's. The script converts the time (`localToIso`), and
falls back to the email's arrival time if the result is impossible.

One-time setup: run `supabase/migrations/010_alerts_without_store.sql` (it
lets alerts in without a store), push the app, paste the new notify-purchase
function and the new Gmail script, then on MyECP.com set the transaction
alert limit as low as it goes ($1). Optional Gmail filter: From
`DoNotReply@aafes.com`, Has the words `"exceeded your chosen transaction
limit"`, Skip the Inbox.

## Adding another card company

Send one real alert email (digits blacked out). Add a reader next to
`CHASE` in the script, add it to `READERS`, add a test in
`test-readers.cjs`, and paste the new script into Apps Script.

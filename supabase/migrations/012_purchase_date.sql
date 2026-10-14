-- Purchase date: the day an expense really happened, picked on the expense
-- sheet (Today / Yesterday / Pick a day) or taken from the card alert.
-- Blank for expenses saved before this, and for anything the older app
-- saves; the app then falls back to the alert's time or when it was entered.
-- No default, so the code that's live keeps working. Safe to re-run.

alter table public.expenses add column if not exists spent_on date;

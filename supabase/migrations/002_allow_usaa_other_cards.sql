-- Allow the USAA and Other cards added in the Cadence redesign.
-- The original constraint only allowed Chase, AMEX and Star Card.
-- Keep this list in step with CARDS in js/config.js. Safe to run more than once.

begin;

alter table public.expenses drop constraint if exists expenses_card_check;

alter table public.expenses add constraint expenses_card_check
  check (card = any (array['Chase', 'AMEX', 'Star Card', 'USAA', 'Other']));

commit;

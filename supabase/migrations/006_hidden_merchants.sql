-- Store suggestions: stores a household has hidden from the expense sheet's
-- suggestions (the × on a suggestion, or Settings → Store suggestions).
--
--   * merchant_key is the store name trimmed, single-spaced and lower-case
--     (merchantKey() in js/merchants.js), so "ALDI" and "aldi" are one store.
--   * Hiding only affects suggestions: expenses, Insights and totals are
--     untouched.
--   * Same lock-down as every budget table: signed-in household members only.
--
-- The deployed app doesn't use this table, so running this first is safe.
-- Safe to run more than once.

begin;

create table if not exists public.hidden_merchants (
  household_id uuid not null default public.current_household_id() references public.households(id),
  merchant_key text not null check (merchant_key <> ''),
  created_at timestamptz not null default now(),
  primary key (household_id, merchant_key)
);

alter table public.hidden_merchants enable row level security;

drop policy if exists "household members" on public.hidden_merchants;
create policy "household members" on public.hidden_merchants
  for all to authenticated
  using (household_id = (select public.current_household_id()))
  with check (household_id = (select public.current_household_id()));

revoke all on public.hidden_merchants from anon;
grant select, insert, delete on public.hidden_merchants to authenticated;

commit;

notify pgrst, 'reload schema';

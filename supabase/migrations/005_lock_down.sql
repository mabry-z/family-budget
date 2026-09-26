-- Accounts + households, step 2 of 2 (see docs/households-plan.md).
--
-- Run only AFTER the app with sign-in is live: from here on, nobody who
-- isn't signed in can read or change anything, and each signed-in person
-- only sees their own household.
--
--   * current_household_id() loses 004's "not signed in" fallback.
--   * Every budget table keeps only the "household members" policy.
--   * The publishable key alone (role anon) loses all access.
--   * budget_settings (the old app's table) is shut off entirely.
--
-- Safe to run more than once.

begin;

create or replace function public.current_household_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id from household_members where user_id = auth.uid();
$$;

do $$
declare
  t text;
  p text;
begin
  foreach t in array array['budget_defaults', 'categories', 'fixed_cost_templates', 'pay_periods',
                           'period_categories', 'expenses', 'fixed_costs', 'budget_settings'] loop
    for p in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = t and policyname <> 'household members'
    loop
      execute format('drop policy %I on public.%I', p, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end;
$$;

-- Nothing uses the old table any more; it's dropped in a later cleanup.
revoke all on public.budget_settings from authenticated;

revoke all on public.period_extra_carry from anon;
revoke all on all sequences in schema public from anon;

revoke execute on function public.ensure_period(integer, integer, integer) from public, anon;
revoke execute on function public.save_settings(integer, integer, integer, date, integer, jsonb, jsonb) from public, anon;
revoke execute on function public.start_period(integer, integer, integer, date) from public, anon;
revoke execute on function public.current_household_id() from public, anon;
revoke execute on function public.require_household_id() from public, anon;

grant execute on function public.ensure_period(integer, integer, integer) to authenticated;
grant execute on function public.save_settings(integer, integer, integer, date, integer, jsonb, jsonb) to authenticated;
grant execute on function public.start_period(integer, integer, integer, date) to authenticated;
grant execute on function public.current_household_id() to authenticated;
grant execute on function public.require_household_id() to authenticated;

commit;

notify pgrst, 'reload schema';

-- Who added each expense, for the small colored dot next to the merchant
-- name (Overview → recent activity and expanded category rows).
--
-- created_by defaults to auth.uid(), the same trick household_id already
-- uses (see 004_households.sql), so no app code has to set it explicitly —
-- it's just left out of the insert and Postgres fills it in.
--
-- Existing expenses have no record of who added them and stay that way
-- (no dot) rather than guessing. on delete set null: if an account is ever
-- removed, its old expenses keep their history, just without the marker.
--
-- household_info() is extended to also return each member's user_id, so the
-- app can match an expense's created_by to "you" or the other member and
-- pick a colour, without ever reading auth.users directly.
--
-- Safe to run more than once.

begin;

alter table public.expenses
  add column if not exists created_by uuid references auth.users(id) on delete set null default auth.uid();

create or replace function public.household_info()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'name', h.name,
    'role', me.role,
    'members', (
      select jsonb_agg(jsonb_build_object(
               'user_id', m.user_id, 'email', u.email, 'role', m.role, 'is_me', m.user_id = auth.uid())
             order by m.role = 'owner' desc, u.email)
      from household_members m
      join auth.users u on u.id = m.user_id
      where m.household_id = h.id))
  from household_members me
  join households h on h.id = me.household_id
  where me.user_id = auth.uid();
$$;

revoke execute on function public.household_info() from public, anon;
grant execute on function public.household_info() to authenticated;

commit;

notify pgrst, 'reload schema';

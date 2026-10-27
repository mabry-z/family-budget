-- Chore money in dollars and cents (e.g. $0.50). Chores only: the budget
-- stays whole dollars. Savings goals stay whole dollars too.
--
--   * chores.amount, chore_tasks.amount, kid_ledger.amount become
--     numeric(8,2) (existing whole-dollar rows keep their value).
--   * kid_balances / kid_balance() return dollars and cents.
--   * save_chore, pay_out and add_bonus take a numeric amount.
--
-- The deployed app keeps working: whole numbers are still valid amounts.
-- Safe to run more than once.

begin;

drop view if exists public.kid_balances;

alter table public.chores      alter column amount type numeric(8,2);
alter table public.chore_tasks alter column amount type numeric(8,2);
alter table public.kid_ledger  alter column amount type numeric(8,2);

create view public.kid_balances
with (security_invoker = true)
as
select kid_id, sum(amount)::numeric(10,2) as balance
from kid_ledger
group by kid_id;

revoke all on public.kid_balances from anon;
grant select on public.kid_balances to authenticated;

-- Return type changes need a drop first.
drop function if exists public.kid_balance(uuid);
create function public.kid_balance(p_kid uuid)
returns numeric
language sql stable security definer set search_path = public
as $$ select coalesce(sum(amount), 0)::numeric(10,2) from kid_ledger where kid_id = p_kid; $$;

-- Whole cents, 0 to 1,000 dollars.
create or replace function public.valid_chore_money(p numeric, p_min numeric)
returns boolean
language sql immutable
as $$ select p is not null and p >= p_min and p <= 1000 and p = round(p, 2); $$;

drop function if exists public.save_chore(bigint, uuid, text, integer, text, smallint[], date);
create or replace function public.save_chore(
  p_id bigint, p_kid uuid, p_title text, p_amount numeric, p_repeat text, p_weekdays smallint[], p_today date)
returns bigint language plpgsql security definer set search_path = public
as $$
declare
  v_household uuid := require_parent();
  v_day date := chore_day(p_today);
  v_title text := btrim(coalesce(p_title, ''));
  v_days smallint[];
  v_id bigint;
begin
  if p_kid is not null then
    perform require_kid(v_household, p_kid);
  end if;
  if v_title = '' then raise exception 'Give the chore a name.'; end if;
  if length(v_title) > 80 then raise exception 'Keep the name under 80 characters.'; end if;
  if not valid_chore_money(p_amount, 0) then
    raise exception 'The amount must be $0 to $1,000, like 2 or 0.50.';
  end if;
  if p_repeat not in ('once', 'daily', 'weekly') then raise exception 'Pick how often it repeats.'; end if;

  select coalesce(array_agg(distinct d order by d), '{}') into v_days
  from unnest(coalesce(p_weekdays, '{}')) d
  where p_repeat = 'weekly' and d between 0 and 6;

  if p_id is null then
    insert into chores (household_id, kid_id, title, amount, repeat, weekdays)
    values (v_household, p_kid, v_title, p_amount, p_repeat, v_days)
    returning id into v_id;
    if p_repeat = 'once' then
      insert into chore_tasks (household_id, chore_id, kid_id, due_on, amount)
      values (v_household, v_id, p_kid, v_day, p_amount);
    end if;
  else
    update chores
    set kid_id = p_kid, title = v_title, amount = p_amount, repeat = p_repeat, weekdays = v_days
    where id = p_id and household_id = v_household and active
    returning id into v_id;
    if v_id is null then raise exception 'That chore wasn''t found (maybe it was just deleted).'; end if;

    if p_repeat = 'once' then
      update chore_tasks
      set kid_id = case when status = 'sent_back' then coalesce(p_kid, kid_id) else p_kid end,
          amount = p_amount, updated_at = now()
      where chore_id = v_id and status in ('open', 'sent_back');
      if not exists (select 1 from chore_tasks where chore_id = v_id and status <> 'expired') then
        insert into chore_tasks (household_id, chore_id, kid_id, due_on, amount)
        values (v_household, v_id, p_kid, v_day, p_amount)
        on conflict (chore_id, due_on) do update
          set status = 'open', kid_id = excluded.kid_id, amount = excluded.amount, note = null, updated_at = now();
      end if;
    else
      delete from chore_tasks where chore_id = v_id and status in ('open', 'sent_back');
    end if;
  end if;

  perform ensure_chore_tasks(v_day);
  return v_id;
end;
$$;

drop function if exists public.pay_out(uuid, integer, text);
create or replace function public.pay_out(p_kid uuid, p_amount numeric, p_note text default null)
returns numeric language plpgsql security definer set search_path = public
as $$
declare
  v_household uuid := require_parent();
  v_balance numeric;
begin
  perform require_kid(v_household, p_kid);
  perform pg_advisory_xact_lock(hashtext('kid_ledger:' || p_kid::text));
  v_balance := kid_balance(p_kid);
  if not valid_chore_money(p_amount, 0.01) then
    raise exception 'Enter how much you paid out, like 5 or 2.50.';
  end if;
  if p_amount > v_balance then
    raise exception 'That''s more than the balance (%).', '$' || to_char(v_balance, 'FM999990.00');
  end if;
  insert into kid_ledger (household_id, kid_id, amount, kind, note)
  values (v_household, p_kid, -p_amount, 'payout', nullif(left(btrim(coalesce(p_note, '')), 140), ''));
  return v_balance - p_amount;
end;
$$;

drop function if exists public.add_bonus(uuid, integer, text);
create or replace function public.add_bonus(p_kid uuid, p_amount numeric, p_note text default null)
returns numeric language plpgsql security definer set search_path = public
as $$
declare
  v_household uuid := require_parent();
begin
  perform require_kid(v_household, p_kid);
  if not valid_chore_money(p_amount, 0.01) then
    raise exception 'A bonus must be $0.01 to $1,000, like 5 or 0.50.';
  end if;
  insert into kid_ledger (household_id, kid_id, amount, kind, note)
  values (v_household, p_kid, p_amount, 'bonus', nullif(left(btrim(coalesce(p_note, '')), 140), ''));
  return kid_balance(p_kid);
end;
$$;

revoke execute on function
  public.kid_balance(uuid), public.valid_chore_money(numeric, numeric),
  public.save_chore(bigint, uuid, text, numeric, text, smallint[], date),
  public.pay_out(uuid, numeric, text), public.add_bonus(uuid, numeric, text)
from public, anon, authenticated;

grant execute on function
  public.save_chore(bigint, uuid, text, numeric, text, smallint[], date),
  public.pay_out(uuid, numeric, text), public.add_bonus(uuid, numeric, text)
to authenticated;

commit;

notify pgrst, 'reload schema';

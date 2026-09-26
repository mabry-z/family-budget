-- Cadence step 3:
--   * "Move leftover to Extra": a category can be emptied for one period; its
--     budget becomes what was spent and the rest goes to that period's Extra.
--   * Extra carries forward: each period's Extra starts with the previous
--     period's Extra leftover (negative too), beginning with the Oct 1, 2026 period.
--   * Pay periods get a real start date (starts_on), confirmed on payday.
--
-- Safe to run more than once.

begin;

alter table public.period_categories
  add column if not exists emptied boolean not null default false;

alter table public.budget_defaults
  add column if not exists carry_start date not null default '2026-10-01';

-- The day the period actually began (payday). Null = not started yet.
-- Periods are still identified by (year, month, start_day); start_day 16
-- means "the mid-month paycheck", whose normal start is the 15th.
alter table public.pay_periods
  add column if not exists starts_on date;

-- Periods that had already begun before this change start on their normal day.
update public.pay_periods
set starts_on = make_date(year, month, case when start_day = 1 then 1 else 15 end)
where starts_on is null and start_date <= date '2026-09-30';

-- ============================================================
-- start_period: confirm the day a period began
-- ============================================================

create or replace function public.start_period(
  p_year integer, p_month integer, p_start_day integer, p_starts_on date)
returns public.pay_periods
language plpgsql
set search_path = public
as $$
declare
  v pay_periods;
  v_prev pay_periods;
  v_next pay_periods;
begin
  if p_starts_on is null then
    raise exception 'Pick the date the period started.';
  end if;

  v := ensure_period(p_year, p_month, p_start_day);

  if abs(p_starts_on - v.start_date) > 20 then
    raise exception 'That date is too far from this period''s normal payday.';
  end if;

  select * into v_prev from pay_periods
  where start_date < v.start_date
  order by start_date desc limit 1;
  if found then
    if v_prev.starts_on is null then
      raise exception 'Start the previous pay period first.';
    end if;
    if p_starts_on <= v_prev.starts_on then
      raise exception 'This period has to start after %, when the previous one started.',
        to_char(v_prev.starts_on, 'Mon FMDD');
    end if;
  end if;

  select * into v_next from pay_periods
  where start_date > v.start_date and starts_on is not null
  order by start_date limit 1;
  if found and p_starts_on >= v_next.starts_on then
    raise exception 'This period has to start before %, when the next one started.',
      to_char(v_next.starts_on, 'Mon FMDD');
  end if;

  update pay_periods set starts_on = p_starts_on where id = v.id
  returning * into v;
  return v;
end;
$$;

grant execute on function public.start_period(integer, integer, integer, date) to anon, authenticated;

-- ============================================================
-- period_extra_carry: how much Extra each period carries in
--
-- A period's own Extra leftover =
--     starting − fixed costs − category budgets (emptied ones count only
--     what was spent) − spending that lands in Extra.
-- carry_in is the running total of those leftovers for every earlier
-- period from carry_start on. Nothing is stored, so late edits flow forward.
-- ============================================================

create or replace view public.period_extra_carry
with (security_invoker = true)
as
with cat_spend as (
  select pp.id as period_id, e.category_id,
         sum(case when e.transaction_type = 'refund' then -e.amount else e.amount end) as spent
  from pay_periods pp
  join expenses e
    on e.year = pp.year and e.month = pp.month and e.period_start_day = pp.start_day
  group by pp.id, e.category_id
),
budgets as (
  select pc.period_id,
         sum(case when pc.emptied
                  then greatest(0, least(pc.amount, coalesce(cs.spent, 0)))
                  else pc.amount end) as total
  from period_categories pc
  left join cat_spend cs on cs.period_id = pc.period_id and cs.category_id = pc.category_id
  group by pc.period_id
),
fixed as (
  select pp.id as period_id, sum(fc.amount) as total
  from pay_periods pp
  join fixed_costs fc
    on fc.year = pp.year and fc.month = pp.month and fc.period_start_day = pp.start_day
  group by pp.id
),
extra_spend as (
  select cs.period_id, sum(cs.spent) as total
  from cat_spend cs
  where not exists (
    select 1 from period_categories pc
    where pc.period_id = cs.period_id and pc.category_id = cs.category_id)
  group by cs.period_id
),
leftover as (
  select pp.id, pp.start_date,
         pp.starting_amount
           - coalesce(f.total, 0)
           - coalesce(b.total, 0)
           - coalesce(x.total, 0) as extra_left
  from pay_periods pp
  cross join budget_defaults d
  left join fixed f on f.period_id = pp.id
  left join budgets b on b.period_id = pp.id
  left join extra_spend x on x.period_id = pp.id
  where d.id = 1 and pp.start_date >= d.carry_start
)
select id as period_id,
       coalesce(sum(extra_left) over (order by start_date
                                      rows between unbounded preceding and 1 preceding), 0)::integer
         as carry_in
from leftover;

grant select on public.period_extra_carry to anon, authenticated;

commit;

notify pgrst, 'reload schema';

-- Overages come out of Extra (the Oct 1, 2026 period onward).
--
--   * budget_defaults.overage_start: the first period where this applies.
--     Earlier periods are left exactly as they were.
--   * period_extra_carry: from that period on, whatever a category spends
--     past its budget is taken off Extra's leftover, so it also comes off
--     what carries into the next period (negative too — that's "pulling
--     from the next pay period" when Extra runs out).
-- Same view as 008 apart from the overages part. Safe to re-run.

begin;

alter table public.budget_defaults
  add column if not exists overage_start date;

update public.budget_defaults
  set overage_start = date '2026-10-01'
  where overage_start is null;

create or replace view public.period_extra_carry
with (security_invoker = true)
as
with cat_spend as (
  select pp.id as period_id, e.category_id,
         sum(case when e.transaction_type = 'refund' then -e.amount else e.amount end) as spent
  from pay_periods pp
  join expenses e
    on e.household_id = pp.household_id
   and e.year = pp.year and e.month = pp.month and e.period_start_day = pp.start_day
   and not e.from_savings
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
    on fc.household_id = pp.household_id
   and fc.year = pp.year and fc.month = pp.month and fc.period_start_day = pp.start_day
  group by pp.id
),
overages as (
  -- From overage_start on, whatever a category spends past its (effective)
  -- budget comes out of Extra.
  select pc.period_id,
         sum(greatest(0, coalesce(cs.spent, 0)
               - case when pc.emptied
                      then greatest(0, least(pc.amount, coalesce(cs.spent, 0)))
                      else pc.amount end)) as total
  from period_categories pc
  join pay_periods pp on pp.id = pc.period_id
  join budget_defaults d on d.household_id = pp.household_id
  left join cat_spend cs on cs.period_id = pc.period_id and cs.category_id = pc.category_id
  where d.overage_start is not null and pp.start_date >= d.overage_start
  group by pc.period_id
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
  select pp.id, pp.household_id, pp.start_date,
         pp.starting_amount
           - coalesce(f.total, 0)
           - coalesce(b.total, 0)
           - coalesce(x.total, 0)
           - coalesce(o.total, 0) as extra_left
  from pay_periods pp
  join budget_defaults d on d.household_id = pp.household_id
  left join fixed f on f.period_id = pp.id
  left join budgets b on b.period_id = pp.id
  left join extra_spend x on x.period_id = pp.id
  left join overages o on o.period_id = pp.id
  where pp.start_date >= d.carry_start
)
select id as period_id,
       coalesce(sum(extra_left) over (partition by household_id order by start_date
                                      rows between unbounded preceding and 1 preceding), 0)::integer
         as carry_in
from leftover;

revoke all on public.period_extra_carry from anon;
grant select on public.period_extra_carry to authenticated;

commit;

notify pgrst, 'reload schema';

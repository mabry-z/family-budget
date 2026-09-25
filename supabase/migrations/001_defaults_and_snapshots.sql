-- Cadence redesign, step 1: editable defaults + per-period snapshots.
--
-- Additive only: the live app on main keeps working against budget_settings,
-- fixed_costs and expenses exactly as before. Safe to run more than once;
-- re-run it right before merging to pick up anything the old app wrote since.
--
-- Periods are still identified by (year, month, start_day) everywhere, so
-- expenses and fixed_costs keep their existing period columns.

begin;

-- ============================================================
-- Defaults (edited in Settings)
-- ============================================================

create table if not exists public.budget_defaults (
  id integer primary key default 1 check (id = 1),
  starting_amount integer not null default 3500 check (starting_amount >= 0)
);
insert into public.budget_defaults (id, starting_amount) values (1, 3500)
on conflict (id) do nothing;

create table if not exists public.categories (
  id bigint generated always as identity primary key,
  name text not null,
  color text not null default '#7CA3F2',
  default_amount integer not null default 0 check (default_amount >= 0),
  sort_order integer not null default 0,
  is_active boolean not null default true,    -- false = archived; old expenses still point at it
  is_remainder boolean not null default false -- true = Extra, whose amount is always calculated
);
create unique index if not exists categories_single_remainder
  on public.categories (is_remainder) where is_remainder;

-- Defaults taken from the current period (Sep 16–30, 2026).
insert into public.categories (name, color, default_amount, sort_order, is_remainder)
select v.name, v.color, v.default_amount, v.sort_order, v.is_remainder
from (values
  ('Gas',       '#7CA3F2', 250, 1,  false),
  ('Groceries', '#E9A6D0', 450, 2,  false),
  ('Eat Out',   '#F2A65C', 100, 3,  false),
  ('Extra',     '#5BC7A6', 0,   99, true)
) as v(name, color, default_amount, sort_order, is_remainder)
where not exists (select 1 from public.categories);

create table if not exists public.fixed_cost_templates (
  id bigint generated always as identity primary key,
  half integer not null check (half in (1, 16)), -- which pay period of the month it belongs to
  name text not null,
  default_amount integer not null default 0 check (default_amount >= 0),
  is_active boolean not null default true
);

-- Seed each half from its most recent period.
insert into public.fixed_cost_templates (half, name, default_amount)
select fc.period_start_day, fc.name, fc.amount::integer
from public.fixed_costs fc
join (
  select distinct on (period_start_day) period_start_day, month, year
  from public.fixed_costs
  order by period_start_day, year desc, month desc
) latest using (period_start_day, month, year)
where not exists (select 1 from public.fixed_cost_templates);

-- ============================================================
-- Per-period snapshots
-- ============================================================

create table if not exists public.pay_periods (
  id bigint generated always as identity primary key,
  year integer not null,
  month integer not null check (month between 1 and 12),
  start_day integer not null check (start_day in (1, 16)),
  start_date date generated always as (make_date(year, month, start_day)) stored,
  starting_amount integer not null check (starting_amount >= 0),
  unique (year, month, start_day)
);
create index if not exists pay_periods_start_date on public.pay_periods (start_date);

create table if not exists public.period_categories (
  period_id bigint not null references public.pay_periods(id) on delete cascade,
  category_id bigint not null references public.categories(id),
  amount integer not null check (amount >= 0),
  primary key (period_id, category_id)
);

alter table public.fixed_costs
  add column if not exists template_id bigint
  references public.fixed_cost_templates(id) on delete set null;

alter table public.expenses
  add column if not exists category_id bigint
  references public.categories(id);

-- ============================================================
-- Backfill from the old tables
-- ============================================================

-- Periods the old app created keep their own starting and category amounts.
insert into public.pay_periods (year, month, start_day, starting_amount)
select year, month, period_start_day, starting_amount::integer
from public.budget_settings
on conflict (year, month, start_day) do nothing;

insert into public.period_categories (period_id, category_id, amount)
select pp.id, c.id,
  (case c.name
     when 'Gas' then bs.gas_amount
     when 'Groceries' then bs.groceries_amount
     else bs.eat_out_amount
   end)::integer
from public.budget_settings bs
join public.pay_periods pp
  on pp.year = bs.year and pp.month = bs.month and pp.start_day = bs.period_start_day
join public.categories c on c.name in ('Gas', 'Groceries', 'Eat Out') and not c.is_remainder
where not exists (select 1 from public.period_categories pc where pc.period_id = pp.id);

-- Any period that only shows up in expenses/fixed_costs gets the defaults.
insert into public.pay_periods (year, month, start_day, starting_amount)
select distinct x.year, x.month, x.period_start_day, d.starting_amount
from (
  select year, month, period_start_day from public.expenses
  union
  select year, month, period_start_day from public.fixed_costs
) x
cross join public.budget_defaults d
on conflict (year, month, start_day) do nothing;

insert into public.period_categories (period_id, category_id, amount)
select pp.id, c.id, c.default_amount
from public.pay_periods pp
join public.categories c on c.is_active and not c.is_remainder
where not exists (select 1 from public.period_categories pc where pc.period_id = pp.id);

update public.fixed_costs fc
set template_id = t.id
from public.fixed_cost_templates t
where fc.template_id is null
  and t.is_active
  and t.half = fc.period_start_day
  and lower(t.name) = lower(fc.name);

update public.expenses e
set category_id = coalesce(
  (select c.id from public.categories c
   where lower(c.name) = lower(e.category)
   order by c.is_active desc, c.id limit 1),
  (select c.id from public.categories c where c.is_remainder))
where e.category_id is null;

-- The old app only writes the category name; keep category_id in step with it
-- until the old app is retired.
create or replace function public.expenses_link_category()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.category_id is null
     or (tg_op = 'UPDATE'
         and new.category is distinct from old.category
         and new.category_id is not distinct from old.category_id) then
    new.category_id := coalesce(
      (select id from categories
       where lower(name) = lower(new.category)
       order by is_active desc, id limit 1),
      (select id from categories where is_remainder));
  end if;
  return new;
end;
$$;

drop trigger if exists expenses_link_category on public.expenses;
create trigger expenses_link_category
before insert or update on public.expenses
for each row execute function public.expenses_link_category();

-- ============================================================
-- ensure_period: open a period, snapshotting the defaults the first time
-- ============================================================

create or replace function public.ensure_period(p_year integer, p_month integer, p_start_day integer)
returns public.pay_periods
language plpgsql
set search_path = public
as $$
declare
  v pay_periods;
begin
  select * into v from pay_periods
  where year = p_year and month = p_month and start_day = p_start_day;
  if found then
    return v;
  end if;

  insert into pay_periods (year, month, start_day, starting_amount)
  select p_year, p_month, p_start_day, d.starting_amount
  from budget_defaults d where d.id = 1
  on conflict (year, month, start_day) do nothing
  returning * into v;

  if not found then
    -- Another device created it at the same moment; use theirs.
    select * into v from pay_periods
    where year = p_year and month = p_month and start_day = p_start_day;
    return v;
  end if;

  insert into period_categories (period_id, category_id, amount)
  select v.id, c.id, c.default_amount
  from categories c
  where c.is_active and not c.is_remainder;

  -- The old app may already have written this period's fixed costs by name.
  update fixed_costs fc
  set template_id = t.id
  from fixed_cost_templates t
  where fc.template_id is null
    and t.is_active and t.half = p_start_day
    and lower(t.name) = lower(fc.name)
    and fc.year = p_year and fc.month = p_month and fc.period_start_day = p_start_day;

  insert into fixed_costs (period_start_day, month, year, name, amount, is_paid, template_id)
  select p_start_day, p_month, p_year, t.name, t.default_amount, false, t.id
  from fixed_cost_templates t
  where t.is_active and t.half = p_start_day
    and not exists (
      select 1 from fixed_costs fc
      where fc.template_id = t.id
        and fc.year = p_year and fc.month = p_month and fc.period_start_day = p_start_day);

  return v;
end;
$$;

-- ============================================================
-- save_settings: apply the Settings sheet
--
-- Past period   (starts before p_today_start): changes only that period.
-- Current/future period: changes the defaults, that period, and every later
--   period that already exists. Earlier periods are never touched.
--
-- p_categories: [{ "id": bigint|null, "name": text, "color": text, "amount": int }]
--               in display order, Extra excluded.
-- p_fixed:      [{ "id": fixed_costs.id|null, "template_id": bigint|null,
--                  "name": text, "amount": int }]
-- ============================================================

create or replace function public.save_settings(
  p_year integer,
  p_month integer,
  p_start_day integer,
  p_today_start date,
  p_starting integer,
  p_categories jsonb,
  p_fixed jsonb
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v pay_periods;
  r jsonb;
  v_id bigint;
  v_name text;
  v_amount integer;
  v_sort integer := 0;
  v_count integer;
  v_keep_cats bigint[] := '{}';
  v_keep_templates bigint[] := '{}';
  v_keep_fixed bigint[] := '{}';
  v_removed bigint[];
begin
  -- ---------- validation ----------
  if p_starting is null or p_starting < 0 then
    raise exception 'Starting budget must be a whole number of 0 or more.';
  end if;

  if exists (select 1 from jsonb_array_elements(p_categories || p_fixed) e
             where coalesce(trim(e->>'name'), '') = ''
                or e->>'amount' is null
                or (e->>'amount')::integer < 0) then
    raise exception 'Every row needs a name and an amount of 0 or more.';
  end if;

  select min(trim(e->>'name')) into v_name
  from jsonb_array_elements(p_categories) e
  group by lower(trim(e->>'name'))
  having count(*) > 1 limit 1;
  if v_name is null then
    select trim(e->>'name') into v_name
    from jsonb_array_elements(p_categories) e
    join categories c on c.is_remainder and lower(c.name) = lower(trim(e->>'name'))
    limit 1;
  end if;
  if v_name is not null then
    raise exception 'Category names must be unique (and not "Extra"): %', v_name;
  end if;

  select min(trim(e->>'name')) into v_name
  from jsonb_array_elements(p_fixed) e
  group by lower(trim(e->>'name'))
  having count(*) > 1 limit 1;
  if v_name is not null then
    raise exception 'Fixed cost names must be unique: %', v_name;
  end if;

  v := ensure_period(p_year, p_month, p_start_day);

  -- ---------- past period: this period only ----------
  if v.start_date < p_today_start then
    update pay_periods set starting_amount = p_starting where id = v.id;

    for r in select value from jsonb_array_elements(p_categories) loop
      update period_categories
      set amount = (r->>'amount')::integer
      where period_id = v.id and category_id = (r->>'id')::bigint;
    end loop;

    for r in select value from jsonb_array_elements(p_fixed) loop
      v_id := null;
      if r->>'id' is not null then
        update fixed_costs
        set name = trim(r->>'name'), amount = (r->>'amount')::integer
        where id = (r->>'id')::bigint
          and year = p_year and month = p_month and period_start_day = p_start_day
        returning id into v_id;
      else
        insert into fixed_costs (period_start_day, month, year, name, amount, is_paid)
        values (p_start_day, p_month, p_year, trim(r->>'name'), (r->>'amount')::integer, false)
        returning id into v_id;
      end if;
      if v_id is not null then
        v_keep_fixed := v_keep_fixed || v_id;
      end if;
    end loop;

    delete from fixed_costs
    where year = p_year and month = p_month and period_start_day = p_start_day
      and id <> all (v_keep_fixed);
    return;
  end if;

  -- ---------- current/future period: defaults + this period onward ----------
  update budget_defaults set starting_amount = p_starting where id = 1;
  update pay_periods set starting_amount = p_starting where start_date >= v.start_date;

  -- Categories
  for r in select value from jsonb_array_elements(p_categories) loop
    v_sort := v_sort + 1;
    v_name := trim(r->>'name');
    v_amount := (r->>'amount')::integer;

    if r->>'id' is null then
      insert into categories (name, color, default_amount, sort_order)
      values (v_name, coalesce(r->>'color', '#7CA3F2'), v_amount, v_sort)
      returning id into v_id;
    else
      v_id := (r->>'id')::bigint;
      update categories
      set name = v_name, default_amount = v_amount, sort_order = v_sort, is_active = true
      where id = v_id and not is_remainder;
    end if;
    v_keep_cats := v_keep_cats || v_id;

    insert into period_categories (period_id, category_id, amount)
    select pp.id, v_id, v_amount
    from pay_periods pp
    where pp.start_date >= v.start_date
    on conflict (period_id, category_id) do update set amount = excluded.amount;
  end loop;

  -- Categories removed from this period's list
  for v_id, v_name in
    select c.id, c.name
    from period_categories pc
    join categories c on c.id = pc.category_id
    where pc.period_id = v.id and c.id <> all (v_keep_cats)
  loop
    select count(*) into v_count
    from expenses e
    where e.category_id = v_id
      and make_date(e.year, e.month, e.period_start_day) >= v.start_date;
    if v_count > 0 then
      raise exception 'Can''t remove %: it has % expense(s) in this or a later period. Move or delete them first.',
        v_name, v_count;
    end if;

    update categories set is_active = false where id = v_id;
    delete from period_categories pc
    using pay_periods pp
    where pc.period_id = pp.id and pc.category_id = v_id and pp.start_date >= v.start_date;
  end loop;

  -- Fixed costs (only periods in the same half of the month)
  for r in select value from jsonb_array_elements(p_fixed) loop
    v_name := trim(r->>'name');
    v_amount := (r->>'amount')::integer;
    v_id := (r->>'template_id')::bigint;

    if v_id is null then
      insert into fixed_cost_templates (half, name, default_amount)
      values (p_start_day, v_name, v_amount)
      returning id into v_id;

      -- Adopt same-named rows that aren't linked yet (this period's own row,
      -- or rows the old app wrote) instead of adding duplicates.
      update fixed_costs
      set template_id = v_id
      where template_id is null
        and lower(name) = lower(v_name)
        and period_start_day = p_start_day
        and make_date(year, month, period_start_day) >= v.start_date;
      if r->>'id' is not null then
        update fixed_costs set template_id = v_id where id = (r->>'id')::bigint;
      end if;
    else
      update fixed_cost_templates
      set name = v_name, default_amount = v_amount, is_active = true
      where id = v_id;
    end if;
    v_keep_templates := v_keep_templates || v_id;

    update fixed_costs
    set name = v_name, amount = v_amount
    where template_id = v_id
      and period_start_day = p_start_day
      and make_date(year, month, period_start_day) >= v.start_date;

    insert into fixed_costs (period_start_day, month, year, name, amount, is_paid, template_id)
    select p_start_day, pp.month, pp.year, v_name, v_amount, false, v_id
    from pay_periods pp
    where pp.start_day = p_start_day
      and pp.start_date >= v.start_date
      and not exists (
        select 1 from fixed_costs fc
        where fc.template_id = v_id
          and fc.year = pp.year and fc.month = pp.month and fc.period_start_day = pp.start_day);
  end loop;

  -- Fixed costs removed from this period's list
  select coalesce(array_agg(distinct template_id), '{}') into v_removed
  from fixed_costs
  where year = p_year and month = p_month and period_start_day = p_start_day
    and template_id is not null
    and template_id <> all (v_keep_templates);

  update fixed_cost_templates set is_active = false where id = any (v_removed);

  delete from fixed_costs
  where template_id = any (v_removed)
    and period_start_day = p_start_day
    and make_date(year, month, period_start_day) >= v.start_date;

  -- Anything in this period still unlinked was removed in the form
  -- (rows that were kept got a template above).
  delete from fixed_costs
  where year = p_year and month = p_month and period_start_day = p_start_day
    and template_id is null;
end;
$$;

-- ============================================================
-- Access (same open access the existing tables have via the anon key)
-- ============================================================

grant select, insert, update, delete on
  public.budget_defaults, public.categories, public.fixed_cost_templates,
  public.pay_periods, public.period_categories
to anon, authenticated;

grant execute on function public.ensure_period(integer, integer, integer) to anon, authenticated;
grant execute on function public.save_settings(integer, integer, integer, date, integer, jsonb, jsonb)
  to anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['budget_defaults', 'categories', 'fixed_cost_templates',
                           'pay_periods', 'period_categories'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "app access" on public.%I', t);
    execute format('create policy "app access" on public.%I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end;
$$;

commit;

notify pgrst, 'reload schema';

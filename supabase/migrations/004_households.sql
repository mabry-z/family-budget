-- Accounts + households, step 1 of 2 (see docs/households-plan.md).
--
--   * Creates the Mabry Household and adds both accounts to it.
--   * Tags every budget row with its household and scopes the functions and
--     the Extra carry-over view to the caller's household.
--   * Adds "household members" policies for signed-in users.
--
-- Backwards compatible: the open "app access" policies stay, and when nobody
-- is signed in (the currently deployed app) current_household_id() falls
-- back to the only household, so the live app keeps working unchanged.
-- 005 removes the fallback and the open access.
--
-- Both accounts must already exist (Authentication → Users). Safe to run
-- more than once.

begin;

-- ============================================================
-- Households
-- ============================================================

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade, -- one household per user for now
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

do $$
declare
  v_name   constant text := 'Mabry Household';
  v_owner  constant text := 'mabryz@gmail.com';
  v_member constant text := 'mabrylh@gmail.com';
  v_household uuid;
  v_owner_id uuid;
  v_member_id uuid;
begin
  select id into v_owner_id from auth.users where lower(email) = lower(v_owner);
  if v_owner_id is null then
    raise exception 'There''s no account for % yet. Add it in Authentication → Users first.', v_owner;
  end if;
  select id into v_member_id from auth.users where lower(email) = lower(v_member);
  if v_member_id is null then
    raise exception 'There''s no account for % yet. Add it in Authentication → Users first.', v_member;
  end if;

  insert into public.households (name) values (v_name) on conflict (name) do nothing;
  select id into v_household from public.households where name = v_name;

  if exists (select 1 from public.households where id <> v_household) then
    raise exception 'Expected only the % to exist.', v_name;
  end if;

  insert into public.household_members (household_id, user_id, role)
  values (v_household, v_owner_id, 'owner'), (v_household, v_member_id, 'member')
  on conflict (household_id, user_id) do nothing;
end;
$$;

-- The signed-in user's household (null if they aren't in one).
-- TEMPORARY fallback, removed in 005: nobody signed in (the currently
-- deployed app) means the only household.
create or replace function public.current_household_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select household_id from household_members where user_id = auth.uid()),
    case when auth.uid() is null and (select count(*) from households) = 1
         then (select id from households) end
  );
$$;

-- Same, but stops with a clear message when there's no household.
create or replace function public.require_household_id()
returns uuid
language plpgsql
stable
set search_path = public
as $$
declare
  v uuid := current_household_id();
begin
  if v is null then
    raise exception 'This account isn''t part of a household yet.';
  end if;
  return v;
end;
$$;

grant execute on function public.current_household_id() to anon, authenticated;
grant execute on function public.require_household_id() to anon, authenticated;

-- ============================================================
-- household_id on every budget table
-- ============================================================

do $$
declare
  t text;
  v_household uuid := (select id from public.households);
begin
  foreach t in array array['budget_defaults', 'categories', 'fixed_cost_templates', 'pay_periods',
                           'period_categories', 'expenses', 'fixed_costs'] loop
    execute format('alter table public.%I add column if not exists household_id uuid references public.households(id)', t);
    execute format('update public.%I set household_id = $1 where household_id is null', t) using v_household;
    execute format('alter table public.%I alter column household_id set default public.current_household_id()', t);
    execute format('alter table public.%I alter column household_id set not null', t);
  end loop;
end;
$$;

-- ============================================================
-- period_extra_carry: now per household
-- (replaced before budget_defaults loses its id column, which it used)
-- ============================================================

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
           - coalesce(x.total, 0) as extra_left
  from pay_periods pp
  join budget_defaults d on d.household_id = pp.household_id
  left join fixed f on f.period_id = pp.id
  left join budgets b on b.period_id = pp.id
  left join extra_spend x on x.period_id = pp.id
  where pp.start_date >= d.carry_start
)
select id as period_id,
       coalesce(sum(extra_left) over (partition by household_id order by start_date
                                      rows between unbounded preceding and 1 preceding), 0)::integer
         as carry_in
from leftover;

-- ============================================================
-- Keys: one of each per household
-- ============================================================

-- Drop the old (year, month, start_day) unique key, whatever it's called.
do $$
declare
  c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.pay_periods'::regclass and contype = 'u'
      and conname <> 'pay_periods_household_period_key'
  loop
    execute format('alter table public.pay_periods drop constraint %I', c);
  end loop;
end;
$$;
alter table public.pay_periods drop constraint if exists pay_periods_household_period_key;
alter table public.pay_periods
  add constraint pay_periods_household_period_key unique (household_id, year, month, start_day);

drop index if exists public.categories_single_remainder;
create unique index categories_single_remainder
  on public.categories (household_id) where is_remainder;

-- budget_defaults: one row per household instead of the single id = 1 row.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'budget_defaults' and column_name = 'id') then
    alter table public.budget_defaults drop constraint if exists budget_defaults_pkey;
    alter table public.budget_defaults drop column id;
    alter table public.budget_defaults add primary key (household_id);
  end if;
end;
$$;

-- ============================================================
-- expenses_link_category: look up categories within the row's household
-- ============================================================

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
       where household_id = new.household_id and lower(name) = lower(new.category)
       order by is_active desc, id limit 1),
      (select id from categories
       where household_id = new.household_id and is_remainder));
  end if;
  return new;
end;
$$;

-- ============================================================
-- ensure_period
-- ============================================================

create or replace function public.ensure_period(p_year integer, p_month integer, p_start_day integer)
returns public.pay_periods
language plpgsql
set search_path = public
as $$
declare
  v_household uuid := require_household_id();
  v pay_periods;
begin
  select * into v from pay_periods
  where household_id = v_household
    and year = p_year and month = p_month and start_day = p_start_day;
  if found then
    return v;
  end if;

  if not exists (select 1 from budget_defaults where household_id = v_household) then
    raise exception 'This household has no default budget set up.';
  end if;

  insert into pay_periods (household_id, year, month, start_day, starting_amount)
  select v_household, p_year, p_month, p_start_day, d.starting_amount
  from budget_defaults d where d.household_id = v_household
  on conflict (household_id, year, month, start_day) do nothing
  returning * into v;

  if not found then
    -- Another device created it at the same moment; use theirs.
    select * into v from pay_periods
    where household_id = v_household
      and year = p_year and month = p_month and start_day = p_start_day;
    return v;
  end if;

  insert into period_categories (household_id, period_id, category_id, amount)
  select v_household, v.id, c.id, c.default_amount
  from categories c
  where c.household_id = v_household and c.is_active and not c.is_remainder;

  -- An older app may already have written this period's fixed costs by name.
  update fixed_costs fc
  set template_id = t.id
  from fixed_cost_templates t
  where fc.household_id = v_household and t.household_id = v_household
    and fc.template_id is null
    and t.is_active and t.half = p_start_day
    and lower(t.name) = lower(fc.name)
    and fc.year = p_year and fc.month = p_month and fc.period_start_day = p_start_day;

  insert into fixed_costs (household_id, period_start_day, month, year, name, amount, is_paid, template_id)
  select v_household, p_start_day, p_month, p_year, t.name, t.default_amount, false, t.id
  from fixed_cost_templates t
  where t.household_id = v_household
    and t.is_active and t.half = p_start_day
    and not exists (
      select 1 from fixed_costs fc
      where fc.household_id = v_household
        and fc.template_id = t.id
        and fc.year = p_year and fc.month = p_month and fc.period_start_day = p_start_day);

  return v;
end;
$$;

-- ============================================================
-- save_settings (same rules as 001, scoped to the caller's household)
--
-- Past period   (starts before p_today_start): changes only that period.
-- Current/future period: changes the defaults, that period, and every later
--   period that already exists. Earlier periods are never touched.
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
  v_household uuid := require_household_id();
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
    join categories c
      on c.household_id = v_household and c.is_remainder
     and lower(c.name) = lower(trim(e->>'name'))
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
          and household_id = v_household
          and year = p_year and month = p_month and period_start_day = p_start_day
        returning id into v_id;
      else
        insert into fixed_costs (household_id, period_start_day, month, year, name, amount, is_paid)
        values (v_household, p_start_day, p_month, p_year, trim(r->>'name'), (r->>'amount')::integer, false)
        returning id into v_id;
      end if;
      if v_id is not null then
        v_keep_fixed := v_keep_fixed || v_id;
      end if;
    end loop;

    delete from fixed_costs
    where household_id = v_household
      and year = p_year and month = p_month and period_start_day = p_start_day
      and id <> all (v_keep_fixed);
    return;
  end if;

  -- ---------- current/future period: defaults + this period onward ----------
  update budget_defaults set starting_amount = p_starting where household_id = v_household;
  update pay_periods set starting_amount = p_starting
  where household_id = v_household and start_date >= v.start_date;

  -- Categories
  for r in select value from jsonb_array_elements(p_categories) loop
    v_sort := v_sort + 1;
    v_name := trim(r->>'name');
    v_amount := (r->>'amount')::integer;

    if r->>'id' is null then
      insert into categories (household_id, name, color, default_amount, sort_order)
      values (v_household, v_name, coalesce(r->>'color', '#7CA3F2'), v_amount, v_sort)
      returning id into v_id;
    else
      v_id := (r->>'id')::bigint;
      update categories
      set name = v_name, default_amount = v_amount, sort_order = v_sort, is_active = true
      where id = v_id and household_id = v_household and not is_remainder;
      if not found then
        raise exception 'Category % wasn''t found.', v_name;
      end if;
    end if;
    v_keep_cats := v_keep_cats || v_id;

    insert into period_categories (household_id, period_id, category_id, amount)
    select v_household, pp.id, v_id, v_amount
    from pay_periods pp
    where pp.household_id = v_household and pp.start_date >= v.start_date
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
    where e.household_id = v_household
      and e.category_id = v_id
      and make_date(e.year, e.month, e.period_start_day) >= v.start_date;
    if v_count > 0 then
      raise exception 'Can''t remove %: it has % expense(s) in this or a later period. Move or delete them first.',
        v_name, v_count;
    end if;

    update categories set is_active = false where id = v_id and household_id = v_household;
    delete from period_categories pc
    using pay_periods pp
    where pc.period_id = pp.id and pc.category_id = v_id
      and pp.household_id = v_household and pp.start_date >= v.start_date;
  end loop;

  -- Fixed costs (only periods in the same half of the month)
  for r in select value from jsonb_array_elements(p_fixed) loop
    v_name := trim(r->>'name');
    v_amount := (r->>'amount')::integer;
    v_id := (r->>'template_id')::bigint;

    if v_id is null then
      insert into fixed_cost_templates (household_id, half, name, default_amount)
      values (v_household, p_start_day, v_name, v_amount)
      returning id into v_id;

      -- Adopt same-named rows that aren't linked yet (this period's own row,
      -- or rows an older app wrote) instead of adding duplicates.
      update fixed_costs
      set template_id = v_id
      where household_id = v_household
        and template_id is null
        and lower(name) = lower(v_name)
        and period_start_day = p_start_day
        and make_date(year, month, period_start_day) >= v.start_date;
      if r->>'id' is not null then
        update fixed_costs set template_id = v_id
        where id = (r->>'id')::bigint and household_id = v_household;
      end if;
    else
      update fixed_cost_templates
      set name = v_name, default_amount = v_amount, is_active = true
      where id = v_id and household_id = v_household;
      if not found then
        raise exception 'Fixed cost % wasn''t found.', v_name;
      end if;
    end if;
    v_keep_templates := v_keep_templates || v_id;

    update fixed_costs
    set name = v_name, amount = v_amount
    where household_id = v_household
      and template_id = v_id
      and period_start_day = p_start_day
      and make_date(year, month, period_start_day) >= v.start_date;

    insert into fixed_costs (household_id, period_start_day, month, year, name, amount, is_paid, template_id)
    select v_household, p_start_day, pp.month, pp.year, v_name, v_amount, false, v_id
    from pay_periods pp
    where pp.household_id = v_household
      and pp.start_day = p_start_day
      and pp.start_date >= v.start_date
      and not exists (
        select 1 from fixed_costs fc
        where fc.household_id = v_household
          and fc.template_id = v_id
          and fc.year = pp.year and fc.month = pp.month and fc.period_start_day = pp.start_day);
  end loop;

  -- Fixed costs removed from this period's list
  select coalesce(array_agg(distinct template_id), '{}') into v_removed
  from fixed_costs
  where household_id = v_household
    and year = p_year and month = p_month and period_start_day = p_start_day
    and template_id is not null
    and template_id <> all (v_keep_templates);

  update fixed_cost_templates set is_active = false
  where household_id = v_household and id = any (v_removed);

  delete from fixed_costs
  where household_id = v_household
    and template_id = any (v_removed)
    and period_start_day = p_start_day
    and make_date(year, month, period_start_day) >= v.start_date;

  -- Anything in this period still unlinked was removed in the form
  -- (rows that were kept got a template above).
  delete from fixed_costs
  where household_id = v_household
    and year = p_year and month = p_month and period_start_day = p_start_day
    and template_id is null;
end;
$$;

-- ============================================================
-- start_period
-- ============================================================

create or replace function public.start_period(
  p_year integer, p_month integer, p_start_day integer, p_starts_on date)
returns public.pay_periods
language plpgsql
set search_path = public
as $$
declare
  v_household uuid := require_household_id();
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
  where household_id = v_household and start_date < v.start_date
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
  where household_id = v_household and start_date > v.start_date and starts_on is not null
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

-- ============================================================
-- household_info: for Settings → Household
-- ============================================================

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
      select jsonb_agg(jsonb_build_object('email', u.email, 'role', m.role, 'is_me', m.user_id = auth.uid())
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

-- ============================================================
-- Access
-- ============================================================

-- New tables: signed-in members can read their own household.
alter table public.households enable row level security;
alter table public.household_members enable row level security;
revoke all on public.households, public.household_members from anon;
revoke insert, update, delete on public.households, public.household_members from authenticated;
grant select on public.households, public.household_members to authenticated;

drop policy if exists "household members" on public.households;
create policy "household members" on public.households
  for select to authenticated using (id = (select public.current_household_id()));

drop policy if exists "household members" on public.household_members;
create policy "household members" on public.household_members
  for select to authenticated using (household_id = (select public.current_household_id()));

-- Budget tables: the policy that stays after 005. Until then the existing
-- open policies still apply too. RLS itself isn't switched on here (005 does
-- that), in case expenses or fixed_costs don't have it on yet — turning it
-- on now would cut off the live app.
grant select, insert, update, delete on
  public.budget_defaults, public.categories, public.fixed_cost_templates, public.pay_periods,
  public.period_categories, public.expenses, public.fixed_costs
to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant select on public.period_extra_carry to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['budget_defaults', 'categories', 'fixed_cost_templates', 'pay_periods',
                           'period_categories', 'expenses', 'fixed_costs'] loop
    execute format('drop policy if exists "household members" on public.%I', t);
    execute format('create policy "household members" on public.%I for all to authenticated '
                   'using (household_id = (select public.current_household_id())) '
                   'with check (household_id = (select public.current_household_id()))', t);
  end loop;
end;
$$;

commit;

notify pgrst, 'reload schema';

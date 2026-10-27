-- Chores (see docs/chores-plan.md).
--
--   * Kids join the household with the new role 'kid' and a display name.
--     Their accounts are made first in Authentication → Users (see the
--     plan); their emails are listed just below.
--   * Kids are shut out of the budget: current_household_id() — which every
--     budget table, view and function already checks — now only answers for
--     owner/member. member_household_id() answers for everyone and is what
--     chores and notification phones use.
--   * New tables chores, chore_tasks, kid_ledger, kid_goals (+ view
--     kid_balances). A chore with no kid is for "Anyone": it shows on every
--     kid's list and the first to mark it done claims it. Everyone signed in can only READ them, and a kid only
--     their own rows; every change goes through the functions below, which
--     check who's asking.
--   * Notifications: a chore marked done, approved or sent back, and a bonus,
--     call the notify-purchase Edge Function (updated alongside this).
--
-- Parents see no difference, so the deployed app keeps working.
-- Safe to run more than once.

begin;

-- ============================================================
-- Kids in the household
-- ============================================================

alter table public.household_members add column if not exists display_name text;
alter table public.household_members drop constraint if exists household_members_role_check;
alter table public.household_members
  add constraint household_members_role_check check (role in ('owner', 'member', 'kid'));

do $$
declare
  v_household constant text := 'Mabry Household';
  -- Display name, sign-in email (must match js/config.js → kidEmail()).
  v_kids constant text[][] := array[
    array['Luke',    'luke@kids.cadence.invalid'],
    array['Adeline', 'adeline@kids.cadence.invalid']
  ];
  v_household_id uuid;
  v_user uuid;
  i int;
begin
  select id into v_household_id from public.households where name = v_household;
  if v_household_id is null then
    raise exception 'Couldn''t find the household "%".', v_household;
  end if;

  for i in 1 .. array_length(v_kids, 1) loop
    select id into v_user from auth.users where lower(email) = lower(v_kids[i][2]);
    if v_user is null then
      raise exception 'There''s no account for % (%) yet. Add it in Authentication → Users first.',
        v_kids[i][1], v_kids[i][2];
    end if;
    insert into public.household_members (household_id, user_id, role, display_name)
    values (v_household_id, v_user, 'kid', v_kids[i][1])
    on conflict (household_id, user_id) do update
      set display_name = excluded.display_name
      where public.household_members.role = 'kid';
  end loop;
end;
$$;

-- ============================================================
-- Who's asking
-- ============================================================

-- The household of anyone signed in, kids included (null if none).
create or replace function public.member_household_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id from household_members where user_id = auth.uid();
$$;

-- 'owner' | 'member' | 'kid', or null.
create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from household_members where user_id = auth.uid();
$$;

-- The budget's household: parents only. Every budget table policy, the
-- carry-over view and every budget function go through this, so for a kid
-- they all see nothing (or say "isn't part of a household yet").
create or replace function public.current_household_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id from household_members
  where user_id = auth.uid() and role in ('owner', 'member');
$$;

create or replace function public.is_parent()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role in ('owner', 'member') from household_members where user_id = auth.uid()), false);
$$;

create or replace function public.require_parent()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v uuid := current_household_id();
begin
  if v is null then
    raise exception 'Only a parent can do that.';
  end if;
  return v;
end;
$$;

-- Settings → Household. Parents: name, their role and every member (kids
-- with their names). A kid: just themselves — no emails, no budget.
create or replace function public.household_info()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when me.role = 'kid' then
    jsonb_build_object(
      'name', h.name, 'role', me.role, 'user_id', me.user_id, 'display_name', me.display_name,
      'members', '[]'::jsonb)
  else
    jsonb_build_object(
      'name', h.name,
      'role', me.role,
      'user_id', me.user_id,
      'members', (
        select jsonb_agg(jsonb_build_object(
                 'user_id', m.user_id, 'email', u.email, 'role', m.role,
                 'display_name', m.display_name, 'is_me', m.user_id = auth.uid())
               order by case m.role when 'owner' then 0 when 'member' then 1 else 2 end,
                        coalesce(m.display_name, u.email))
        from household_members m
        join auth.users u on u.id = m.user_id
        where m.household_id = h.id))
  end
  from household_members me
  join households h on h.id = me.household_id
  where me.user_id = auth.uid();
$$;

revoke execute on function public.member_household_id(), public.my_role(), public.is_parent(),
  public.require_parent(), public.household_info() from public, anon;
grant execute on function public.member_household_id(), public.my_role(), public.is_parent(),
  public.require_parent(), public.household_info() to authenticated;

-- Kids' iPads can get notifications too (their own only — the sender keeps
-- card purchases to parents).
alter table public.push_subscriptions alter column household_id set default public.member_household_id();
drop policy if exists "own phones" on public.push_subscriptions;
create policy "own phones" on public.push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid()) and household_id = (select public.member_household_id()))
  with check (user_id = (select auth.uid()) and household_id = (select public.member_household_id()));

-- ============================================================
-- Tables
-- ============================================================

-- A chore as a parent set it up.
create table if not exists public.chores (
  id bigint generated always as identity primary key,
  household_id uuid not null default public.member_household_id() references public.households(id),
  kid_id uuid references auth.users(id) on delete cascade,              -- null = anyone
  title text not null check (length(btrim(title)) between 1 and 80),
  amount integer not null check (amount between 0 and 1000),            -- whole dollars
  repeat text not null default 'once' check (repeat in ('once', 'daily', 'weekly')),
  weekdays smallint[] not null default '{}',  -- weekly only: 0 = Sun … 6 = Sat; empty = any day that week
  active boolean not null default true,       -- false = deleted, or a one-time chore that's been approved
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Each time a chore is due. Repeating chores get one per day (daily), per
-- chosen weekday, or per week (due Sunday) — created the first time anyone
-- opens Chores that day. Missed ones just expire; no money comes off.
create table if not exists public.chore_tasks (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id),
  chore_id bigint not null references public.chores(id) on delete cascade,
  kid_id uuid references auth.users(id) on delete cascade,   -- null = anyone, until a kid claims it by marking it done
  due_on date not null,
  amount integer not null check (amount >= 0),  -- copied when created, so later price changes don't rewrite history
  status text not null default 'open'
    check (status in ('open', 'done', 'approved', 'sent_back', 'expired')),
  note text,                                    -- a parent's "sent back" note
  done_at timestamptz,
  done_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  notified_status text,                         -- set by the sender: each change announced once
  updated_at timestamptz not null default now(),
  unique (chore_id, due_on)
);
create index if not exists chore_tasks_household_status on public.chore_tasks (household_id, status);

-- Every money movement. A kid's balance is the sum (never stored).
create table if not exists public.kid_ledger (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id),
  kid_id uuid not null references auth.users(id) on delete cascade,
  amount integer not null check (amount <> 0),   -- + earned, − paid out
  kind text not null check (kind in ('chore', 'payout', 'bonus')),
  task_id bigint unique references public.chore_tasks(id) on delete set null,
  note text,                                     -- the chore's name, or the parent's note
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  notified_at timestamptz
);
create index if not exists kid_ledger_kid on public.kid_ledger (kid_id, created_at);

-- One savings goal per kid, set by the kid.
create table if not exists public.kid_goals (
  kid_id uuid primary key references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id),
  name text not null check (length(btrim(name)) between 1 and 60),
  target integer not null check (target between 1 and 100000),
  updated_at timestamptz not null default now()
);

create or replace view public.kid_balances
with (security_invoker = true)
as
select kid_id, sum(amount)::integer as balance
from kid_ledger
group by kid_id;

-- Read-only from the app: parents see the household's, a kid only their own
-- (plus "Anyone" chores nobody has claimed yet).
do $$
declare
  t text;
begin
  foreach t in array array['chores', 'chore_tasks', 'kid_ledger', 'kid_goals'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "household chores" on public.%I', t);
    execute format('create policy "household chores" on public.%I for select to authenticated '
                   'using (household_id = (select public.member_household_id()) '
                   'and ((select public.is_parent()) or kid_id = (select auth.uid()) or kid_id is null))', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end;
$$;

revoke all on public.kid_balances from anon;
grant select on public.kid_balances to authenticated;

-- ============================================================
-- Helpers
-- ============================================================

-- "Today" as the device sees it, but only within a day of the server's
-- date, so nobody can make next week's chores early.
create or replace function public.chore_day(p_today date)
returns date
language sql
stable
as $$
  select case
    when p_today between (now() at time zone 'utc')::date - 1 and (now() at time zone 'utc')::date + 1
      then p_today
    else (now() at time zone 'utc')::date
  end;
$$;

-- The Sunday that ends this date's week (Monday–Sunday).
create or replace function public.chore_week_end(p_day date)
returns date
language sql
immutable
as $$
  select p_day + ((7 - extract(isodow from p_day)::int) % 7);
$$;

create or replace function public.kid_balance(p_kid uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(amount), 0)::integer from kid_ledger where kid_id = p_kid;
$$;

-- A kid in the parent's household, or a clear error.
create or replace function public.require_kid(p_household uuid, p_kid uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from household_members
                 where household_id = p_household and user_id = p_kid and role = 'kid') then
    raise exception 'Pick one of the kids.';
  end if;
end;
$$;

-- Approves a task: adds its money and, for a one-time chore, retires it.
-- Internal (called by review_chore and mark_chore_done).
create or replace function public.approve_chore_task(p_task bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t chore_tasks%rowtype;
  c chores%rowtype;
begin
  update chore_tasks
  set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid(), note = null, updated_at = now(),
      done_at = coalesce(done_at, now()), done_by = coalesce(done_by, auth.uid())
  where id = p_task
  returning * into t;
  select * into c from chores where id = t.chore_id;
  if t.amount > 0 then
    insert into kid_ledger (household_id, kid_id, amount, kind, task_id, note)
    values (t.household_id, t.kid_id, t.amount, 'chore', t.id, c.title)
    on conflict (task_id) do nothing;
  end if;
  if c.repeat = 'once' then
    update chores set active = false where id = c.id;
  end if;
end;
$$;

-- ============================================================
-- What the app calls
-- ============================================================

-- Run when Chores opens: expires missed repeating tasks and creates today's.
create or replace function public.ensure_chore_tasks(p_today date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid := member_household_id();
  v_day date := chore_day(p_today);
  v_dow smallint := extract(dow from v_day)::smallint;
begin
  if v_household is null then
    raise exception 'This account isn''t part of a household yet.';
  end if;

  update chore_tasks t
  set status = 'expired', updated_at = now()
  from chores c
  where c.id = t.chore_id and t.household_id = v_household and c.repeat <> 'once'
    and t.status in ('open', 'sent_back') and t.due_on < v_day;

  insert into chore_tasks (household_id, chore_id, kid_id, due_on, amount)
  select c.household_id, c.id, c.kid_id,
         case when c.repeat = 'weekly' and cardinality(c.weekdays) = 0 then chore_week_end(v_day) else v_day end,
         c.amount
  from chores c
  where c.household_id = v_household and c.active
    and (c.repeat = 'daily'
         or (c.repeat = 'weekly' and (cardinality(c.weekdays) = 0 or v_dow = any(c.weekdays))))
  on conflict (chore_id, due_on) do nothing;
end;
$$;

-- Add (p_id null) or change a chore. Parents only. p_kid null = anyone.
create or replace function public.save_chore(
  p_id bigint, p_kid uuid, p_title text, p_amount integer, p_repeat text, p_weekdays smallint[], p_today date)
returns bigint
language plpgsql
security definer
set search_path = public
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
  if p_amount is null or p_amount < 0 or p_amount > 1000 then
    raise exception 'The amount must be whole dollars, $0 to $1,000.';
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
      -- Keep its one task, with the new kid and amount; make one if it had none.
      -- (A sent-back task stays with the kid who did it if it's now "anyone".)
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
      -- Still-to-do tasks are made again from the new settings.
      delete from chore_tasks where chore_id = v_id and status in ('open', 'sent_back');
    end if;
  end if;

  perform ensure_chore_tasks(v_day);
  return v_id;
end;
$$;

-- Parents only. Keeps its history; chores already marked done can still be reviewed.
create or replace function public.delete_chore(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid := require_parent();
begin
  update chores set active = false where id = p_id and household_id = v_household;
  delete from chore_tasks where chore_id = p_id and status in ('open', 'sent_back');
end;
$$;

-- A kid: "I did it" → waits for a parent; an "Anyone" chore becomes theirs
-- (first one wins). A parent (doing it for a kid): done and approved in one
-- step; for an "Anyone" chore they say which kid (p_kid).
drop function if exists public.mark_chore_done(bigint);
create or replace function public.mark_chore_done(p_task bigint, p_kid uuid default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid := member_household_id();
  t chore_tasks%rowtype;
begin
  select * into t from chore_tasks where id = p_task and household_id = v_household for update;
  if t.id is null then raise exception 'That chore wasn''t found.'; end if;

  if is_parent() then
    if t.status not in ('open', 'sent_back', 'done') then
      raise exception 'That chore was already handled.';
    end if;
    if t.kid_id is null then
      if p_kid is null then raise exception 'Pick who did it.'; end if;
      perform require_kid(v_household, p_kid);
      update chore_tasks set kid_id = p_kid where id = t.id;
    end if;
    perform approve_chore_task(t.id);
    return 'approved';
  end if;

  if t.kid_id is not null and t.kid_id <> auth.uid() then
    raise exception 'Someone else already did this one.';
  end if;
  if t.status = 'done' then return 'done'; end if;
  if t.status not in ('open', 'sent_back') then
    raise exception 'This chore isn''t open any more.';
  end if;
  update chore_tasks
  set status = 'done', kid_id = auth.uid(), done_at = now(), done_by = auth.uid(), note = null, updated_at = now()
  where id = t.id;
  return 'done';
end;
$$;

-- A kid tapped Done by mistake (only until a parent has looked at it). An
-- "Anyone" chore goes back to everyone.
create or replace function public.undo_chore_done(p_task bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update chore_tasks t
  set status = 'open', done_at = null, done_by = null, notified_status = null, updated_at = now(),
      kid_id = case when c.kid_id is null and t.reviewed_by is null then null else t.kid_id end
  from chores c
  where t.id = p_task and c.id = t.chore_id and t.kid_id = auth.uid() and t.status = 'done';
  if not found then raise exception 'A parent has already looked at this one.'; end if;
end;
$$;

-- Parents: approve, or send back with an optional note. First parent wins.
create or replace function public.review_chore(p_task bigint, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid := require_parent();
  t chore_tasks%rowtype;
begin
  select * into t from chore_tasks where id = p_task and household_id = v_household for update;
  if t.id is null then raise exception 'That chore wasn''t found.'; end if;
  if t.status <> 'done' then raise exception 'Already reviewed (maybe on the other phone).'; end if;

  if p_approve then
    perform approve_chore_task(t.id);
  else
    update chore_tasks
    set status = 'sent_back', note = nullif(left(btrim(coalesce(p_note, '')), 140), ''),
        reviewed_at = now(), reviewed_by = auth.uid(), updated_at = now()
    where id = t.id;
  end if;
end;
$$;

-- Parents: money handed over. Can't take a balance below $0.
create or replace function public.pay_out(p_kid uuid, p_amount integer, p_note text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid := require_parent();
  v_balance integer;
begin
  perform require_kid(v_household, p_kid);
  perform pg_advisory_xact_lock(hashtext('kid_ledger:' || p_kid::text));
  v_balance := kid_balance(p_kid);
  if p_amount is null or p_amount < 1 then raise exception 'Enter how much you paid out.'; end if;
  if p_amount > v_balance then
    raise exception 'That''s more than the balance (%).', '$' || v_balance;
  end if;
  insert into kid_ledger (household_id, kid_id, amount, kind, note)
  values (v_household, p_kid, -p_amount, 'payout', nullif(left(btrim(coalesce(p_note, '')), 140), ''));
  return v_balance - p_amount;
end;
$$;

-- Parents: extra money outside of chores.
create or replace function public.add_bonus(p_kid uuid, p_amount integer, p_note text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid := require_parent();
begin
  perform require_kid(v_household, p_kid);
  if p_amount is null or p_amount < 1 or p_amount > 1000 then
    raise exception 'A bonus must be whole dollars, $1 to $1,000.';
  end if;
  insert into kid_ledger (household_id, kid_id, amount, kind, note)
  values (v_household, p_kid, p_amount, 'bonus', nullif(left(btrim(coalesce(p_note, '')), 140), ''));
  return kid_balance(p_kid);
end;
$$;

-- Parents: take back a history entry entered by mistake. Undoing a chore's
-- money puts the chore back in "Waiting for you".
create or replace function public.remove_ledger_entry(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid := require_parent();
  e kid_ledger%rowtype;
begin
  select * into e from kid_ledger where id = p_id and household_id = v_household;
  if e.id is null then raise exception 'That entry wasn''t found.'; end if;
  perform pg_advisory_xact_lock(hashtext('kid_ledger:' || e.kid_id::text));
  if kid_balance(e.kid_id) - e.amount < 0 then
    raise exception 'That money has already been paid out.';
  end if;
  delete from kid_ledger where id = e.id;
  if e.task_id is not null then
    update chore_tasks
    set status = 'done', reviewed_at = null, reviewed_by = null, notified_status = 'done', updated_at = now()
    where id = e.task_id;
    update chores c set active = true
    from chore_tasks t
    where t.id = e.task_id and c.id = t.chore_id and c.repeat = 'once';
  end if;
end;
$$;

-- Kids: their own savings goal.
create or replace function public.set_goal(p_name text, p_target integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid := member_household_id();
  v_name text := btrim(coalesce(p_name, ''));
begin
  if my_role() is distinct from 'kid' then raise exception 'Goals are set by the kids.'; end if;
  if v_name = '' then raise exception 'What are you saving for?'; end if;
  if length(v_name) > 60 then raise exception 'Keep it under 60 characters.'; end if;
  if p_target is null or p_target < 1 or p_target > 100000 then
    raise exception 'How much does it cost? Whole dollars.';
  end if;
  insert into kid_goals (kid_id, household_id, name, target)
  values (auth.uid(), v_household, v_name, p_target)
  on conflict (kid_id) do update set name = excluded.name, target = excluded.target, updated_at = now();
end;
$$;

create or replace function public.clear_goal()
returns void
language sql
security definer
set search_path = public
as $$
  delete from kid_goals where kid_id = auth.uid();
$$;

revoke execute on function
  public.chore_day(date), public.chore_week_end(date), public.kid_balance(uuid), public.require_kid(uuid, uuid),
  public.approve_chore_task(bigint),
  public.ensure_chore_tasks(date),
  public.save_chore(bigint, uuid, text, integer, text, smallint[], date),
  public.delete_chore(bigint), public.mark_chore_done(bigint, uuid), public.undo_chore_done(bigint),
  public.review_chore(bigint, boolean, text), public.pay_out(uuid, integer, text),
  public.add_bonus(uuid, integer, text), public.remove_ledger_entry(bigint),
  public.set_goal(text, integer), public.clear_goal()
from public, anon, authenticated;

grant execute on function
  public.ensure_chore_tasks(date),
  public.save_chore(bigint, uuid, text, integer, text, smallint[], date),
  public.delete_chore(bigint), public.mark_chore_done(bigint, uuid), public.undo_chore_done(bigint),
  public.review_chore(bigint, boolean, text), public.pay_out(uuid, integer, text),
  public.add_bonus(uuid, integer, text), public.remove_ledger_entry(bigint),
  public.set_goal(text, integer), public.clear_goal()
to authenticated;

-- ============================================================
-- Notifications
-- ============================================================

create or replace function public.notify_chore_change()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_body jsonb;
begin
  if tg_table_name = 'chore_tasks' then
    if new.status is not distinct from old.status or new.status not in ('done', 'approved', 'sent_back') then
      return new;
    end if;
    v_body := jsonb_build_object('chore_task_id', new.id);
  else
    if new.kind <> 'bonus' then return new; end if;
    v_body := jsonb_build_object('ledger_id', new.id);
  end if;

  begin
    perform net.http_post(
      url := 'https://ffjaqdtdoqkvlrcfqnrx.supabase.co/functions/v1/notify-purchase',
      body := v_body,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', 'sb_publishable_lwdziY_FYlVNYoTh-Z2oTw_3SoDNDNr'),
      timeout_milliseconds := 5000
    );
  exception when others then
    null; -- only a heads-up; never block the change itself
  end;
  return new;
end;
$$;

revoke execute on function public.notify_chore_change() from public, anon, authenticated;

drop trigger if exists chore_tasks_notify on public.chore_tasks;
create trigger chore_tasks_notify
  after update of status on public.chore_tasks
  for each row execute function public.notify_chore_change();

drop trigger if exists kid_ledger_notify on public.kid_ledger;
create trigger kid_ledger_notify
  after insert on public.kid_ledger
  for each row execute function public.notify_chore_change();

commit;

notify pgrst, 'reload schema';

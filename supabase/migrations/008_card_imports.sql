-- Card purchase alerts + "Paid from savings" (see docs/card-imports-plan.md).
--
--   * card_imports: purchases read from card alert emails by the Gmail
--     script (gmail-script/cadence-alerts.gs). They wait here as "pending"
--     until someone reviews them in the app, which turns each one into a
--     normal expense ("added") or throws it away ("dismissed").
--   * import_card_alert(): the only way in. The Gmail script calls it with
--     the publishable key plus the household's import key; nothing else is
--     reachable without signing in (the 005 lock-down still holds).
--   * card_import_keys + new_card_import_key(): one secret import key per
--     household, stored only as a hash. Run by the owner in the SQL editor.
--   * household_members.cardholder_name: the first name printed on alerts
--     ("MABRY,LYDIA" → Lydia), so an imported purchase gets that person's dot.
--   * expenses.from_savings: paid out of savings — shown, but never counted
--     against a category, Extra, carry-over or Insights.
--   * expenses.card_import_id: which alert an expense came from; unique, so
--     the same alert can't be added twice from two phones.
--   * Bills paid on a card: pay_bill_from_import() marks the matching bill
--     paid (status 'bill'), sets that period's amount to what was charged,
--     and remembers the store in bill_merchants so it's matched next time.
--
-- Everything here is new columns/tables with defaults, so the deployed app
-- keeps working until the new code is pushed. Safe to run more than once.

begin;

-- ---------- Who's who on the cards ----------

alter table public.household_members add column if not exists cardholder_name text;

update public.household_members m
set cardholder_name = v.name
from auth.users u,
     (values ('mabryz@gmail.com', 'Zachary'), ('mabrylh@gmail.com', 'Lydia')) as v(email, name)
where u.id = m.user_id and lower(u.email) = v.email and m.cardholder_name is null;

-- ---------- Imported purchases ----------

create table if not exists public.card_imports (
  id bigint generated always as identity primary key,
  household_id uuid not null default public.current_household_id() references public.households(id),
  message_id text not null,                 -- Gmail's id for the alert email
  card text not null,                       -- a Cadence card value (expenses_card_check)
  account text,                             -- "Chase Sapphire Reserve Visa"
  last4 text,
  cardholder text,                          -- first name from the alert
  cardholder_user_id uuid references auth.users(id) on delete set null,
  merchant text,                            -- tidied: "Ramst Golf Course"
  merchant_raw text,                        -- as the bank wrote it
  amount_cents integer check (amount_cents > 0),
  occurred_at timestamptz not null,
  received_at timestamptz,
  subject text,
  unreadable boolean not null default false,  -- looked like an alert but couldn't be read
  status text not null default 'pending',  -- pending | added | dismissed | bill (see below)
  created_at timestamptz not null default now(),
  unique (household_id, message_id)
);

alter table public.card_imports drop constraint if exists card_imports_status_check;
alter table public.card_imports add constraint card_imports_status_check
  check (status in ('pending', 'added', 'dismissed', 'bill'));

create index if not exists card_imports_pending_idx
  on public.card_imports (household_id, occurred_at) where status = 'pending';

alter table public.card_imports enable row level security;

drop policy if exists "household members" on public.card_imports;
create policy "household members" on public.card_imports
  for all to authenticated
  using (household_id = (select public.current_household_id()))
  with check (household_id = (select public.current_household_id()));

revoke all on public.card_imports from anon, authenticated;
grant select, update on public.card_imports to authenticated;

-- ---------- Expenses: savings, and which alert they came from ----------

alter table public.expenses add column if not exists from_savings boolean not null default false;
alter table public.expenses add column if not exists card_import_id bigint
  references public.card_imports(id) on delete set null;
create unique index if not exists expenses_card_import_id_key
  on public.expenses (card_import_id) where card_import_id is not null;

-- ---------- Bills paid on a card ----------

-- Which alert paid a bill (for the "Paid by Chase alert" note in Bills).
alter table public.fixed_costs add column if not exists paid_by_import_id bigint
  references public.card_imports(id) on delete set null;

-- Stores learned as a bill: merchant_key is merchantKey() in js/merchants.js
-- ("tkscable"). Linked to the bill's template so it holds every period;
-- bill_name is the fallback for bills added to one period only.
create table if not exists public.bill_merchants (
  household_id uuid not null default public.current_household_id() references public.households(id),
  merchant_key text not null check (merchant_key <> ''),
  template_id bigint references public.fixed_cost_templates(id) on delete cascade,
  bill_name text not null,
  created_at timestamptz not null default now(),
  primary key (household_id, merchant_key)
);

alter table public.bill_merchants enable row level security;

drop policy if exists "household members" on public.bill_merchants;
create policy "household members" on public.bill_merchants
  for all to authenticated
  using (household_id = (select public.current_household_id()))
  with check (household_id = (select public.current_household_id()));

revoke all on public.bill_merchants from anon;
grant select, insert, update, delete on public.bill_merchants to authenticated;

-- One step from the review sheet: the alert is settled as 'bill', the bill
-- is marked paid with this period's amount set to what was charged (whole
-- dollars, rounded by the app), and the store is remembered. Runs as the
-- signed-in person, so the usual household rules apply.
create or replace function public.pay_bill_from_import(
  p_import_id bigint, p_fixed_cost_id bigint, p_amount integer, p_merchant_key text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_bill fixed_costs%rowtype;
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'Amount must be whole dollars, 0 or more.';
  end if;

  update card_imports set status = 'bill' where id = p_import_id and status = 'pending';
  if not found then
    raise exception 'This purchase was already handled (maybe on the other phone).';
  end if;

  update fixed_costs
  set is_paid = true, amount = p_amount, paid_by_import_id = p_import_id
  where id = p_fixed_cost_id
  returning * into v_bill;
  if v_bill.id is null then
    raise exception 'That bill wasn''t found.';
  end if;

  if coalesce(btrim(p_merchant_key), '') <> '' then
    insert into bill_merchants (merchant_key, template_id, bill_name)
    values (btrim(p_merchant_key), v_bill.template_id, v_bill.name)
    on conflict (household_id, merchant_key)
    do update set template_id = excluded.template_id, bill_name = excluded.bill_name;
  end if;
end;
$$;

revoke execute on function public.pay_bill_from_import(bigint, bigint, integer, text) from public, anon;
grant execute on function public.pay_bill_from_import(bigint, bigint, integer, text) to authenticated;

-- ---------- Import keys ----------

create table if not exists public.card_import_keys (
  household_id uuid primary key references public.households(id) on delete cascade,
  key_hash text not null unique,
  created_at timestamptz not null default now()
);

alter table public.card_import_keys enable row level security;
revoke all on public.card_import_keys from anon, authenticated;

-- Makes (or replaces) a household's import key and returns it once. Only
-- the hash is kept, so copy it straight into the Gmail script. Replacing it
-- stops the old key working. Leave the name out when there's one household.
create or replace function public.new_card_import_key(p_household_name text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid;
  v_key text := 'cad_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if p_household_name is null then
    if (select count(*) from households) <> 1 then
      raise exception 'There''s more than one household; pass its name.';
    end if;
    select id into v_household from households;
  else
    select id into v_household from households where name = p_household_name;
    if v_household is null then
      raise exception 'No household called %', p_household_name;
    end if;
  end if;

  insert into card_import_keys (household_id, key_hash)
  values (v_household, encode(sha256(convert_to(v_key, 'UTF8')), 'hex'))
  on conflict (household_id) do update set key_hash = excluded.key_hash, created_at = now();
  return v_key;
end;
$$;

revoke execute on function public.new_card_import_key(text) from public, anon, authenticated;

-- ---------- The way in, for the Gmail script ----------
-- p_alert: { message_id, card, account, last4, cardholder, merchant,
--            merchant_raw, amount_cents, occurred_at, received_at, subject,
--            unreadable }. Sending the same email twice does nothing.
create or replace function public.import_card_alert(p_key text, p_alert jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid;
  v_unreadable boolean := coalesce((p_alert->>'unreadable')::boolean, false);
  v_card text := coalesce(p_alert->>'card', 'Other');
  v_amount integer;
  v_merchant text := left(nullif(btrim(p_alert->>'merchant'), ''), 100);
  v_holder uuid;
  v_id bigint;
begin
  select household_id into v_household
  from card_import_keys
  where key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex');
  if v_household is null then
    raise exception 'Unknown import key' using errcode = '28000';
  end if;

  if coalesce(p_alert->>'message_id', '') = '' then
    raise exception 'message_id is required' using errcode = '22023';
  end if;
  if v_card <> all (array['Chase', 'AMEX', 'Star Card', 'USAA', 'Other']) then
    v_card := 'Other';
  end if;

  if v_unreadable then
    v_merchant := null;
  else
    v_amount := (p_alert->>'amount_cents')::integer;
    if v_amount is null or v_amount <= 0 or v_amount > 100000000 or v_merchant is null then
      raise exception 'An alert needs a merchant and an amount' using errcode = '22023';
    end if;
  end if;

  select m.user_id into v_holder
  from household_members m
  where m.household_id = v_household
    and lower(m.cardholder_name) = lower(btrim(p_alert->>'cardholder'))
  limit 1;

  insert into card_imports (household_id, message_id, card, account, last4, cardholder, cardholder_user_id,
                            merchant, merchant_raw, amount_cents, occurred_at, received_at, subject, unreadable)
  values (v_household,
          left(p_alert->>'message_id', 200),
          v_card,
          left(p_alert->>'account', 100),
          left(p_alert->>'last4', 4),
          left(p_alert->>'cardholder', 50),
          v_holder,
          v_merchant,
          left(p_alert->>'merchant_raw', 200),
          v_amount,
          coalesce(nullif(p_alert->>'occurred_at', '')::timestamptz,
                   nullif(p_alert->>'received_at', '')::timestamptz, now()),
          nullif(p_alert->>'received_at', '')::timestamptz,
          left(p_alert->>'subject', 200),
          v_unreadable)
  on conflict (household_id, message_id) do nothing
  returning id into v_id;

  return jsonb_build_object('status', case when v_id is null then 'duplicate' else 'added' end);
end;
$$;

revoke execute on function public.import_card_alert(text, jsonb) from public;
grant execute on function public.import_card_alert(text, jsonb) to anon, authenticated;

-- ---------- Extra carry-over ignores savings purchases ----------
-- Same as 004's view, plus "and not e.from_savings".

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

revoke all on public.period_extra_carry from anon;
grant select on public.period_extra_carry to authenticated;

commit;

notify pgrst, 'reload schema';

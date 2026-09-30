-- Phone notifications for new card purchases (see docs/notifications-plan.md).
--
--   * push_subscriptions: one row per phone that turned notifications on in
--     Settings. Each person only sees and removes their own phones.
--   * card_imports.notified_at: set by the sender the first time it sends a
--     purchase, so a purchase is never announced twice.
--   * A trigger on card_imports calls the notify-purchase Edge Function
--     (supabase/functions/notify-purchase) with the new purchase's id. The
--     call happens after the purchase is saved and never holds it up; if the
--     function isn't there yet, nothing happens.
--
-- New table, column and trigger only, so the deployed app keeps working
-- until the new code is pushed. Safe to run more than once.

begin;

create extension if not exists pg_net with schema extensions;

-- ---------- Phones that get notifications ----------

create table if not exists public.push_subscriptions (
  id bigint generated always as identity primary key,
  household_id uuid not null default public.current_household_id() references public.households(id),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,          -- the phone's address at Apple/Google
  p256dh text not null,                   -- the phone's key for reading the message
  auth text not null,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

drop policy if exists "own phones" on public.push_subscriptions;
create policy "own phones" on public.push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid()) and household_id = (select public.current_household_id()))
  with check (user_id = (select auth.uid()) and household_id = (select public.current_household_id()));

revoke all on public.push_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- ---------- Each purchase is announced once ----------

alter table public.card_imports add column if not exists notified_at timestamptz;

-- ---------- New purchase → the sender ----------

create or replace function public.notify_new_card_import()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  begin
    perform net.http_post(
      url := 'https://ffjaqdtdoqkvlrcfqnrx.supabase.co/functions/v1/notify-purchase',
      body := jsonb_build_object('import_id', new.id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', 'sb_publishable_lwdziY_FYlVNYoTh-Z2oTw_3SoDNDNr'),
      timeout_milliseconds := 5000
    );
  exception when others then
    null; -- a notification is only a heads-up; never block saving a purchase
  end;
  return new;
end;
$$;

revoke execute on function public.notify_new_card_import() from public, anon, authenticated;

drop trigger if exists card_imports_notify on public.card_imports;
create trigger card_imports_notify
  after insert on public.card_imports
  for each row execute function public.notify_new_card_import();

commit;

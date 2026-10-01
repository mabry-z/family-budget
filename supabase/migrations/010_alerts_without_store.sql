-- Card alerts without a store name (Military Star). Star's emails give the
-- amount and time but no store, so import_card_alert() now only needs an
-- amount; the store is typed in when the purchase is reviewed. merchant_raw
-- keeps what the email said instead ("OTHER PURCHASES").
-- Same as 008's function apart from the merchant check. Safe to re-run.

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
    if v_amount is null or v_amount <= 0 or v_amount > 100000000 then
      raise exception 'An alert needs an amount' using errcode = '22023';
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

-- 0126: keep buyer↔seller chat on the platform.
--
-- Refuse a message that shares a phone number, UPI id, payment-app handle,
-- email or external link, so neither side can arrange an off-platform deal that
-- cuts out commission, delivery and buyer protection. This is the server-side
-- backstop for the app check in `src/lib/contactGuard.ts` — a direct API call
-- cannot get past the trigger. Keep the two in step.
--
-- Phone detection is deliberately narrow: this is a clothing marketplace where
-- "available in 36 38 40 42 44 46" is normal, so a phone is matched only as ten
-- CONTIGUOUS digits or the two groupings people actually write a number in
-- (5+5, 3-3-4). Space-separated two-digit size groups match none of these.
--
-- App-generated product/order cards (`@@PRODUCT@@…`, `@@ORDER@@…`) are exempt —
-- they are machine text, never a typed message.
--
-- Idempotent: `create or replace function` + `drop trigger if exists` recreate.

create or replace function block_contact_sharing()
returns trigger
language plpgsql set search_path = public as $$
begin
  if new.body like '@@PRODUCT@@%' or new.body like '@@ORDER@@%' then
    return new;
  end if;

  if new.body ~ '([6-9][0-9]{9}|[6-9][0-9]{4}[-. ][0-9]{5}|[6-9][0-9]{2}[-. ][0-9]{3}[-. ][0-9]{4})'   -- phone
     or new.body ~* '[a-z0-9._%+-]{2,}@[a-z0-9.-]{2,}'                                                  -- email / UPI
     or new.body ~* '\y(g[ -]?pay|google[ -]?pay|phone[ -]?pe|phonepe|paytm|bhim|upi)\y'                -- payment apps
     or new.body ~* '(whatsapp|wa\.me|t\.me|telegram|instagram|https?://|www\.)'                        -- outside links
  then
    raise exception using
      errcode = 'check_violation',
      message = 'Sharing contact or payment details is not allowed. Please keep your order on MangaiMart.';
  end if;

  return new;
end;
$$;

drop trigger if exists messages_block_contact on messages;
create trigger messages_block_contact
  before insert on messages
  for each row execute function block_contact_sharing();

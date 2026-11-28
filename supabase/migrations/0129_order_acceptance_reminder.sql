-- 0129 — remind a seller who has not accepted a paid order
--
-- THE GAP THIS CLOSES
-- Every order is prepaid (CLAUDE.md rule 9): place-order.js writes it `pending`
-- and the platform holds the buyer's money until the shop Accepts or Rejects.
-- Nothing moves a `pending` order on its own — there is no auto-accept and no
-- auto-cancel (by decision, 2026-11-28). A seller who never opens the order
-- leaves a buyer who has already paid waiting with no signal that anyone has
-- seen it. The seller IS alerted the moment the order lands (in-app + WhatsApp
-- `seller_new_order` + email, all in api/place-order.js), but a single alert at
-- 3am is easy to miss.
--
-- WHAT THIS ADDS
-- A once-only follow-up reminder when a paid order has sat `pending` for 24h:
-- the same three channels the first alert used. Deliberately a REMINDER, not an
-- auto-cancel — the buyer keeps their money held and the seller keeps the order;
-- this only nudges. It is NOT the dispatch-overdue sweep (0092,
-- `wa_sweep_dispatch_overdue`): that one fires later, against the shop's own
-- published dispatch window, and is about a shop that accepted but never shipped.
-- This one is about a shop that has not even answered.
--
-- SHAPE — mirrors 0092's sweep, split across SQL and an edge function
--   · The structural DDL + `sweep_pending_acceptance_reminders()` here do the two
--     channels SQL can do directly: the in-app bell row (`notify`, 0044) and the
--     WhatsApp enqueue (`wa_enqueue`, 0090). They also CLAIM each order by
--     stamping `acceptance_reminded_at`, which is the once-only guarantee —
--     re-running the sweep, or two callers racing, cannot double-send.
--   · The function RETURNS the rows that still need an EMAIL (shop address +
--     order details). Email is the one thing SQL cannot send, so the
--     `order-acceptance-reminder` edge function calls this RPC and mails those
--     rows through Resend — the same division daily-report uses.
--   · pg_cron runs the edge function twice a day (see the scheduling block at the
--     foot of this file). Twice a day, not hourly: the reminder lands within
--     ~12h of the 24h mark, which is fine for a nudge and costs two queries.
--
-- Idempotent: the column, index and function are all CREATE … IF NOT EXISTS /
-- OR REPLACE. The cron.schedule at the foot is NOT in the applied body — run it
-- by hand after the edge function is deployed and the Vault secret is set.

-- ── 1) Claim column + the index the sweep reads ──────────────────────────────
alter table orders add column if not exists acceptance_reminded_at timestamptz;

comment on column orders.acceptance_reminded_at is
  'When the "seller still has not accepted" 24h reminder was sent for this order (migration 0129). NULL until then; stamped once so the reminder never repeats.';

-- Tiny partial index: only ever a handful of unreminded, still-pending paid
-- orders at a time, so the twice-daily sweep is an index scan over almost
-- nothing rather than a seq scan of the whole orders table.
create index if not exists idx_orders_acceptance_reminder
  on orders (created_at)
  where status = 'pending' and payment_status = 'paid' and acceptance_reminded_at is null;

-- ── 2) The sweep ─────────────────────────────────────────────────────────────
-- SECURITY DEFINER: it writes notifications and the WhatsApp outbox (neither has
-- grants a caller could use directly, by design — 0044/0090) and reads the
-- boutique's contact columns (grant-restricted since 0073, CLAUDE.md rule 5 — so
-- the columns are named, never select *). Service role only; never anon.
create or replace function sweep_pending_acceptance_reminders(p_min_age_hours int default 24)
returns table (
  o_order_id     uuid,
  o_order_number text,
  o_shop_name    text,
  o_shop_email   text,
  o_buyer_name   text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  r       record;
  v_shop  record;
  v_buyer text;
begin
  -- FOR over UPDATE … RETURNING: each due order is claimed (stamped) as it is
  -- read, under the row lock, so a second sweep running at the same time sees
  -- acceptance_reminded_at already set and skips it. The 24h floor is the
  -- argument, defaulted — kept a parameter so it can be tuned without a
  -- migration, and clamped to at least 1h so a bad call can't spam fresh orders.
  for r in
    update orders o
       set acceptance_reminded_at = now()
     where o.id in (
       select o2.id
         from orders o2
        where o2.status = 'pending'
          and o2.payment_status = 'paid'
          and o2.acceptance_reminded_at is null
          and o2.created_at < now() - make_interval(hours => greatest(coalesce(p_min_age_hours, 24), 1))
          -- Upper bound, and it is load-bearing, not tidiness. payment_status
          -- defaults to 'paid', so WITHOUT this the very first sweep after deploy
          -- would match every order ever abandoned in `pending` — months of dead
          -- orders — and blast a "please accept" reminder for all of them at once.
          -- A reminder only makes sense just after the 24h mark; past a week the
          -- order is stale and nudging the seller about it is pure noise. So the
          -- window is 24h … 7 days. A genuinely new order is always caught inside
          -- it; nothing older is ever woken up.
          and o2.created_at > now() - interval '7 days'
        order by o2.created_at
        limit 200           -- a sane batch cap; the next run takes the rest
     )
    returning o.id, o.order_number, o.boutique_id, o.guest_name
  loop
    select b.name, b.owner_id, b.whatsapp, b.phone, b.email
      into v_shop
      from boutiques b
     where b.id = r.boutique_id;

    -- The buyer's first name for the message, or a neutral stand-in.
    v_buyer := nullif(split_part(coalesce(r.guest_name, ''), ' ', 1), '');

    -- (a) In-app bell notification to the shop owner (/seller/notifications).
    perform notify(
      v_shop.owner_id,
      'Orders',
      'An order still needs your reply',
      'Order ' || r.order_number || ' has been waiting 24 hours. Accept or reject it so '
        || coalesce(v_buyer, 'the buyer') || ' is not left waiting.',
      r.id
    );

    -- (b) WhatsApp, once. The dedupe_key is per order, so wa_enqueue's unique
    -- constraint makes a repeat enqueue a no-op even if the claim above were
    -- ever bypassed. Template registered at Meta as `seller_order_pending_reminder`
    -- with three variables: {{1}} shop, {{2}} order number, {{3}} buyer.
    perform wa_enqueue(
      coalesce(v_shop.whatsapp, v_shop.phone),
      'seller_order_pending_reminder',
      array[
        wa_param(v_shop.name, 'Seller'),
        wa_param(r.order_number),
        wa_param(v_buyer, 'your customer')
      ],
      'acceptreminder:' || r.id,
      'seller', r.id, r.boutique_id, v_shop.owner_id
    );

    -- (c) Email is sent by the edge function — hand back the rows that have an
    -- address to mail. A shop with no email on file simply gets (a) and (b).
    if v_shop.email is not null and btrim(v_shop.email) <> '' then
      o_order_id     := r.id;
      o_order_number := r.order_number;
      o_shop_name    := coalesce(nullif(btrim(v_shop.name), ''), 'there');
      o_shop_email   := btrim(v_shop.email);
      o_buyer_name   := coalesce(v_buyer, 'your customer');
      return next;
    end if;
  end loop;
end;
$$;

revoke all on function sweep_pending_acceptance_reminders(int) from public;
revoke all on function sweep_pending_acceptance_reminders(int) from anon, authenticated;
grant execute on function sweep_pending_acceptance_reminders(int) to service_role;

comment on function sweep_pending_acceptance_reminders(int) is
  'Claims paid orders left pending past p_min_age_hours (default 24), stamps '
  'acceptance_reminded_at so each fires once, sends the in-app + WhatsApp '
  'reminder, and returns the rows the order-acceptance-reminder edge function '
  'must email. Service role only; invoked twice daily via pg_cron. Migration 0129.';

-- ── 3) Schedule (RUN BY HAND, once, AFTER the edge function is deployed) ──────
-- Kept out of the applied body on purpose (same reasoning as 0092): cron.schedule
-- is not usefully idempotent, and registering a job that points at a function
-- which is not deployed yet would just fail twice a day until it is. The secret
-- is read from Vault at run time via require_cron_secret (0113), so a missing
-- secret fails the JOB loudly rather than silently sending nothing.
--
-- First: create the Vault secret and deploy the function (see the function's
-- header). Then, in the Supabase SQL editor:
--
--   select cron.schedule('order-acceptance-reminder', '30 2,13 * * *', $job$
--     select net.http_post(
--       url                  := 'https://mtxmuaskmyhnqczctwlp.supabase.co/functions/v1/order-acceptance-reminder',
--       headers              := jsonb_build_object(
--                                 'Authorization', 'Bearer ' || public.require_cron_secret('acceptance_reminder_token'),
--                                 'Content-Type',  'application/json'),
--       body                 := '{}'::jsonb,
--       timeout_milliseconds := 30000
--     );
--   $job$);
--
-- '30 2,13 * * *' is 08:00 and 18:30 IST — a seller reads it at the start and
-- end of a working day. The function answers immediately and sends in the
-- background (pg_net's 5s timeout, see the function header), so 30s is ample.

-- 0123_return_pickups.sql
--
-- Reverse logistics for returns — the second half of 0074.
--
-- 0074 gave the buyer a way to ASK for a return and the seller a way to ANSWER
-- it, and stopped there: approval recorded a decision and nothing moved. No
-- parcel came back, the refund was a disconnected manual step in /admin/refunds,
-- and nobody knew where the goods were. This file closes the loop:
--
--   buyer requests  →  seller approves  →  Shiprocket REVERSE pickup booked
--   (buyer → boutique)  →  courier scans drive the return  →  parcel RECEIVED
--   back at the shop  →  admin issues the refund  →  return closed.
--
-- Idempotent and re-runnable in the Supabase SQL editor. Requires 0074
-- (return_requests), 0067 (shipments / apply_shipment_scan / settle_boutique_
-- payout), 0011/0103 (release_stock) and 0025 (payouts).
--
-- DESIGN DECISIONS baked in here (set with the owner, 2026-11-28):
--   • Returns are FAULT-ONLY. damaged / defective / wrong_item / not_as_described.
--     The goodwill reasons (size, changed mind) are rejected at request_return,
--     so the goodwill-window branch below is now unreachable but kept for safety.
--   • The REFUND is issued AFTER the parcel is physically back (an admin click in
--     /admin/refunds), never on approval — a prepaid order means we are holding
--     the buyer's money, and "approved but never shipped back" must not pay out.
--   • The reverse pickup is booked AUTOMATICALLY when the seller approves
--     (in the `return-pickup` Edge Function — SQL cannot call Shiprocket).
--   • The reverse FREIGHT is netted out of the seller's payout, like the free-
--     delivery funding already is (a fault return is the shop's cost to bear).

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 1. Fault-only returns                                                      ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- Reproduces the LIVE body of request_return (read with pg_get_functiondef on
-- 2026-11-28 — it is NOT 0074's version; a later edit made it read the
-- boutique's own window and name) and adds ONE guard: a non-fault reason is
-- refused outright. Everything else is byte-for-byte the live function.
create or replace function request_return(
  p_order_id uuid,
  p_reason   text,
  p_note     text default '',
  p_photos   text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order   record;
  v_window  int;
  v_shop    text;
  v_is_fault boolean;
  v_id      uuid;
begin
  if auth.uid() is null then
    raise exception 'Please sign in to request a return.' using errcode = 'insufficient_privilege';
  end if;

  select o.id, o.buyer_id, o.boutique_id, o.status, o.delivered_at, o.refunded
    into v_order
    from orders o
   where o.id = p_order_id;

  if not found then
    raise exception 'Order not found.' using errcode = 'no_data_found';
  end if;
  if v_order.buyer_id is distinct from auth.uid() then
    raise exception 'That is not your order.' using errcode = 'insufficient_privilege';
  end if;
  if v_order.status <> 'delivered' or v_order.delivered_at is null then
    raise exception 'You can request a return once the order has been delivered.' using errcode = 'check_violation';
  end if;
  if v_order.refunded then
    raise exception 'This order has already been refunded.' using errcode = 'check_violation';
  end if;

  v_is_fault := p_reason in ('damaged', 'defective', 'wrong_item', 'not_as_described');

  -- 0123: fault-only. A change-of-mind / size return is not accepted at all —
  -- the buyer UI no longer offers those reasons, and this is the server-side
  -- authority behind that. Enforced before the window logic so the message is
  -- about the reason, not the clock.
  if not v_is_fault then
    raise exception 'Returns can only be raised for an item that arrived damaged, faulty, wrong, or not as described.'
      using errcode = 'check_violation';
  end if;

  -- The window the BUYER was shown on the product page: this boutique's own.
  -- Falls back to the platform setting only if the shop row has somehow gone —
  -- the column is NOT NULL, so in practice the first branch always answers.
  select coalesce(b.return_window_days, 0), b.name
    into v_window, v_shop
    from boutiques b
   where b.id = v_order.boutique_id;

  if not found then
    select coalesce(return_window_days, 0) into v_window from platform_settings where id = 1;
    v_shop := 'This boutique';
  end if;

  if v_is_fault then
    if v_order.delivered_at < now() - interval '30 days' then
      raise exception 'This order was delivered more than 30 days ago. Please message the boutique instead.'
        using errcode = 'check_violation';
    end if;
  else
    if v_window <= 0 then
      raise exception '% does not accept change-of-mind returns. If the item is damaged, faulty or not what you ordered, choose that reason instead.', coalesce(v_shop, 'This boutique')
        using errcode = 'check_violation';
    end if;
    if v_order.delivered_at < now() - make_interval(days => v_window) then
      raise exception 'The %-day return window for this order has closed.', v_window
        using errcode = 'check_violation';
    end if;
  end if;

  insert into return_requests (order_id, boutique_id, buyer_id, reason, note, photos)
  values (p_order_id, v_order.boutique_id, auth.uid(), p_reason, coalesce(p_note, ''), coalesce(p_photos, '{}'))
  returning id into v_id;

  begin
    insert into notifications (profile_id, type, title, body, order_id)
    select b.owner_id, 'Orders',
           'Return requested',
           'A buyer has requested a return. Open the order to review it.',
           p_order_id
      from boutiques b
     where b.id = v_order.boutique_id;
  exception when others then
    null;
  end;

  return v_id;
end;
$$;

revoke all on function request_return(uuid, text, text, text[]) from public, anon;
grant execute on function request_return(uuid, text, text, text[]) to authenticated;

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 2. The return lifecycle gets two more states                              ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- requested → approved → picked_up → received → refunded (or → rejected).
-- Dropped and re-added rather than altered: a CHECK cannot be widened in place.
alter table return_requests drop constraint if exists return_requests_status_check;
alter table return_requests add constraint return_requests_status_check
  check (status in ('requested', 'approved', 'picked_up', 'received', 'rejected', 'refunded'));

-- One live request per order, now covering the in-progress states too so a
-- second return cannot be opened while the first is mid-pickup.
drop index if exists return_requests_one_open;
create unique index if not exists return_requests_one_open
  on return_requests (order_id)
  where status in ('requested', 'approved', 'picked_up', 'received');

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 3. The reverse parcel                                                      ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- A SEPARATE table from `shipments` on purpose. apply_shipment_scan() and
-- fetchShipment() both assume one forward parcel per order and key the ORDER's
-- status off it; a return parcel sharing that table would flip the order back to
-- "delivered" on its own delivered-scan and break maybeSingle() reads. The
-- return parcel lives here and is scanned through its own path (section 4).
create table if not exists return_shipments (
  id                uuid primary key default gen_random_uuid(),
  return_request_id uuid not null references return_requests(id) on delete cascade,
  order_id          uuid not null references orders(id) on delete cascade,
  boutique_id       uuid not null references boutiques(id) on delete cascade,

  provider          text not null default 'shiprocket'
                      check (provider in ('shiprocket')),
  awb               text,
  -- Shiprocket's own ids for the return order, for reconciliation in their panel.
  sr_order_id       text,
  sr_shipment_id    text,
  courier_name      text,
  label_url         text,
  -- What the reverse pickup cost us, charged from the platform wallet. Netted
  -- out of the seller's payout in settle_boutique_payout (section 6).
  freight_charge    numeric,
  declared_weight_kg numeric,

  status            text not null default 'booked'
                      check (status in ('booked', 'pickup_pending', 'picked_up', 'in_transit', 'received', 'cancelled', 'failed')),
  last_status       text,
  last_status_at    timestamptz,

  -- Which payout the freight was netted into. NULL = not yet accounted, which is
  -- how every received return starts. Stops the same freight being deducted twice.
  payout_id         uuid references payouts(id) on delete set null,

  created_by        uuid references profiles(id) on delete set null,
  created_at        timestamptz not null default now()
);

-- AWB is globally unique at Shiprocket, so the scan path can find a return
-- parcel by AWB alone (section 4). Partial: a row exists briefly before its AWB.
create unique index if not exists return_shipments_awb_key on return_shipments (awb) where awb is not null;
create index if not exists return_shipments_order_idx    on return_shipments (order_id);
create index if not exists return_shipments_request_idx  on return_shipments (return_request_id);
create index if not exists return_shipments_payout_idx   on return_shipments (boutique_id, status) where payout_id is null;

alter table return_shipments enable row level security;

-- Read follows the parent request: the buyer who raised it, the shop that owns
-- it, or an admin. Writes go only through the service role (the Edge Function
-- and the scan RPC) — there is deliberately no insert/update policy.
drop policy if exists "return_shipments: read" on return_shipments;
create policy "return_shipments: read" on return_shipments for select
  using (
    exists (
      select 1 from return_requests r
       where r.id = return_request_id
         and (
           r.buyer_id = auth.uid()
           or exists (select 1 from boutiques b where b.id = r.boutique_id and b.owner_id = auth.uid())
           or is_admin()
         )
    )
  );

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 4. Scanning the reverse parcel                                             ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- The Shiprocket tracking webhook calls apply_shipment_scan() for EVERY AWB,
-- forward and reverse alike — it cannot tell them apart. apply_return_scan() is
-- the reverse handler; apply_shipment_scan falls through to it when an AWB is
-- not one of ours going out.
--
-- Returns true when it recognised the AWB as a return, false otherwise (so the
-- webhook logs "unknown AWB" exactly as before).
create or replace function apply_return_scan(
  p_awb         text,
  p_raw_status  text,
  p_stage       text,
  p_location    text default null,
  p_occurred_at timestamptz default null,
  p_payload     jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rs      return_shipments;
  v_req     return_requests;
  v_order   orders;
  v_items   jsonb;
  v_new     text;
begin
  select * into v_rs from return_shipments where awb = trim(p_awb) limit 1;
  if v_rs.id is null then
    return false;
  end if;

  -- Map the courier stage onto the return's own vocabulary. 'delivered' on a
  -- REVERSE parcel means it reached the SELLER — i.e. the return is received.
  v_new := case p_stage
             when 'picked_up'        then 'picked_up'
             when 'out_for_delivery' then 'in_transit'
             when 'in_transit'       then 'in_transit'
             when 'delivered'        then 'received'
             when 'rto'              then 'failed'   -- a return that itself bounced
             when 'failed'           then 'failed'
             else v_rs.status
           end;

  update return_shipments
     set last_status    = p_stage,
         last_status_at = coalesce(p_occurred_at, now()),
         -- Never walk a received/cancelled parcel backwards on a late scan.
         status = case when v_rs.status in ('received', 'cancelled') then v_rs.status else v_new end
   where id = v_rs.id;

  select * into v_req from return_requests where id = v_rs.return_request_id;
  select * into v_order from orders where id = v_rs.order_id;

  if p_stage = 'picked_up' and v_req.status = 'approved' then
    update return_requests set status = 'picked_up' where id = v_req.id;
    begin
      insert into notifications (profile_id, type, title, body, order_id)
      values (v_req.buyer_id, 'Orders', 'Return picked up',
              'The courier has collected your return for order ' || coalesce(v_order.order_number, '') || '.',
              v_order.id);
    exception when others then null;
    end;

  elsif p_stage = 'delivered' and v_req.status in ('approved', 'picked_up') then
    -- The goods are back at the shop. Move the request to 'received' — the state
    -- /admin/refunds reads to offer the one-click refund. The money does NOT
    -- move here.
    update return_requests set status = 'received' where id = v_req.id;

    -- Restock ONLY when the item is re-sellable. A wrong item or a not-as-
    -- described one is fine to put back; a damaged or defective one must never
    -- silently reappear on the shelf, so it is left for the seller to handle.
    if v_req.reason in ('wrong_item', 'not_as_described') then
      select coalesce(
               jsonb_agg(jsonb_build_object('product_id', oi.product_id, 'qty', oi.qty, 'size', oi.size)),
               '[]'::jsonb)
        into v_items
        from order_items oi
       where oi.order_id = v_order.id;
      perform release_stock(v_items);
    end if;

    -- Tell the buyer, and tell the admins there is a refund to issue.
    begin
      insert into notifications (profile_id, type, title, body, order_id)
      values (v_req.buyer_id, 'Orders', 'Return received',
              'We have received your returned item for order ' || coalesce(v_order.order_number, '')
                || '. Your refund will be processed shortly.',
              v_order.id);
    exception when others then null;
    end;
    begin
      insert into notifications (profile_id, type, title, body, order_id)
      select p.id, 'Orders', 'Return received — ready to refund',
             'The returned parcel for order ' || coalesce(v_order.order_number, '')
               || ' is back with the boutique. Issue the refund in Refunds.',
             v_order.id
        from profiles p
       where p.role = 'admin'
         and coalesce(p.status, 'active') = 'active'
         and p.deleted_at is null;
    exception when others then null;
    end;
  end if;

  return true;
end;
$$;

revoke all on function apply_return_scan(text, text, text, text, timestamptz, jsonb) from public, anon, authenticated;

-- apply_shipment_scan — reproduced from its LIVE body (pg_get_functiondef,
-- 2026-11-28) with ONE change: the "unknown AWB" branch now falls through to
-- apply_return_scan before giving up. Everything else is byte-for-byte live.
create or replace function apply_shipment_scan(
  p_awb text,
  p_raw_status text,
  p_stage text,
  p_location text default null,
  p_occurred_at timestamptz default null,
  p_payload jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_ship         shipments;
  v_status       text;
  v_order_number text;
begin
  select * into v_ship from shipments where awb = trim(p_awb) limit 1;
  if v_ship.id is null then
    -- Not a forward parcel of ours. It may be a reverse (return) parcel, which
    -- lives in its own table and drives the return, not the order (0123).
    return apply_return_scan(p_awb, p_raw_status, p_stage, p_location, p_occurred_at, p_payload);
  end if;

  insert into shipment_events (shipment_id, order_id, awb, raw_status, stage, location, occurred_at, payload)
  values (v_ship.id, v_ship.order_id, v_ship.awb, p_raw_status, p_stage, p_location, p_occurred_at, p_payload)
  on conflict do nothing;

  update shipments
     set last_status = p_stage,
         last_status_at = coalesce(p_occurred_at, now())
   where id = v_ship.id;

  select status into v_status from orders where id = v_ship.order_id;

  if v_status in ('cancelled', 'rejected') then
    return true;
  end if;

  if p_stage = 'out_for_delivery' then
    update orders
       set out_for_delivery_at = coalesce(out_for_delivery_at, coalesce(p_occurred_at, now()))
     where id = v_ship.order_id;

  elsif p_stage = 'delivered' then
    if v_status is distinct from 'delivered' then
      update orders set status = 'delivered' where id = v_ship.order_id;

      if v_ship.provider in ('dtdc', 'shiprocket', 'shadowfax') then
        select order_number into v_order_number from orders where id = v_ship.order_id;
        insert into notifications (profile_id, type, title, body, order_id)
        select p.id,
               'Orders',
               'Delivered — ready to pay out',
               'Order ' || coalesce(v_order_number, '') || ' was delivered by the courier ('
                 || upper(v_ship.provider) || ') and is ready to settle.',
               v_ship.order_id
          from profiles p
         where p.role = 'admin'
           and coalesce(p.status, 'active') = 'active'
           and p.deleted_at is null;
      end if;
    end if;

  elsif p_stage = 'rto' then
    update orders
       set delivery_disputed = true,
           delivery_disputed_at = coalesce(delivery_disputed_at, now()),
           delivery_dispute_note = coalesce(delivery_dispute_note,
             'Returned to origin by the courier: ' || coalesce(p_raw_status, 'RTO'))
     where id = v_ship.order_id;
  end if;

  return true;
end $$;

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 5. Close the return when the refund is issued                             ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- The refund itself stays in /admin/refunds (the Razorpay call). Whichever way
-- orders.refunded flips true, a still-open return for that order is closed to
-- 'refunded' so the loop ends in exactly one place.
create or replace function close_return_on_refund()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.refunded = true and coalesce(old.refunded, false) = false then
    update return_requests
       set status = 'refunded',
           resolved_at = coalesce(resolved_at, now())
     where order_id = new.id
       and status in ('approved', 'picked_up', 'received');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_close_return_on_refund on orders;
create trigger trg_close_return_on_refund
  after update of refunded on orders
  for each row execute function close_return_on_refund();

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 6. Net the return freight out of the seller's payout                      ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- Reproduced from the LIVE body of settle_boutique_payout (pg_get_functiondef,
-- 2026-11-28) with ONE addition: received returns whose freight is not yet
-- accounted are summed, deducted from the net, folded into the `fees` line so
-- the statement still reconciles, and stamped with this payout's id so the same
-- freight is never deducted twice.
--
-- Note: like the free-delivery funding it sits beside, the deduction only lands
-- when the boutique has at least one deliverable order to settle (v_count > 0).
-- A received return with no new orders carries forward to the next payout rather
-- than forcing a zero/negative payout — a deliberate v1 simplification.
create or replace function settle_boutique_payout(p_boutique_id uuid, p_note text default null)
returns payouts
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_rate constant numeric := 0.10;
  v_payout payouts;
  v_ids uuid[];
  v_count int := 0;
  v_prepaid_goods numeric := 0;
  v_prepaid_commission numeric := 0;
  v_prepaid_fees numeric := 0;
  v_cod_commission numeric := 0;
  v_cod_fees numeric := 0;
  v_cod_platform_discount numeric := 0;
  v_prepaid_delivery_funding numeric := 0;  -- 0120: seller-funded free delivery
  v_return_freight numeric := 0;            -- 0123: reverse-pickup cost to net out
  v_return_ids uuid[] := '{}';              -- 0123: the return parcels accounted
  v_amount numeric := 0;
  v_undelivered int := 0;
begin
  if not is_admin() then
    raise exception 'payouts: admin only';
  end if;

  select
    coalesce(array_agg(o.id), '{}'::uuid[]),
    count(*)::int,
    coalesce(sum(o.total) filter (where o.payment_method is distinct from 'COD'), 0),
    coalesce(sum(round(o.total * v_rate, 2)) filter (where o.payment_method is distinct from 'COD'), 0),
    coalesce(sum(o.cod_fee + o.shipping_fee) filter (where o.payment_method is distinct from 'COD'), 0),
    coalesce(sum(round(o.total * v_rate, 2)) filter (where o.payment_method = 'COD'), 0),
    coalesce(sum(o.cod_fee + o.shipping_fee) filter (where o.payment_method = 'COD'), 0),
    coalesce(sum(o.platform_discount) filter (where o.payment_method = 'COD'), 0),
    -- 0120: for prepaid orders, the courier cost the seller has to fund because
    -- they gave the buyer free (or below-cost) delivery. greatest(...,0) keeps a
    -- normal order (buyer paid rate + buffer ≥ cost) from ever crediting the seller.
    coalesce(sum(greatest(coalesce(o.quoted_ship_cost, 0) - o.shipping_fee, 0))
             filter (where o.payment_method is distinct from 'COD'), 0)
  into v_ids, v_count, v_prepaid_goods, v_prepaid_commission, v_prepaid_fees,
       v_cod_commission, v_cod_fees, v_cod_platform_discount, v_prepaid_delivery_funding
  from orders o
  where o.boutique_id = p_boutique_id
    and is_settleable(o);

  if v_count = 0 then
    -- Distinguish "nothing owed" from "owed but not delivered yet". Before this,
    -- an admin who could see money on the dashboard got a flat "nothing to
    -- settle" and no way to tell whether the balance was gone or merely held.
    select count(*)::int into v_undelivered
    from orders o
    where o.boutique_id = p_boutique_id
      and o.payout_id is null
      and o.payment_status = 'paid'
      and o.refunded = false
      and o.status not in ('rejected', 'cancelled')
      and coalesce(o.channel, 'online') <> 'offline'
      and (o.status <> 'delivered' or o.delivered_at is null);

    if v_undelivered > 0 then
      raise exception 'payouts: % paid order(s) are not delivered yet — payouts are released only after delivery', v_undelivered;
    end if;
    raise exception 'payouts: nothing to settle for this boutique';
  end if;

  -- 0123: reverse-pickup freight on returns that are back with the shop and not
  -- yet charged to a payout. A fault return is the shop's cost to carry.
  select
    coalesce(sum(rs.freight_charge), 0),
    coalesce(array_agg(rs.id), '{}'::uuid[])
  into v_return_freight, v_return_ids
  from return_shipments rs
  where rs.boutique_id = p_boutique_id
    and rs.status = 'received'
    and rs.payout_id is null
    and rs.freight_charge is not null;

  -- Net payable = prepaid(goods − commission) − cod(commission + fees) + the
  -- platform-funded discount the seller never collected in cash (0053) − the
  -- courier cost on any free-delivery order the seller chose to give (0120) −
  -- the reverse-pickup freight on any return that came back (0123).
  v_amount := (v_prepaid_goods - v_prepaid_commission)
            - (v_cod_commission + v_cod_fees)
            + v_cod_platform_discount
            - v_prepaid_delivery_funding
            - v_return_freight;

  insert into payouts (
    boutique_id, amount, orders_count, gross, commission, fees, cod_adjustment,
    note, created_by, created_by_name
  ) values (
    p_boutique_id,
    round(v_amount, 2),
    v_count,
    round(v_prepaid_goods, 2),
    round(v_prepaid_commission + v_cod_commission, 2),
    -- `fees` reports delivery the platform collected; the seller-funded free-delivery
    -- cost and the return freight are deductions from the seller, so they are added
    -- into the fees line too so the statement reconciles against `amount`.
    round(v_prepaid_fees + v_cod_fees + v_prepaid_delivery_funding + v_return_freight, 2),
    round(v_cod_commission + v_cod_fees - v_cod_platform_discount, 2),
    nullif(btrim(coalesce(p_note, '')), ''),
    auth.uid(),
    coalesce((select full_name from profiles where id = auth.uid()), 'Admin')
  )
  returning * into v_payout;

  update orders set payout_id = v_payout.id where id = any(v_ids);
  -- Stamp the return parcels so their freight is never deducted a second time.
  if array_length(v_return_ids, 1) is not null then
    update return_shipments set payout_id = v_payout.id where id = any(v_return_ids);
  end if;

  return v_payout;
end $$;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--     where conrelid = 'return_requests'::regclass and conname like '%status%';
--   -- a goodwill reason must now be refused:
--   select request_return('<your delivered order id>', 'changed_mind');  -- raises
--   select to_regclass('public.return_shipments');

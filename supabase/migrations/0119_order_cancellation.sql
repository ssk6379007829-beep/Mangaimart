-- 0119_order_cancellation.sql
--
-- Buyer- and seller-initiated order cancellation, plus the shipped-stage
-- request/approve flow. Idempotent; safe to re-run.
--
-- WHY RPCs AND NOT AN UPDATE POLICY
-- `orders` deliberately has no buyer UPDATE policy (same rule the returns work
-- follows): a column-blind `using (buyer_id = auth.uid())` would also let a
-- buyer rewrite `total`, `status` or clear `refunded` from the browser console.
-- Every write below goes through a SECURITY DEFINER function that re-derives the
-- caller's role, checks the order's stage, and touches only the cancellation
-- columns — exactly like request_return / report_delivery_issue (0074, 0063).
--
-- WHAT IT DOES
--   • cancel_order        — buyer OR seller cancels a pending/accepted order
--                           outright (seller/admin may also cancel a shipped
--                           one). Restocks, and the payout sweep already skips
--                           `cancelled` (0025/0053/0063/0078a), so the payout is
--                           held with no extra work. Refund is NOT issued here —
--                           the order simply becomes a refund candidate in the
--                           admin Refunds console (isRefundCandidate, 0097).
--   • request_cancellation — a buyer asks to cancel a SHIPPED order; the parcel
--                           is already moving, so this needs the seller's nod.
--   • resolve_cancellation — the boutique (or an admin) approves or declines
--                           that request. Approve = the same cancel+restock.
--
-- Delivered orders are NOT cancellable here: a delivered order is unwound
-- through the returns flow (0074), which the buyer UI routes to instead.

-- ── 1. Request/approval columns ─────────────────────────────────────────────
alter table orders add column if not exists cancel_requested_at  timestamptz;
alter table orders add column if not exists cancel_requested_by  uuid;
alter table orders add column if not exists cancel_request_note   text;
alter table orders add column if not exists cancel_request_status text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_cancel_request_status_chk'
  ) then
    alter table orders add constraint orders_cancel_request_status_chk
      check (cancel_request_status is null
             or cancel_request_status in ('requested', 'approved', 'declined'));
  end if;
end $$;

comment on column orders.cancel_request_status is
  'Buyer cancellation request on a SHIPPED order: requested | approved | declined (0119).';

-- The consoles read these to show request state. `orders` is read through RLS
-- (not column grants like `boutiques`), but grant explicitly so a future column
-- lockdown cannot silently blank the request state. Idempotent.
grant select (cancel_requested_at, cancel_requested_by, cancel_request_note, cancel_request_status)
  on orders to authenticated;

-- ── 2. cancel_order ─────────────────────────────────────────────────────────
create or replace function cancel_order(p_order_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_order     orders%rowtype;
  v_is_buyer  boolean;
  v_is_seller boolean;
  v_is_admin  boolean := is_admin();
  v_items     jsonb;
begin
  select * into v_order from orders where id = p_order_id;
  if not found then
    raise exception 'Order not found';
  end if;

  v_is_buyer  := v_uid is not null and v_order.buyer_id is not distinct from v_uid;
  v_is_seller := exists (
    select 1 from boutiques b where b.id = v_order.boutique_id and b.owner_id = v_uid
  );

  if not (v_is_buyer or v_is_seller or v_is_admin) then
    raise exception 'You cannot cancel this order';
  end if;

  if v_order.status in ('cancelled', 'rejected') then
    raise exception 'This order is already closed';
  end if;
  if v_order.status = 'delivered' then
    raise exception 'A delivered order is returned, not cancelled';
  end if;

  -- A buyer cannot unilaterally cancel once the parcel has shipped — that is the
  -- seller's call, routed through request_cancellation / resolve_cancellation.
  if v_order.status = 'shipped' and v_is_buyer and not (v_is_seller or v_is_admin) then
    raise exception 'This order has already shipped — please request a cancellation instead';
  end if;

  update orders
     set status        = 'cancelled',
         cancelled_at  = now(),
         cancel_reason = coalesce(nullif(btrim(p_reason), ''), cancel_reason),
         cancel_request_status =
           case when cancel_request_status = 'requested' then 'approved'
                else cancel_request_status end
   where id = p_order_id;

  -- Put the reserved units back on the shelf, in the exact shape place-order
  -- reserved them (migration 0103 handles size-level stock inside release_stock).
  select coalesce(
           jsonb_agg(jsonb_build_object('product_id', oi.product_id, 'qty', oi.qty, 'size', oi.size)),
           '[]'::jsonb)
    into v_items
    from order_items oi
   where oi.order_id = p_order_id;
  perform release_stock(v_items);
end;
$$;

revoke all on function cancel_order(uuid, text) from public;
grant execute on function cancel_order(uuid, text) to authenticated;

-- ── 3. request_cancellation (buyer, shipped order) ──────────────────────────
create or replace function request_cancellation(p_order_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_order orders%rowtype;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;

  select * into v_order from orders where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;
  if v_order.buyer_id is distinct from v_uid then
    raise exception 'Not your order';
  end if;
  if v_order.status <> 'shipped' then
    raise exception 'A cancellation can only be requested while the order is on its way';
  end if;
  if v_order.cancel_request_status = 'requested' then
    raise exception 'A cancellation request is already open on this order';
  end if;

  update orders
     set cancel_requested_at  = now(),
         cancel_requested_by  = v_uid,
         cancel_request_note  = nullif(btrim(p_note), ''),
         cancel_request_status = 'requested'
   where id = p_order_id;
end;
$$;

revoke all on function request_cancellation(uuid, text) from public;
grant execute on function request_cancellation(uuid, text) to authenticated;

-- ── 4. resolve_cancellation (seller/admin answers the request) ──────────────
create or replace function resolve_cancellation(p_order_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_order     orders%rowtype;
  v_is_seller boolean;
  v_is_admin  boolean := is_admin();
  v_items     jsonb;
begin
  select * into v_order from orders where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;

  v_is_seller := exists (
    select 1 from boutiques b where b.id = v_order.boutique_id and b.owner_id = v_uid
  );
  if not (v_is_seller or v_is_admin) then
    raise exception 'Only the boutique or an admin can answer a cancellation request';
  end if;
  if v_order.cancel_request_status is distinct from 'requested' then
    raise exception 'There is no open cancellation request on this order';
  end if;

  if p_approve then
    update orders
       set status        = 'cancelled',
           cancelled_at  = now(),
           cancel_reason = coalesce(nullif(btrim(v_order.cancel_request_note), ''), cancel_reason),
           cancel_request_status = 'approved'
     where id = p_order_id;

    select coalesce(
             jsonb_agg(jsonb_build_object('product_id', oi.product_id, 'qty', oi.qty, 'size', oi.size)),
             '[]'::jsonb)
      into v_items
      from order_items oi
     where oi.order_id = p_order_id;
    perform release_stock(v_items);
  else
    update orders
       set cancel_request_status = 'declined',
           cancel_request_note   = coalesce(nullif(btrim(p_note), ''), cancel_request_note)
     where id = p_order_id;
  end if;
end;
$$;

revoke all on function resolve_cancellation(uuid, boolean, text) from public;
grant execute on function resolve_cancellation(uuid, boolean, text) to authenticated;

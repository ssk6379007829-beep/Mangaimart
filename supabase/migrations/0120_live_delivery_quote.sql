-- Live courier delivery pricing — charge the buyer the real Shiprocket rate.
--
-- Until now the buyer paid the seller's own flat, distance-banded rate
-- (boutiques.delivery_charge* — migrations 0076/0077), re-derived to the paise by
-- api/_pricing.js. This introduces an alternative: at checkout the `delivery-quote`
-- Edge Function asks Shiprocket for the cheapest live rate on the lane (pickup
-- pincode → delivery pincode, at the parcel's real weight), adds a small platform
-- buffer, and SIGNS the number. api/create-order.js and api/place-order.js verify
-- that signature and bind the payment to it, instead of re-quoting (a live quote is
-- not reproducible to the paise, so re-deriving it would reject legitimate
-- checkouts). When Shiprocket is unreachable the quote degrades and both endpoints
-- fall back to the existing flat-rate path unchanged — so this is purely additive.
--
-- Additive and idempotent. Nothing reads the new columns until the Edge Function
-- and the two API endpoints that go with it are deployed, so applying this early
-- changes no behaviour.

-- ── Platform buffer on the courier rate ─────────────────────────────────────
-- Shiprocket's rate is the PLATFORM's cost. The buyer is charged that cost plus a
-- small buffer, so weight-discrepancy charges and the odd RTO do not turn delivery
-- into a per-order loss. Two knobs, applied as rate*(1 + pct/100) + flat, both
-- platform-wide and admin-editable (platform_settings, like commission). Default
-- is a flat ₹20 and no percentage — a deliberate, visible buffer rather than a
-- silent zero that would make "rate + buffer" mean "rate".
alter table platform_settings add column if not exists delivery_markup_flat numeric(8,2) not null default 20;
alter table platform_settings add column if not exists delivery_markup_pct  numeric(6,2) not null default 0;

do $$ begin
  alter table platform_settings add constraint platform_settings_delivery_markup_sane check (
    delivery_markup_flat >= 0 and delivery_markup_flat <= 1000
    and delivery_markup_pct >= 0 and delivery_markup_pct <= 100
  );
exception when duplicate_object then null; end $$;

comment on column platform_settings.delivery_markup_flat is
  'Flat ₹ added on top of the live courier rate charged to the buyer (live delivery pricing, 0120).';
comment on column platform_settings.delivery_markup_pct is
  'Percentage added on top of the live courier rate before the flat buffer (live delivery pricing, 0120).';

-- ── What the parcel was actually quoted at, per order ───────────────────────
-- orders.shipping_fee keeps its meaning: what the BUYER paid for delivery (rate +
-- buffer, or 0 when the seller gave free delivery). These two record the PLATFORM's
-- side of the same parcel:
--   • quoted_ship_cost  — the courier's own rate, before any buffer. This is what
--                         the platform will actually owe Shiprocket, so it is what
--                         the payout math nets off a seller who gave free delivery
--                         (below), and what reconciliation compares to the wallet.
--   • quoted_courier_*  — which courier the buyer was priced for, so the ship step
--                         books the same one.
-- All NULL for flat-rate (fallback) orders and every order placed before this —
-- the payout change treats NULL as "no courier cost known", i.e. behave as today.
alter table orders add column if not exists quoted_ship_cost   numeric(10,2);
alter table orders add column if not exists quoted_courier_id   text;
alter table orders add column if not exists quoted_courier_name text;

comment on column orders.quoted_ship_cost is
  'Live courier rate (platform cost, pre-buffer) this order was quoted at. NULL = flat-rate/legacy order. See 0120.';
comment on column orders.quoted_courier_id is
  'Shiprocket courier_company_id the buyer was priced for, so the ship step books the same courier. See 0120.';

-- ── Seller funds their own free-delivery offer ──────────────────────────────
-- A seller's "free delivery over ₹X" means the buyer pays ₹0 but the platform
-- still pays the courier. That courier cost is netted off the seller's payout here,
-- so the platform is not silently subsidising an offer the seller chose to make.
--
-- The term added is  sum( greatest(quoted_ship_cost − shipping_fee, 0) )  over the
-- boutique's prepaid, settleable orders:
--   • a normal live-rate order has shipping_fee = cost + buffer ≥ cost, so the term
--     is 0 — the seller is unaffected and still paid goods − commission;
--   • a free-delivery order has shipping_fee = 0, so the term is the full
--     quoted_ship_cost — the seller funds exactly what the platform pays the courier;
--   • a flat-rate/legacy order has quoted_ship_cost NULL → coalesced to 0 → term 0,
--     so those orders settle exactly as they did before this migration.
--
-- Body reproduced verbatim from the live definition (checked 2026-11-25 via
-- pg_get_functiondef, per CLAUDE.md rule 1) with ONLY the delivery-funding term
-- added — the COD netting, the delivered-gate and everything else are unchanged.
create or replace function public.settle_boutique_payout(p_boutique_id uuid, p_note text default null::text)
returns payouts
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- Net payable = prepaid(goods − commission) − cod(commission + fees) + the
  -- platform-funded discount the seller never collected in cash (0053) − the
  -- courier cost on any free-delivery order the seller chose to give (0120).
  v_amount := (v_prepaid_goods - v_prepaid_commission)
            - (v_cod_commission + v_cod_fees)
            + v_cod_platform_discount
            - v_prepaid_delivery_funding;

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
    -- cost is a deduction from the seller, so it is added into the fees line too so
    -- the statement reconciles against `amount`.
    round(v_prepaid_fees + v_cod_fees + v_prepaid_delivery_funding, 2),
    round(v_cod_commission + v_cod_fees - v_cod_platform_discount, 2),
    nullif(btrim(coalesce(p_note, '')), ''),
    auth.uid(),
    coalesce((select full_name from profiles where id = auth.uid()), 'Admin')
  )
  returning * into v_payout;

  update orders set payout_id = v_payout.id where id = any(v_ids);

  return v_payout;
end $function$;

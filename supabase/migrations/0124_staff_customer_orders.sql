-- 0124: a staff-safe read of ONE buyer's order history.
--
-- The Customers page is the staff stand-in for Users (migration 0086). It lists
-- who buys and how much, but staff hold no RLS policy on `orders` at all, so an
-- employee could not open a customer to see what they had ordered — the one
-- thing the page is for.
--
-- Same door as `staff_orders_feed` and `staff_customer_rows`: a SECURITY DEFINER
-- function whose WHERE clause is the access check (`is_staff()`, which is true
-- for admins too) and that returns only non-contact fields, so nothing needs
-- masking. A buyer or seller who calls it gets an empty array, never someone
-- else's orders.
--
-- Idempotent: `create or replace` plus the revoke/grant can be re-run safely.

create or replace function staff_customer_orders(p_buyer uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(o_json order by o_json->>'created_at' desc), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'id', o.id,
        'order_number', o.order_number,
        'total', o.total,
        'status', o.status,
        'created_at', o.created_at,
        'boutique', coalesce((select b.name from boutiques b where b.id = o.boutique_id), '-')
      ) as o_json
      from orders o
      -- The access check, evaluated per row: without it this function would hand
      -- any authenticated caller any buyer's history.
      where is_staff() and o.buyer_id = p_buyer
    ) t;
$$;

revoke all on function staff_customer_orders(uuid) from public, anon;
grant execute on function staff_customer_orders(uuid) to authenticated;

-- Merge the duplicate 'XXL' size into '2XL', then retire the 'XXL' chip.
--
-- The catalogue was always meant to carry ONE convention for the plus sizes —
-- 0104 seeds '2XL' only and its comment spells out why: src/lib/sizes.ts ranks
-- '2XL' and 'XXL' identically, so both present puts two chips for the same size
-- side by side in the seller's picker, each holding its own stock. But the live
-- `taxonomy` table still carries three stragglers 0104 never seeded, adopted by
-- 0024's "whatever sellers already typed" pass: 'XXL', 'XXS' and '6XL'
-- (sort_order 500). This migration deals with the duplicate only — 'XXL' → '2XL'.
-- 'XXS' and '6XL' are off-convention but NOT duplicates, so they are left alone.
--
-- Products already use 'XXL' (both as a `sizes` entry and a `size_stock` key), so
-- the chip cannot just be deleted — that would orphan real, counted stock. So we
-- migrate the product data FIRST, folding any XXL stock onto 2XL, and only then
-- delete the taxonomy row.
--
-- Idempotent: every statement is guarded so a second run is a no-op. There is no
-- FK into `taxonomy` (sizes are stored as plain text on products), and the
-- taxonomy decision guard is a BEFORE UPDATE trigger, so this DELETE does not
-- trip it. Apply any time after 0104.

-- 1. size_stock (jsonb): add XXL's count onto 2XL, then drop the XXL key.
--    nullif guards a blank string; coalesce covers a size that had no 2XL yet.
update products
set size_stock =
      (size_stock - 'XXL')
      || jsonb_build_object(
           '2XL',
           to_jsonb(
             coalesce(nullif(size_stock->>'2XL', '')::int, 0)
           + coalesce(nullif(size_stock->>'XXL', '')::int, 0)
           )
         )
where size_stock ? 'XXL';

-- 2. sizes (text[]): rewrite 'XXL' to '2XL', collapsing a now-duplicate 2XL.
--    Order inside the array is immaterial — the app sorts every ladder through
--    sortSizes() on the way out.
update products p
set sizes = sub.new_sizes
from (
  select id,
         (select array_agg(distinct s)
            from unnest(
              array(select case when x = 'XXL' then '2XL' else x end
                      from unnest(sizes) as x)
            ) as s
         ) as new_sizes
    from products
   where 'XXL' = any(sizes)
) sub
where p.id = sub.id;

-- 3. Retire the 'XXL' chip. (RLS is bypassed in the SQL editor / over MCP; the
--    only taxonomy trigger that could object is UPDATE-only, so DELETE is clean.)
delete from taxonomy where kind = 'size' and name_key = 'xxl';

-- 0127: platform markup on product prices.
--
-- The admin-set buffer the buyer pays on top of each product's listed price, so
-- the platform earns a margin on goods on top of commission. Baked into the
-- buyer-facing price per unit: buyer pays round(base * (1 + pct/100) + flat) for
-- each unit. The seller is unaffected — their payout and the commission stay on
-- their LISTED price; the markup is pure platform margin, kept the same way the
-- delivery fee is (migration 0076 / "platform keeps the delivery fee").
--
-- Platform-wide, in `platform_settings`, exactly like the live-delivery buffer
-- (migration 0120 added delivery_markup_*). Mirrored in `src/data/settings.ts`,
-- `src/lib/pricing.ts` and `api/_pricing.js`.
--
-- Idempotent: `add column if not exists`, guarded constraint.

alter table platform_settings add column if not exists product_markup_flat numeric(8,2) not null default 0;
alter table platform_settings add column if not exists product_markup_pct  numeric(6,2) not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'platform_settings_product_markup_sane'
  ) then
    alter table platform_settings add constraint platform_settings_product_markup_sane check (
      product_markup_flat >= 0 and product_markup_flat <= 100000
      and product_markup_pct >= 0 and product_markup_pct <= 100
    );
  end if;
end $$;

comment on column platform_settings.product_markup_flat is
  'Flat amount added to each unit''s buyer-facing price (0127). Platform margin; seller unaffected.';
comment on column platform_settings.product_markup_pct is
  'Percentage added to each unit''s buyer-facing price (0127). Platform margin; seller unaffected.';

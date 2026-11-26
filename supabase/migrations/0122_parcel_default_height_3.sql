-- Lower the default parcel box height from 6 cm to 3 cm — making the platform
-- default box 30 × 24 × 3 cm — and align every existing boutique to it.
--
-- Why: Shiprocket (and every aggregator) bills forward freight on
-- max(dead weight, volumetric weight), where volumetric = L×B×H / 5000 kg.
-- The old 30 × 24 × 6 box volumetrises to 0.864 kg, which pushes a light
-- garment (0.5 kg dead) a full rate slab higher — a ₹1,999 saree quoting
-- ₹117.72 instead of the ₹66.72 its real weight warrants. A folded ethnic-wear
-- parcel is flatter than 6 cm; 3 cm volumetrises to 0.432 kg, below the 0.5 kg
-- dead weight, so the base slab applies and the buyer pays the true rate.
--
-- 0065 set the original defaults (30 × 24 × 6). This only revises height — the
-- 30 × 24 footprint is unchanged. order_parcel_metrics() and shiprocket-book read
-- these same columns, so the live delivery quote and the actual booking stay in
-- step (CLAUDE.md pricing-mirror discipline, applied to the parcel declaration).
--
-- Scope chosen by the owner: change the column default AND backfill ALL existing
-- boutiques, overwriting any box a seller set. Idempotent — safe to re-run.

-- ── New column default for future boutiques ─────────────────────────────────
alter table boutiques alter column package_length_cm  set default 30;
alter table boutiques alter column package_breadth_cm set default 24;
alter table boutiques alter column package_height_cm  set default 3;

-- ── Backfill every existing boutique to the new default box ──────────────────
update boutiques
   set package_length_cm  = 30,
       package_breadth_cm = 24,
       package_height_cm  = 3
 where package_length_cm  is distinct from 30
    or package_breadth_cm is distinct from 24
    or package_height_cm  is distinct from 3;

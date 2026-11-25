-- 0121_boutique_sensitive_edit_review.sql
-- Sensitive edits after approval: re-flag for review, and re-arm payout
-- verification when a seller changes their own bank/UPI.
--
-- Context — docs/plans/SELLER_BOUTIQUE_EDITOR_MERGE_PLAN.md. The seller
-- "Manage boutique" editor lets an APPROVED shop change its own details in
-- place. Two kinds of change must not pass silently:
--   * payout (bank account / UPI) — the NEW account must re-pass the penny-drop
--     before run-payouts.js will pay it (it trusts payout_details_verified —
--     api/run-payouts.js:89);
--   * identity (GST, registered address, map pin) — an admin should re-check.
--
-- Enforced in the BEFORE UPDATE guard, NOT the app layer: `authenticated` holds
-- column-level UPDATE on payout_details_verified / payout_verification_status /
-- status / verified, so a client PATCH could otherwise set any of them. The
-- trigger is the security boundary (CLAUDE.md rule 7). Bringing the payout
-- columns under it also closes a pre-existing hole: before this, a seller could
-- PATCH their own row with payout_details_verified = true and skip validation.
--
-- Deliberately does NOT touch `status`: the storefront lists only
-- status='approved' (src/data/boutiques.ts:142), so a flagged shop must stay
-- `approved` and keep selling while the flag is reviewed.
--
-- Idempotent.

-- 1. Review flag on the boutique row. -----------------------------------------
alter table boutiques add column if not exists pending_review        boolean not null default false;
alter table boutiques add column if not exists pending_review_at     timestamptz;
alter table boutiques add column if not exists pending_review_fields text[];

comment on column boutiques.pending_review is
  'An approved shop changed an identity field (GST / registration / address / map) since its last admin review. Badge in the admin queue; does NOT hide the shop. Set by boutiques_guard_admin_fields; cleared only by an admin.';

-- The owner reads their own flag (to show "changes under review"); the admin
-- reads it in the queue. UPDATE is granted so an admin can clear it — a
-- non-admin clearing it is blocked by the guard below, exactly as for
-- verified/status, which `authenticated` can also technically write.
grant select (pending_review, pending_review_at, pending_review_fields) on boutiques to authenticated;
grant update (pending_review, pending_review_at, pending_review_fields) on boutiques to authenticated;

-- 2. Extend the admin-field guard. --------------------------------------------
-- Reproduced faithfully from the LIVE definition (read 2026-11-25 via
-- pg_get_functiondef) with the payout + review logic appended — nothing from
-- the live body dropped. If this function has been edited since, re-read the
-- live body before re-applying (CLAUDE.md rule 1).
create or replace function boutiques_guard_admin_fields()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  resubmitting constant boolean :=
    new.status = 'pending' and old.status in ('draft', 'changes_requested', 'rejected');
  changed text[] := '{}';
begin
  if is_admin() then
    return new;
  end if;

  -- Service-role / internal writes (run-payouts marking a payout verified,
  -- other SECURITY DEFINER paths that act without a signed-in user) carry no
  -- auth.uid(). They are trusted and skip every seller guard below. Anon never
  -- reaches here: the UPDATE policy restricts rows to owner = auth.uid(), and
  -- anon has none.
  if auth.uid() is null then
    return new;
  end if;

  -- ── Existing seller guards (unchanged from the live body) ────────────────
  if new.verified is distinct from old.verified
  or new.featured is distinct from old.featured then
    raise exception 'boutiques: verified/featured are admin-managed';
  end if;

  -- The admin's decision fields are theirs to write, with one exception: when a
  -- seller resubmits after a correction list they may clear the stale note and
  -- review timestamp, so their status screen does not keep showing feedback
  -- they have already acted on. Setting them to anything else stays blocked.
  if new.review_note is distinct from old.review_note
  and not (resubmitting and new.review_note is null) then
    raise exception 'boutiques: review_note is admin-managed';
  end if;

  if new.reviewed_at is distinct from old.reviewed_at
  and not (resubmitting and new.reviewed_at is null) then
    raise exception 'boutiques: reviewed_at is admin-managed';
  end if;

  -- A seller may only move their own boutique between "still setting up" and
  -- "submitted for review". Approving or un-rejecting is the admin's call.
  if new.status is distinct from old.status and new.status not in ('draft', 'pending') then
    raise exception 'boutiques: status % is admin-managed', new.status;
  end if;

  -- ── Payout: a seller may edit their own bank/UPI, but never mark it
  -- verified, and any change re-arms the penny-drop so the NEW destination is
  -- validated before the next payout. ─────────────────────────────────────
  if new.payout_details_verified is distinct from old.payout_details_verified
     and new.payout_details_verified then
    raise exception 'boutiques: payout verification is system-managed';
  end if;
  if new.payout_verification_status is distinct from old.payout_verification_status
     and new.payout_verification_status = 'verified' then
    raise exception 'boutiques: payout verification is system-managed';
  end if;

  if new.bank_account_number is distinct from old.bank_account_number
  or new.bank_ifsc           is distinct from old.bank_ifsc
  or new.bank_account_name   is distinct from old.bank_account_name
  or new.upi_id              is distinct from old.upi_id then
    -- Only re-arm a destination that had actually been verified; an account
    -- still being entered during onboarding is left as it was.
    if old.payout_details_verified or old.payout_verification_status = 'verified' then
      new.payout_details_verified    := false;
      new.payout_verification_status := 'pending';
      new.razorpayx_validation_id    := null;
    end if;
  end if;

  -- ── Identity fields on an already-approved shop → flag for an admin
  -- re-check, without taking the shop off the storefront. ──────────────────
  if old.status = 'approved' then
    if new.gst_number          is distinct from old.gst_number          then changed := changed || 'gst_number'; end if;
    if new.business_reg_number is distinct from old.business_reg_number then changed := changed || 'business_reg_number'; end if;
    if new.address_line        is distinct from old.address_line        then changed := changed || 'address_line'; end if;
    if new.area                is distinct from old.area                then changed := changed || 'area'; end if;
    if new.city                is distinct from old.city                then changed := changed || 'city'; end if;
    if new.district            is distinct from old.district            then changed := changed || 'district'; end if;
    if new.state               is distinct from old.state               then changed := changed || 'state'; end if;
    if new.pincode             is distinct from old.pincode             then changed := changed || 'pincode'; end if;
    if new.map_url             is distinct from old.map_url             then changed := changed || 'map_url'; end if;
    if new.latitude            is distinct from old.latitude            then changed := changed || 'latitude'; end if;
    if new.longitude           is distinct from old.longitude           then changed := changed || 'longitude'; end if;

    if array_length(changed, 1) is not null then
      new.pending_review     := true;
      new.pending_review_at  := now();
      -- Accumulate across edits so an admin sees everything touched since the
      -- last review, not only the latest field.
      new.pending_review_fields :=
        array(select distinct unnest(coalesce(old.pending_review_fields, '{}') || changed));
    end if;
  end if;

  -- pending_review is the admin's to clear (the is_admin early-return above).
  -- A seller may never turn it off.
  if new.pending_review is distinct from old.pending_review
     and new.pending_review = false then
    raise exception 'boutiques: pending_review is admin-managed';
  end if;

  return new;
end $function$;

drop trigger if exists boutiques_guard_admin_fields on boutiques;
create trigger boutiques_guard_admin_fields
  before update on boutiques
  for each row execute function boutiques_guard_admin_fields();

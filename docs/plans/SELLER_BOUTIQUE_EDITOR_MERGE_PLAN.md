# Seller "Manage boutique" — merge the two editors & re-flag sensitive edits

**Status:** Plan (not built). Drafted 2026-11-25.
**Decision taken:** merge the two seller edit screens into one; after approval,
sensitive edits stay editable but re-flag for review (payout changes pause
payouts until re-verified).

---

## 1. The problem today

The seller profile hub shows two cards under **BUSINESS** that overlap and
confuse:

| Card | Route | File | Edits |
|---|---|---|---|
| **Boutique Profile** | `/seller/boutique` | `BoutiqueProfileEdit.tsx` | owner, name, city, area, phone, bio, logo, cover |
| **Business details** | `/seller/onboarding` | `SellerOnboarding.tsx` (edit mode) | **everything** — the full 6-step signup wizard reopened |

Two concrete faults:

1. **Overlap.** Both edit name, logo, cover, bio, city/area, phone. A seller
   can't tell which one to use.
2. **"Business details" is literally the onboarding wizard reopened**
   (`SellerOnboarding.tsx:391`, header "Edit your business details" at `:704`).
   Clicking it drops an approved seller back into a 6-step signup-looking flow.
3. **No guard after approval.** An approved seller can silently change *anything*
   — including the **payout bank account**, **GST** and **registered address** —
   with no re-review (`SellerOnboarding.tsx:708`: "changes… never need
   re-approval").

### What the code forces on the design (verified)

- The buyer storefront lists **only `status='approved'`** boutiques
  (`src/data/boutiques.ts:142`). → **We must not flip `status` back to
  `pending` on an edit** — that would delete a live shop from the storefront.
  The review flag has to be separate from `status`.
- Payouts read bank details **straight off the live `boutiques` row**
  (`api/run-payouts.js:256`), but only pay when **`payout_details_verified`** is
  true, otherwise they run a penny-drop / UPI validation first
  (`api/run-payouts.js:89`). → **Resetting `payout_details_verified=false` on a
  bank change makes the new account re-validate before any payout.** This is the
  real fraud protection and it reuses existing infrastructure
  (`payout_verification_status`, `razorpayx_validation_id`).

---

## 2. Target design

### 2a. One card, one editor

- **Profile hub** (`ProfileHub.tsx:60-71`): replace the two cards with **one** —
  **"Manage boutique"** · _"Profile, contact, address, payout & more"_ →
  `/seller/boutique`. Keep the "Verification status" row for non-approved shops.
  The header identity card already points to `/seller/boutique`; keep it.
- The merged editor is a **single sectioned page** (anchored sections or
  accordions — **not** a stepper), each section with its **own Save button** so
  one edit never forces validating all seven, and the review flag only fires for
  the sensitive section actually touched.

**Sections**

1. **Storefront** — logo, cover, boutique name, bio
2. **Contact** — phone, WhatsApp, email, Instagram
3. **Address & location** — door, street, pincode, city, district, state, map pin — *review-gated*
4. **Business & tax** — categories, GST, business reg, years — *GST/reg review-gated*
5. **Timings** — open/close, working days
6. **Delivery & dispatch** — zone rates, free-over, dispatch days, return window
7. **Payout** — bank name/number/IFSC, UPI — *payout-gated, + existing 2FA*

All the field logic already exists in `SellerOnboarding.tsx` (FormKit fields,
`FulfilmentCard`, `DeliveryRateCard`, `ShopLocationPicker`, pincode & IFSC
lookups, `MfaStepUp`). **This is a re-layout from stepper → sections, not new
form logic.**

### 2b. Split registration from management

- Keep **`SellerOnboarding`** as **registration only** — account step + 6 steps +
  consent + submit-for-review — serving `draft` and `changes_requested`. **Remove
  its `editMode` branch** (`:327`, `:391-398`, `:639-656`, and the edit-mode
  header copy).
- New **`BoutiqueManage`** page = the sectioned editor, for `approved` / `pending`
  shops. Profile hub + header card route here.
- Result: **editing never reopens the signup wizard.**

> Lighter alternative if we want less churn: keep one file and swap
> stepper↔sections by status. Recommended: the clean split — it's what makes the
> two flows stop bleeding into each other.

### 2c. Field tiers (exact)

| Tier | Behaviour on save (when shop is `approved`) | Columns |
|---|---|---|
| **Free** | Save in place. Shop stays live. No review. | `name, owner_name, description, logo_url, cover_url, phone, whatsapp, email, instagram, open_time, close_time, working_days, delivery_*, dispatch_days_min/max, return_window_days, free_delivery_over` |
| **Review-gated** | Save in place, shop **stays live**, raise a review flag for admin. | `gst_number, business_reg_number, address_line, area, city, district, state, pincode, map_url, latitude, longitude` |
| **Payout** | Save values, **reset `payout_details_verified=false`** + `payout_verification_status='pending'` so the new account re-validates before the next payout. + require existing `MfaStepUp` 2FA. | `bank_account_name, bank_account_number, bank_ifsc, upi_id` |

> `city` files the shop into the buyer directory; it's in the address block as
> review-gated. If we'd rather not gate discoverability edits, `city`/`area` can
> be moved to Free — **open decision**.

### 2d. The re-flag mechanism (does **not** touch `status`)

New migration **0116** (hand-applied by the user — see CLAUDE.md rule 1):

- `boutiques.pending_review boolean not null default false` — "has unreviewed
  sensitive changes." Shown as a badge in the admin queue; **does not hide the
  shop**.
- A record of *what* changed, so admin sees the delta. Minimal:
  `boutiques.pending_review_changes jsonb` holding `{field: {from, to}}`; or a
  small `boutique_change_requests` table if we want history. **Open decision.**

**On save of a section:**
- Free fields → write, done.
- Review-gated field changed → write new value, set `pending_review=true`,
  append to the change record. Shop stays `approved`/live.
- Payout field changed → write new value, set `payout_details_verified=false`,
  `payout_verification_status='pending'`, (optionally `pending_review=true`),
  fire the RazorpayX re-validation. Shop stays live; **payouts pause for this
  shop until the new account validates.**

**Admin side (new, specify now / build later):** a "Changes to review" filter in
the admin boutiques queue listing `pending_review=true` shops with the
before/after, and a button that clears `pending_review`. Payout re-validation is
already surfaced via `payout_verification_status`.

### 2e. UX copy

Each sensitive section carries an inline note so the seller isn't surprised:

> _"Changing your bank account / GST / registered address needs a quick re-check
> by our team. Your shop stays open while we review."_

Payout edits on a verified shop trigger the existing `MfaStepUp` 2FA
(`bankOnFile` gate already in `SellerOnboarding.tsx:322-323`).

---

## 3. Build order (when approved to build)

1. **Migration 0116** — `pending_review` (+ change record). Idempotent. User
   applies it; don't report it live until the column is confirmed present.
2. **`data/boutiques.ts`** — a `saveBoutiqueSection(id, patch, prevRow)` helper
   that diffs against the sensitive sets and sets the flags. One place owns the
   classification.
3. **`BoutiqueManage.tsx`** — sectioned editor reusing the existing field
   components; per-section save.
4. **`ProfileHub.tsx`** — collapse the two cards into one "Manage boutique".
5. **`SellerOnboarding.tsx`** — strip the edit-mode branch (registration only).
6. **Admin queue** — `pending_review` filter + clear action.

## 4. Open decisions for the owner

1. **Change record depth** — single `pending_review` boolean, or a full
   before/after `jsonb` / history table?
2. **Address/city tier** — gate the whole address block (safer), or let
   `city`/`area` stay freely editable (discoverability convenience)?
3. **Review-gated = stay live?** — recommended: GST/address edits apply
   immediately and are only flagged. Stricter option: hold the new value until an
   admin approves (needs a pending-value buffer like payouts). Payout is always
   held-until-verified regardless.

## 5. Not doing

- No `status` flip for edits (would hide a live shop).
- No new payout-verification system — reuse `payout_details_verified` /
  `payout_verification_status` / `razorpayx_validation_id`.
- No third editor; the two existing ones collapse to one.

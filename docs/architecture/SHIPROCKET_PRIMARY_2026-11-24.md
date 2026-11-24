# Shiprocket as primary carrier — end-to-end booking

**Date:** 2026-11-24
**Status:** Built. `npx tsc -b` and `npm run lint` pass (0 errors; 37 pre-existing warnings, none in the changed files). The two Edge Functions are **not deployed** — they deploy by hand.
**Supersedes:** the carrier order set in `DTDC_INTEGRATION_2026-11-14.md` (DTDC first) and completes `SHIPROCKET_INTEGRATION_2026-08-10.md`.

---

## 0. What this changes, in one paragraph

Shiprocket becomes the **primary** carrier for self-serve seller booking, ahead
of DTDC. The booking is end-to-end from the seller console: pick a courier,
choose a pickup **date**, optionally confirm the parcel's **weight and box**, and
the AWB, label and tracking come back — the freight is paid by the platform's
single prepaid Shiprocket wallet (recharged in the Shiprocket panel). Nothing
about per-seller wallets was built: that idea was considered and **dropped**.

---

## 1. Decisions taken

| Decision | Value | Why |
|---|---|---|
| Carrier order | **Shiprocket → DTDC → Shadowfax → manual** | The aggregator covers the most pincodes, so leading with it drops the fewest parcels to a manual docket |
| Account model | **One platform account** (unchanged) | Sellers remain pickup locations under it; one API credential, one wallet |
| Who pays freight | **The platform's single Shiprocket wallet** | No per-seller wallet — explicitly dropped 2026-11-24 |
| Empty wallet / no courier | **Decline → fall through to DTDC/Shadowfax → manual docket** | A paid order still ships; the chain never books two carriers for one sale |
| Pickup scheduling | **Date only for Shiprocket** | Shiprocket schedules a date, not a two-hour slot; DTDC keeps the slot |
| Parcel weight/box | **Seller may override** per parcel; else product/shop defaults | The courier reweighs at its hub and bills the difference to the wallet |
| Pricing mirror | **Untouched** | `src/lib/pricing.ts` / `api/_pricing.js` are not in this diff |

---

## 2. What was changed

### Edge Functions (deploy by hand)

| File | Change |
|---|---|
| `supabase/functions/book-parcel/index.ts` | Reordered the auto-fallback chain to **Shiprocket first**, DTDC second, Shadowfax third. Forwards the pickup date and any per-parcel weight/box override to each carrier. |
| `supabase/functions/shiprocket-book/index.ts` | Accepts `date` (pickup date, best-effort `pickup_date` on `generate/pickup`) and `weightKg`/`lengthCm`/`breadthCm`/`heightCm` overrides. Declares the seller-confirmed parcel to Shiprocket and stores the declared weight. Clearer no-AWB message (the seller can't touch the platform wallet, so it reads "couldn't collect" and offers the manual docket). |

### App

| File | Change |
|---|---|
| `src/components/seller/ShipSheet.tsx` | Time slot hidden for Shiprocket (date-only, with a one-line note); new collapsible **Weight & size** override (blank = defaults). |
| `src/pages/seller/OrderDetail.tsx` | Courier picker lists **Shiprocket couriers first** (cheapest default), DTDC after; forwards the weight/box override to `bookParcel`. |
| `src/data/shipments.ts` | `BookOptions` carries the four parcel-override fields; `bookParcel` already spreads them through. |

**No migration.** The override is sent to Shiprocket (where it prevents the
discrepancy charge) and the declared weight is stored in the existing
`shipments.declared_weight_kg`. Declared dimensions are not persisted — nothing
reads them, and adding columns would be a hand-applied migration for no reader.

---

## 3. Needs your hand

**The integration does not work until these are done.** (Most were already owed
from `SHIPROCKET_INTEGRATION_2026-08-10.md` §6; they are repeated here because
Shiprocket now *leads* the chain, so a misconfigured account affects every
booking, not just a fallback.)

1. **Migrations 0065, 0066, 0067 applied** (the Shiprocket schema). Check the
   objects exist — the `schema_migrations` table cannot answer "is it applied?".
2. **Complete the account's KYC** in the Shiprocket panel (Settings → Company
   Setup / KYC — PAN + bank, sometimes GST/Aadhaar). **Until KYC is Approved,
   every booking returns "KYC verification is mandated" and falls through to
   DTDC.** This is an account-level block, not a per-order one, and it is the
   most common first-run wall. The seller-facing banner hides the KYC wording
   (they can't act on the platform account); the raw reason stays in the logs.
3. **A Shiprocket API User** (Settings → API → Create an API User — a *separate*
   email from the panel login).
4. **Secrets set:**
   ```bash
   supabase secrets set SHIPROCKET_EMAIL=... SHIPROCKET_PASSWORD=... SHIPROCKET_WEBHOOK_TOKEN=<long random string>
   ```
5. **Deploy the functions:**
   ```bash
   supabase functions deploy book-parcel
   supabase functions deploy shiprocket-book
   # (the tracking webhook is already deployed; redeploy only if it changed)
   ```
6. **Webhook** in the Shiprocket panel → `https://<project>.supabase.co/functions/v1/tracking`, `x-api-key` = `SHIPROCKET_WEBHOOK_TOKEN`.
7. **A pickup location per boutique** registered in the Shiprocket panel, its
   nickname pasted into **Admin → Deliveries → Shiprocket** with "Let this shop
   book couriers" ticked.
8. **Recharge the wallet** (prepaid, in the Shiprocket panel). Now that
   Shiprocket leads, an empty wallet makes every booking fall through to DTDC.
   You check and top this up in the Shiprocket panel — there is no in-app balance.
9. **Turn on the Shiprocket master switch** on the same admin tab.

---

## 4. Not verified

- **Nothing has been run against a live Shiprocket account or database.** The
  Edge Functions are Deno and were not compiled (`deno` is not installed here);
  `tsc -b` excludes them by design.
- **`pickup_date` on `generate/pickup` is best-effort.** It is wrapped in
  try/catch — if Shiprocket's validator rejects the field, the parcel still
  books with its AWB and the pickup is simply scheduled by their default. Confirm
  the field is honoured on the first live booking.
- **The weight/box override is not reconciled** against what the courier actually
  weighed. `shipments.freight_charge` records the booked freight; a later
  discrepancy charge still lands on the wallet unseen (as before).

/**
 * Book one order with whichever carrier will take it.
 *
 * THE ONE ENTRY POINT the seller console calls. Named for what it does rather
 * than for a carrier, because which carrier carries a parcel is our problem,
 * not the seller's — they tap "ship" and something turns up at their door.
 *
 * THE CHAIN
 *
 *   Shiprocket  →  DTDC  →  Shadowfax  →  the seller types a docket number
 *
 * WHY SHIPROCKET FIRST (2026-11-24)
 * Shiprocket is now the platform's primary carrier for self-serve booking. It
 * is an AGGREGATOR: it picks among several couriers per pincode, so its
 * coverage is the union of theirs rather than any one carrier's — their own
 * site advertises 16,681 of India's ~19,000 pincodes, and the missing ones are
 * disproportionately rural, which is exactly where this marketplace's buyers
 * are. Leading with the aggregator means the fewest parcels fall through to a
 * manual docket. The platform's single prepaid Shiprocket wallet pays the
 * freight; when it runs dry a booking is refused and the seller drops onto the
 * manual docket form (it never silently books a second carrier for one sale).
 *
 * WHY DTDC SECOND (was first until 2026-11-24)
 * DTDC is the platform's contracted carrier: one account (GL24686), one rate
 * card, one monthly invoice, and a pickup from the boutique's own address. It
 * stays in the chain as the first fallback — a single carrier with rural gaps,
 * which is why it no longer leads, but a real second option that catches lanes
 * Shiprocket's couriers decline.
 *
 * WHY SHADOWFAX THIRD
 * Shadowfax stays as the third rung because a further carrier still catches
 * orders the others decline, and each one it catches is an order the seller
 * does not have to enter a docket number for by hand.
 *
 * HOW IT CALLS THEM
 * Over HTTP, forwarding the seller's own JWT, rather than importing their
 * logic. Every booking function authenticates the caller itself and checks
 * that the order belongs to them, so this orchestrator gains no authority of
 * its own — it decides order, nothing else. `shiprocket-book` in particular is
 * not modified at all.
 *
 * WHY NOT ORCHESTRATE IN THE BROWSER
 * Each individual booking is atomic server-side, so a browser could in
 * principle do this. But a seller who navigates away between the two calls
 * would leave an order that is paid, packed and unshipped, with no record of
 * why. The chain belongs where it cannot be interrupted.
 */

import { CORS, json } from '../_shared/courier.ts';

type Attempt = { carrier: string; reason: string };

/** Call one booking function with the seller's own credentials. */
async function tryCarrier(
  fn: string,
  orderId: string,
  authHeader: string,
  body: Record<string, unknown> = {},
): Promise<{ ok: boolean; body: Record<string, unknown> | null; status: number }> {
  const base = Deno.env.get('SUPABASE_URL') ?? '';
  try {
    const res = await fetch(`${base}/functions/v1/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
        apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      },
      body: JSON.stringify({ orderId, ...body }),
    });
    const parsed = await res.json().catch(() => null);
    return { ok: res.ok && Boolean(parsed?.ok), body: parsed, status: res.status };
  } catch (e) {
    // A carrier we could not reach is a carrier that declined, for our
    // purposes — but it is logged differently, because an outage is temporary
    // and a coverage gap is not.
    console.error(`book-parcel: ${fn} unreachable`, (e as Error).message);
    return { ok: false, body: { error: `${fn} unreachable: ${(e as Error).message}` }, status: 503 };
  }
}

/**
 * Should we stop the chain rather than try the next carrier?
 *
 * Some refusals are about the ORDER, not the carrier — already shipped, not
 * yours, no address, a legacy cash order. Trying a second carrier cannot fix
 * any of those, and on "already shipped" it risks a second real parcel against
 * one sale. Only a carrier-specific refusal should advance the chain.
 */
function isTerminal(status: number, body: Record<string, unknown> | null): boolean {
  // Auth and ownership failures: the next carrier would refuse identically.
  if (status === 401 || status === 403 || status === 404) return true;
  // The carrier DID book a parcel and then failed to record it. The order is
  // shipped whether or not our tables say so, and the next carrier would
  // happily book a second one against the same sale. Carriers flag this
  // explicitly; the text match is a fallback for an older deployed copy that
  // predates the flag (Edge Functions deploy by hand, so both can be live).
  if (body?.booked === true) return true;
  const err = String(body?.error ?? '').toLowerCase();
  if (err.includes('awb') && err.includes('booked')) return true;
  // A COD order, a closed order, or one already carrying a parcel.
  return err.includes('already') || err.includes('closed') || err.includes('cash-on-delivery');
}

/**
 * Carriers refuse a parcel in their own API's words — "AUTO_ALLOCATED_HUB_NOT_
 * FOUND", "no shipment id" — which mean nothing to a seller staring at the ship
 * sheet. Translate the handful we understand into one plain sentence that says
 * what is wrong and the two things the SELLER can actually do about it (this
 * banner is seller-facing: they can't touch the platform's courier account, so
 * it never names account codes or hub settings — those are the owner's job and
 * are already in the function logs). Anything we don't recognise falls through
 * to the carrier's raw reason, so a NEW failure is still shown, never swallowed.
 */
function humaniseReason(carrier: string, reason: string): string {
  const r = reason.toLowerCase();

  // DTDC auto-allocates the pickup hub from the shop's own pincode. "Hub not
  // found" = DTDC isn't set up to collect from that pincode (or it's wrong).
  if (carrier === 'dtdc' && (r.includes('auto_allocated_hub_not_found') || r.includes('allocated hub'))) {
    return 'DTDC can’t arrange a pickup from your shop’s pincode, so it couldn’t book this parcel '
      + 'automatically. Check that your shop’s pincode is correct in your profile — if it is, DTDC '
      + 'simply doesn’t collect from your area yet.';
  }
  // Shiprocket account-level blocks — KYC not completed, account on hold. The
  // seller can act on NONE of these: the Shiprocket account is the platform's,
  // and they have no login for it. The raw text ("complete your KYC") is worse
  // than opaque, it is misleading — it reads as if the seller must go and do
  // something. Translate to "not available right now, use another courier". The
  // real reason is in the function log and the response's rawReason for the owner.
  if (carrier === 'shiprocket' && (r.includes('kyc') || r.includes('verification is mandated') || r.includes('account is') || r.includes('on hold'))) {
    return 'This courier isn’t available through MangaiMart right now — please pick another courier in the list above.';
  }
  // Shiprocket took the order but returned no shipment — almost always no
  // verified pickup address on the Shiprocket account, or no serviceable courier.
  if (carrier === 'shiprocket' && (r.includes('no shipment id') || r.includes('no shipment'))) {
    return 'Shiprocket couldn’t confirm a pickup for this parcel.';
  }
  // Unknown refusal: keep the carrier's own words, but frame them so the banner
  // still reads as a sentence rather than a dangling API string.
  return `${carrier.toUpperCase()} couldn’t book this parcel: ${reason}.`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const {
    orderId, carrier, date, slotStart, slotEnd, courierId,
    weightKg, lengthCm, breadthCm, heightCm,
  } = await req.json().catch(() => ({ orderId: null }));
  if (!orderId) return json({ error: 'orderId is required' }, 400);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Not signed in' }, 401);

  // The pickup slot the seller chose in the ship sheet, forwarded to the carrier.
  // DTDC schedules a two-hour collection window; Shiprocket honours only the
  // date (it has no slot), which is why the ship sheet hides the slot for it.
  const pickup = (date && slotStart && slotEnd) ? { date, slotStart, slotEnd } : {};

  // The per-parcel weight and box the seller confirmed in the ship sheet, when
  // they overrode the product/shop defaults. Forwarded so the booking declares
  // what the seller actually packed rather than a guess — the courier reweighs
  // at its hub and bills the difference, so a wrong declared weight becomes a
  // real charge on the platform's wallet. Carriers fall back to
  // order_parcel_metrics when a field is absent.
  const parcel: Record<string, unknown> = {};
  if (weightKg != null) parcel.weightKg = weightKg;
  if (lengthCm != null) parcel.lengthCm = lengthCm;
  if (breadthCm != null) parcel.breadthCm = breadthCm;
  if (heightCm != null) parcel.heightCm = heightCm;

  /* ── Seller chose a carrier: honour it, no auto-fallback ─────────────────── */
  // "Seller picks the courier" (2026-11-14). When the ship sheet names a
  // carrier we book that one and surface its refusal, rather than quietly
  // trying another — the seller decided, and switching couriers under them
  // would be a surprise.
  if (carrier) {
    const fn = carrier === 'dtdc' ? 'dtdc-book'
      : carrier === 'shiprocket' ? 'shiprocket-book'
      : carrier === 'shadowfax' ? 'shadowfax-book' : null;
    if (!fn) return json({ error: `Unknown courier: ${carrier}` }, 400);
    // A Shiprocket courier_company_id the seller picked in the ship sheet is
    // forwarded so shiprocket-book assigns that exact courier.
    const extra = carrier === 'shiprocket' && courierId ? { courierId } : {};
    const r = await tryCarrier(fn, orderId, authHeader, { ...pickup, ...parcel, ...extra, skipFallback: true });
    if (r.ok) return json({ ...r.body, provider: carrier });
    if (r.body?.booked === true) return json(r.body, r.status);
    if (r.status === 401 || r.status === 403 || r.status === 404) {
      return json(r.body ?? { error: 'Could not book this parcel' }, r.status);
    }
    const rawReason = String(r.body?.reason ?? r.body?.error ?? `HTTP ${r.status}`);
    const reason = humaniseReason(carrier, rawReason);
    return json({
      error: `${reason} You can ship it with your own courier and enter the docket number below.`,
      // The carrier's own words, kept for the function log and support — never
      // the thing the seller reads.
      rawReason,
      canShipManually: true,
    }, 409);
  }

  const attempts: Attempt[] = [];

  /* ── 1. Shiprocket, the primary aggregator (2026-11-24) ─────────────────── */
  // Leads the chain: it routes across several couriers per pincode, so it is
  // the single carrier most likely to accept any given lane. The pickup date
  // and any per-parcel weight/box the seller confirmed are forwarded; an empty
  // platform wallet surfaces as a decline here and advances to DTDC.
  const sr = await tryCarrier('shiprocket-book', orderId, authHeader, { ...pickup, ...parcel });
  if (sr.ok) {
    return json({ ...sr.body, provider: 'shiprocket', attempts });
  }
  if (isTerminal(sr.status, sr.body)) {
    // Nothing about the next carrier would change this answer.
    return json(sr.body ?? { error: 'Could not book this parcel' }, sr.status);
  }
  attempts.push({ carrier: 'shiprocket', reason: String(sr.body?.error ?? `HTTP ${sr.status}`) });

  /* ── 2. DTDC, the contracted fallback ───────────────────────────────────── */
  // Declines arrive as `{ declined: true, reason }` 409 — not enabled for the
  // shop, an unserviceable lane, a rejected field. A configuration or transport
  // fault arrives as `{ error }` instead; both advance the chain, but the
  // function logs the second kind as a fault so it gets found.
  const dt = await tryCarrier('dtdc-book', orderId, authHeader, { ...pickup, ...parcel });
  if (dt.ok) {
    return json({
      ...dt.body,
      provider: 'dtdc',
      // Only a fallback when something declined before it. The seller is told
      // which courier is coming, not which one said no.
      fellBack: attempts.length > 0,
      fallbackReason: attempts[0]?.reason,
      attempts,
    });
  }
  if (isTerminal(dt.status, dt.body)) {
    return json(dt.body ?? { error: 'Could not book this parcel' }, dt.status);
  }
  attempts.push({ carrier: 'dtdc', reason: String(dt.body?.reason ?? dt.body?.error ?? `HTTP ${dt.status}`) });

  /* ── 3. Shadowfax ───────────────────────────────────────────────────────── */
  // skipFallback stops it calling shiprocket-book straight back, which would
  // retry a carrier that has already declined and could book twice.
  const sfx = await tryCarrier('shadowfax-book', orderId, authHeader, { skipFallback: true });
  if (sfx.ok) {
    return json({
      ...sfx.body,
      provider: 'shadowfax',
      fellBack: true,
      fallbackReason: attempts[0]?.reason,
      attempts,
    });
  }
  // Shadowfax is the LAST carrier before the manual docket form. Only a parcel
  // it actually booked and then failed to record (`booked: true`) should stop
  // the chain here. Everything else — a decline, an error, or a 404 because
  // shadowfax-book is not deployed — must fall through to the clean manual
  // message below, NOT surface a raw function-not-found 404 that the seller
  // console can only render as "Edge Function returned a non-2xx status code".
  if (sfx.body?.booked === true) {
    return json(sfx.body, sfx.status);
  }
  attempts.push({
    carrier: 'shadowfax',
    reason: String(sfx.body?.reason ?? sfx.body?.error ?? `HTTP ${sfx.status}`),
  });

  /* ── 4. Nobody will carry it ────────────────────────────────────────────── */
  // The seller's next step is the manual docket form, so say that plainly
  // instead of stacking two carriers' error messages and leaving them to guess.
  console.warn('book-parcel: no carrier accepted', { orderId, attempts });
  return json({
    error: 'No courier could pick this parcel up automatically. Ship it with your own courier and enter the docket number.',
    canShipManually: true,
    attempts,
  }, 409);
});

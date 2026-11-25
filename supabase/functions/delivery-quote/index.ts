/**
 * Live delivery price for a cart, per boutique, signed so the API can trust it.
 *
 * The buyer's checkout calls this once their delivery pincode is known. For each
 * boutique in the bag it:
 *   1. computes the parcel's real weight server-side from products.weight_grams
 *      (falling back to boutiques.default_weight_grams) AND declares the shop's
 *      box (boutiques.package_*_cm) — the browser never sends either, so neither
 *      can be shaved for a cheaper quote, and both MUST match what shiprocket-book
 *      declares (order_parcel_metrics) or Shiprocket's volumetric weight puts the
 *      booking a whole rate slab above the quote and the platform eats the gap;
 *   2. asks SHIPROCKET for the cheapest live rate on the lane (shop pincode →
 *      delivery pincode at that weight) — the same aggregator courier-serviceability
 *      already uses, where the rate was read but never surfaced;
 *   3. adds the platform buffer (platform_settings.delivery_markup_*), or makes it
 *      free when the boutique's goods clear its free_delivery_over threshold;
 *   4. SIGNS the resulting paise with DELIVERY_QUOTE_SECRET (HMAC-SHA256), bound to
 *      the boutique, the destination pincode and the exact item set.
 *
 * api/create-order.js opens checkout for, and api/place-order.js binds the payment
 * to, the signed figure — neither re-quotes Shiprocket (a live quote is not
 * reproducible to the paise). A tampered or expired token is simply ignored and the
 * endpoints fall back to the seller's flat zone rate, which is the status quo.
 *
 * Fails SOFT per boutique: if Shiprocket auth or the API is down, that boutique
 * comes back `degraded:true` with no token, and the browser prices it from the flat
 * zone rate it already computes. An outage never blocks a sale.
 *
 * Callable by anonymous buyers (the storefront anon key satisfies verify_jwt);
 * Shiprocket credentials and the signing secret never leave the server. Deployed by
 * hand (CLAUDE.md), needs _shared/shiprocket.ts alongside it.
 */

import { CORS, SrError, getToken, json, serviceClient, srFetch } from '../_shared/shiprocket.ts';

type ServiceabilityResponse = {
  data?: {
    available_courier_companies?: {
      courier_company_id?: number | string;
      courier_name?: string;
      rate?: number;
    }[];
  };
};

// A quote is good for 24 hours — matched to the pending-payment retry window
// (src/lib/pendingPayment.ts MAX_AGE_MS). A captured-but-unsettled payment offered
// for retry within that window must still carry a valid token, or place-order would
// re-price delivery at the flat rate and refund the (correct) paid amount as a
// mismatch. The token is bound to the exact boutique, pincode and item set, so a
// long life only lets a buyer hold THEIR OWN quote for the same bag, not abuse it.
const TOKEN_TTL_SECONDS = 24 * 60 * 60;

/** URL-safe base64 with no padding, matching atob/btoa on the verifier side. */
function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(payloadB64: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return b64url(new Uint8Array(mac));
}

/** Canonical item string for a boutique's lines — MUST match api/_deliveryQuote.js.
 *  Sorted by product_id, each `id:qty`, joined by '|'. qty normalised the same way
 *  create-order/place-order normalise it (floor, min 1). */
function itemString(lines: { product_id: string; qty: number }[]): string {
  return lines
    .map((l) => ({ id: l.product_id, qty: Math.max(1, Math.floor(Number(l.qty) || 1)) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((l) => `${l.id}:${l.qty}`)
    .join('|');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const secret = Deno.env.get('DELIVERY_QUOTE_SECRET');
  if (!secret) {
    console.error('delivery-quote: DELIVERY_QUOTE_SECRET is not set on this project');
    // Not fatal to the sale: no secret means no signed quotes, so the browser
    // (and the API) use the flat zone rate exactly as before live pricing.
    return json({ ok: true, degraded: true, reason: 'NOT_CONFIGURED', boutiques: [] });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const dest = String(body?.destPincode ?? '').replace(/\D/g, '');
    const rawItems = Array.isArray(body?.items) ? body.items : [];
    if (dest.length !== 6) return json({ error: 'destPincode must be 6 digits' }, 400);
    if (rawItems.length === 0) return json({ error: 'items are required' }, 400);

    const db = serviceClient();

    // Authoritative product rows — only live products can be priced/sold, matching
    // create-order.js / place-order.js so the grouped item set (and its signature)
    // is identical on all three.
    const ids = [...new Set(rawItems.map((it: { product_id?: string }) => it?.product_id).filter(Boolean))];
    const { data: products, error: prodErr } = await db
      .from('products')
      .select('id, price, boutique_id, weight_grams')
      .in('id', ids)
      .eq('status', 'active')
      .is('deleted_at', null);
    if (prodErr) throw prodErr;
    const byId = new Map((products ?? []).map((p) => [p.id, p]));

    // Group into one parcel per boutique.
    type Group = { boutiqueId: string; lines: { product_id: string; qty: number }[]; goods: number };
    const groups = new Map<string, Group>();
    for (const it of rawItems as { product_id?: string; qty?: number }[]) {
      const p = byId.get(it?.product_id ?? '');
      if (!p) continue;
      const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
      const g = groups.get(p.boutique_id) ?? { boutiqueId: p.boutique_id, lines: [], goods: 0 };
      g.lines.push({ product_id: p.id, qty });
      g.goods += Number(p.price) * qty;
      groups.set(p.boutique_id, g);
    }
    if (groups.size === 0) return json({ error: 'None of the items are available' }, 400);

    // Boutique parcel + delivery terms. CLAUDE.md rule 5: `boutiques` has no blanket
    // SELECT, so every column is named.
    const { data: boutiques, error: bErr } = await db
      .from('boutiques')
      .select('id, name, pincode, default_weight_grams, free_delivery_over, package_length_cm, package_breadth_cm, package_height_cm')
      .in('id', [...groups.keys()]);
    if (bErr) throw bErr;
    const shopById = new Map((boutiques ?? []).map((b) => [b.id, b]));

    // Platform buffer (same row commission is read from). Failure → no buffer, the
    // buyer simply pays the bare courier rate rather than the checkout breaking.
    let markupFlat = 0;
    let markupPct = 0;
    try {
      const { data: s } = await db
        .from('platform_settings')
        .select('delivery_markup_flat, delivery_markup_pct')
        .eq('id', 1)
        .maybeSingle();
      markupFlat = Number(s?.delivery_markup_flat) || 0;
      markupPct = Number(s?.delivery_markup_pct) || 0;
    } catch (e) {
      console.warn('delivery-quote: markup read failed, charging bare rate —', (e as Error).message);
    }

    const srToken = await getToken(db).catch((e) => {
      // One auth failure degrades EVERY boutique — there is no per-lane recovery
      // from a missing token. Thrown up to the catch below, which answers degraded.
      throw new SrError(502, (e as Error).message);
    });

    const nowSec = Math.floor(Date.now() / 1000);
    const exp = nowSec + TOKEN_TTL_SECONDS;

    const out = [];
    for (const g of groups.values()) {
      const shop = shopById.get(g.boutiqueId);
      const defaultGrams = Number(shop?.default_weight_grams) || 500;
      // Re-add the boutique default for any line whose product had no weight.
      let grams = 0;
      for (const l of g.lines) {
        const p = byId.get(l.product_id);
        const per = p && p.weight_grams != null ? Number(p.weight_grams) : defaultGrams;
        grams += per * l.qty;
      }
      // Mirror order_parcel_metrics exactly — round to 2 dp, 0.05 kg floor — so the
      // weight the buyer is quoted is the weight shiprocket-book declares. A quote
      // on a different weight than the booking can land on a different rate slab.
      const weightKg = Math.max(0.05, Math.round(grams / 10) / 100);
      const pickup = String(shop?.pincode ?? '').replace(/\D/g, '');
      const itemStr = itemString(g.lines);

      // The shop's box. Shiprocket bills forward freight on max(dead, volumetric)
      // weight; shiprocket-book declares these package_*_cm, so the quote must send
      // them to serviceability too. Omitting them rated only the 0.5 kg dead weight
      // and under-quoted every light-but-bulky parcel by a full slab — the live
      // leak on MM-WFZLZXEE31 (quoted 0.5 kg / ₹85.72, billed 0.864 kg vol / ₹141.72).
      // Only sent when all three are present and positive, matching the booking,
      // which declares no box (weight-only rating) when the shop left them blank.
      const boxL = Number(shop?.package_length_cm) || 0;
      const boxB = Number(shop?.package_breadth_cm) || 0;
      const boxH = Number(shop?.package_height_cm) || 0;
      const dimsQuery = boxL > 0 && boxB > 0 && boxH > 0
        ? `&length=${boxL}&breadth=${boxB}&height=${boxH}`
        : '';

      // A boutique with no usable pickup pincode cannot be live-quoted; degrade it
      // so the browser prices it from the flat rate instead of failing the bag.
      if (pickup.length !== 6) {
        out.push({ boutiqueId: g.boutiqueId, degraded: true });
        continue;
      }

      let couriers: NonNullable<NonNullable<ServiceabilityResponse['data']>['available_courier_companies']> = [];
      try {
        const res = await srFetch<ServiceabilityResponse>(
          srToken,
          `/courier/serviceability/?pickup_postcode=${pickup}&delivery_postcode=${dest}&weight=${weightKg}${dimsQuery}&cod=0`,
        );
        couriers = res?.data?.available_courier_companies ?? [];
      } catch (e) {
        console.error('delivery-quote: serviceability failed', { boutique: g.boutiqueId, pickup, dest, error: (e as Error).message });
        out.push({ boutiqueId: g.boutiqueId, degraded: true });
        continue;
      }

      const rated = couriers
        .map((c) => ({
          id: c.courier_company_id != null ? String(c.courier_company_id) : null,
          name: c.courier_name ?? null,
          rate: Number.isFinite(Number(c.rate)) ? Number(c.rate) : null,
        }))
        .filter((c) => c.id && c.name && c.rate != null)
        .sort((a, b) => (a.rate as number) - (b.rate as number));

      // No courier serves this lane — genuinely undeliverable, NOT degraded. The
      // browser blocks checkout for this boutique rather than falling back.
      if (rated.length === 0) {
        out.push({ boutiqueId: g.boutiqueId, serviceable: false });
        continue;
      }

      const cheapest = rated[0];
      const baseCostPaise = Math.round((cheapest.rate as number) * 100);

      // Free when the boutique's own goods clear its threshold (0 = never free).
      const threshold = Number(shop?.free_delivery_over) || 0;
      const free = threshold > 0 && g.goods >= threshold;
      const buyerRupees = free ? 0 : (cheapest.rate as number) * (1 + markupPct / 100) + markupFlat;
      const shipPaise = free ? 0 : Math.round(buyerRupees * 100);

      const payload = {
        b: g.boutiqueId,
        p: dest,
        i: itemStr,
        s: shipPaise, // what the buyer pays (paise)
        c: baseCostPaise, // platform's courier cost, pre-buffer (paise)
        cid: cheapest.id,
        cn: cheapest.name,
        e: exp,
      };
      const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
      const token = `${payloadB64}.${await sign(payloadB64, secret)}`;

      out.push({
        boutiqueId: g.boutiqueId,
        serviceable: true,
        shipPaise,
        baseCostPaise,
        free,
        courierId: cheapest.id,
        courierName: cheapest.name,
        weightKg,
        token,
      });
    }

    return json({ ok: true, dest, expiresAt: exp, boutiques: out });
  } catch (e) {
    // A credential/outage fault degrades the WHOLE call: every boutique falls back
    // to its flat rate. Never a hard failure that would block checkout.
    const msg = e instanceof SrError ? e.message : (e as Error).message;
    console.error('delivery-quote failed (degraded)', msg);
    return json({ ok: true, degraded: true, reason: 'SHIPROCKET_UNAVAILABLE', boutiques: [] });
  }
});

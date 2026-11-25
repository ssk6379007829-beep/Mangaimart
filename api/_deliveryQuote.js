import crypto from 'node:crypto';

/**
 * Verify the signed delivery quotes minted by the `delivery-quote` Edge Function.
 *
 * The Edge Function priced each boutique's parcel from Shiprocket's live rate and
 * HMAC-signed the paise, bound to the boutique, the destination pincode and the
 * exact item set. A live quote is NOT reproducible to the paise, so create-order.js
 * and place-order.js cannot re-derive it — they trust this signature instead. The
 * secret (DELIVERY_QUOTE_SECRET) is the same one the Edge Function holds and must be
 * set on BOTH the Supabase project and Vercel.
 *
 * Security properties, all enforced below:
 *   • signature — a token the server cannot re-sign is ignored (no amount trusted);
 *   • freshness — an expired token (30-min TTL) is ignored, so a stale cheap quote
 *     cannot be replayed weeks later;
 *   • pincode binding — the token's destination must equal the address being
 *     shipped to, so a quote to the next street cannot pay for a parcel across India;
 *   • item binding — the token's item string must equal the boutique's actual lines
 *     as the SERVER grouped them, so a light-parcel quote cannot ship a heavy bag.
 *
 * Anything that fails is simply dropped: that boutique has no override and the
 * caller falls back to the seller's flat zone rate — the status quo before live
 * pricing. Tampering therefore reverts to the old price, it never lowers it.
 */

/** URL-safe base64 of a Buffer, no padding — matches b64url() in the Edge Function. */
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Canonical item string for a boutique's lines — MUST match itemString() in the
 *  Edge Function: sorted by product_id, each `id:qty`, joined by '|', qty floored
 *  and floored-at-1 exactly as create-order/place-order normalise it. */
export function itemString(lines) {
  return (lines ?? [])
    .map((l) => ({ id: l.product_id, qty: Math.max(1, Math.floor(Number(l.qty) || 1)) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((l) => `${l.id}:${l.qty}`)
    .join('|');
}

function verifyOne(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const dot = token.indexOf('.');
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!payloadB64 || !sig) return null;

  const expected = b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
  // Constant-time compare; mismatched lengths can't be timing-safe-compared, so
  // they're rejected outright.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const json = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Build the per-boutique delivery override from a request's signed quotes.
 *
 * @param tokens     the `deliveryQuotes` array sent by the browser (strings).
 * @param groupLines { boutiqueId: [{ product_id, qty }] } — the lines AS THE SERVER
 *                   grouped them (authoritative), used for the item binding check.
 * @param pincode    the delivery pincode the order is actually shipping to.
 * @param secret     DELIVERY_QUOTE_SECRET.
 * @returns { [boutiqueId]: { shipRupees, baseCostRupees, courierId, courierName } }
 *          for every boutique whose token passed every check. Boutiques absent from
 *          the map have no live quote and must be priced by the flat-rate fallback.
 */
export function verifyDeliveryQuotes(tokens, groupLines, pincode, secret) {
  const overrides = {};
  if (!secret || !Array.isArray(tokens) || tokens.length === 0) return overrides;
  const dest = String(pincode ?? '').replace(/\D/g, '');
  if (dest.length !== 6) return overrides; // no address → cannot bind → flat rate
  const nowSec = Math.floor(Date.now() / 1000);

  for (const token of tokens) {
    const p = verifyOne(token, secret);
    if (!p) continue;
    if (!p.b || typeof p.s !== 'number' || !Number.isFinite(p.s) || p.s < 0) continue;
    if (!Number.isFinite(Number(p.e)) || Number(p.e) <= nowSec) continue; // expired
    if (String(p.p) !== dest) continue; // shipping somewhere other than quoted
    const lines = groupLines[p.b];
    if (!lines || itemString(lines) !== p.i) continue; // items changed since quote

    overrides[p.b] = {
      shipRupees: p.s / 100,
      baseCostRupees: Number.isFinite(Number(p.c)) ? Number(p.c) / 100 : null,
      courierId: p.cid != null ? String(p.cid) : null,
      courierName: p.cn != null ? String(p.cn) : null,
    };
  }
  return overrides;
}

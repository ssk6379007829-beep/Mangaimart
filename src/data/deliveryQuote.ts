import { supabase } from '@/lib/supabase';

/**
 * Live delivery quotes for the bag, from the `delivery-quote` Edge Function
 * (migration 0120).
 *
 * For each boutique in the cart the function returns the cheapest live Shiprocket
 * rate (plus the platform buffer, or free when the boutique's threshold is met),
 * SIGNED so api/create-order.js and api/place-order.js can bind the payment to it
 * without re-quoting. The browser treats the number as display-only and the token
 * as opaque — every figure is re-verified server-side before a rupee moves.
 *
 * Degrades softly: a boutique the function could not price (Shiprocket down, no
 * pickup pincode) comes back `degraded`, and the caller prices it from the flat
 * zone rate it already computes. `serviceable:false` is different — no courier
 * serves that lane at all, so that boutique cannot be delivered to this address.
 */

export type BoutiqueQuote = {
  boutiqueId: string;
  /** What the buyer pays for this boutique's delivery, in rupees (0 when free). */
  shipRupees: number;
  free: boolean;
  courierName: string | null;
  /** Opaque signed token passed back to create-order / place-order. */
  token: string;
};

export type DeliveryQuotes = {
  /** Live, signed quotes, keyed by boutique id. */
  quotes: Record<string, BoutiqueQuote>;
  /** Boutiques the function could not price live — use the flat zone rate. */
  degraded: Set<string>;
  /** Boutiques no courier serves to this address — checkout is blocked. */
  unserviceable: Set<string>;
};

const EMPTY: DeliveryQuotes = { quotes: {}, degraded: new Set(), unserviceable: new Set() };

export async function fetchDeliveryQuotes(
  items: { product_id: string; qty: number }[],
  destPincode: string,
): Promise<DeliveryQuotes> {
  const dest = (destPincode ?? '').replace(/\D/g, '');
  if (dest.length !== 6 || items.length === 0) return EMPTY;
  try {
    const { data, error } = await supabase.functions.invoke('delivery-quote', {
      body: { destPincode: dest, items: items.map((i) => ({ product_id: i.product_id, qty: i.qty })) },
    });
    // A whole-call degrade (no secret, Shiprocket auth down) returns ok with an
    // empty list: nothing live, everything falls back to the flat rate.
    if (error || !data?.ok || !Array.isArray(data.boutiques)) return EMPTY;

    const out: DeliveryQuotes = { quotes: {}, degraded: new Set(), unserviceable: new Set() };
    for (const b of data.boutiques as Record<string, unknown>[]) {
      const id = String(b.boutiqueId ?? '');
      if (!id) continue;
      if (b.degraded) { out.degraded.add(id); continue; }
      if (b.serviceable === false) { out.unserviceable.add(id); continue; }
      if (typeof b.token !== 'string' || !Number.isFinite(Number(b.shipPaise))) { out.degraded.add(id); continue; }
      out.quotes[id] = {
        boutiqueId: id,
        shipRupees: Number(b.shipPaise) / 100,
        free: Boolean(b.free),
        courierName: b.courierName != null ? String(b.courierName) : null,
        token: b.token,
      };
    }
    return out;
  } catch {
    // Network blip — price everything at the flat rate; the sale is never blocked.
    return EMPTY;
  }
}

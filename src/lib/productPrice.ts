/**
 * The platform markup on product prices (migration 0127), baked into every
 * buyer-facing price.
 *
 * `buyerUnitPrice` is what a buyer sees and pays for one unit; the seller's
 * listed `base` is what their payout and the commission are computed from, so
 * the markup is pure platform margin and the seller is unaffected — the same way
 * the platform keeps the delivery fee.
 *
 * This is the client half; `api/_pricing.js` re-derives the identical number
 * server-side (and `api/place-order.js` asserts the payment against it), so the
 * two MUST stay in step — change both together, exactly like src/lib/pricing.ts.
 */

export type ProductMarkup = { product_markup_pct: number; product_markup_flat: number };

/** What the buyer pays for one unit, with the markup baked in. Never below the
 *  seller's own price, and a plain passthrough when no markup is configured. */
export function buyerUnitPrice(base: number, m: ProductMarkup | null | undefined): number {
  if (!m || base <= 0) return base;
  const pct = m.product_markup_pct || 0;
  const flat = m.product_markup_flat || 0;
  if (pct <= 0 && flat <= 0) return base;
  return Math.round(base * (1 + pct / 100) + flat);
}

/** The platform's margin on one unit — buyer price minus the seller's price. */
export function unitMarkup(base: number, m: ProductMarkup | null | undefined): number {
  return Math.max(0, buyerUnitPrice(base, m) - base);
}

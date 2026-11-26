import { useEffect, useState } from 'react';
import { css } from '@/lib/css';
import { fmt } from '@/data/demo';
import { useShop } from '@/state/ShopContext';
import { PINCODE_RE } from '@/lib/pincode';
import { rateForZone, resolveZone, zoneEarnsFreeDelivery, zoneLabel, type ShopPlace, type ZoneRates } from '@/lib/deliveryZone';
import { fetchDeliveryQuotes, type BoutiqueQuote } from '@/data/deliveryQuote';

/**
 * "Deliver to ______" — what this shop charges to send a parcel to you.
 *
 * Delivery is priced by distance since migration 0077, so there is no single
 * number a product page can print: the same piece is ₹30 to the next street and
 * ₹150 to another state. The options were to show the cheapest ("from ₹30",
 * which becomes a larger number at the payment screen — the moment carts are
 * abandoned), the dearest (which makes every nearby buyer overestimate), or to
 * ask. Asking is what every Indian marketplace does, so buyers already expect
 * the box, and it is the only one of the three that is never wrong.
 *
 * The answer is kept for the session and across visits (`deliveryPincode` in
 * ShopContext), so it is asked once and the cart, checkout and payment screens
 * all price from it. The checkout address overrides it once entered — that is
 * the address the parcel actually goes to.
 */

export function DeliveryCheck({
  rates, place, freeDeliveryOver, boutiqueName, productId, boutiqueId,
}: {
  rates: ZoneRates;
  /** The shop's own address — what the buyer's is measured against. */
  place: ShopPlace;
  freeDeliveryOver: number;
  boutiqueName?: string;
  /** This product + its boutique, so the box can quote the real courier rate
   *  (migration 0120) rather than the seller's flat estimate. Omit to keep the
   *  flat-rate behaviour. */
  productId?: string;
  boutiqueId?: string;
}) {
  const { deliveryPincode, setDeliveryPincode, buyerPlace } = useShop();
  const [typed, setTyped] = useState(deliveryPincode);

  // Follow the shared value when another screen changes it (the checkout
  // address, or this same box on a different product).
  useEffect(() => { setTyped(deliveryPincode); }, [deliveryPincode]);

  const complete = PINCODE_RE.test(typed);
  const showing = complete && buyerPlace?.pincode === typed ? buyerPlace : null;
  // Typed six digits but no resolved place yet: either still loading, or a
  // pincode India Post does not know. Both read as "checking" for a moment.
  const checking = complete && !showing;

  const zone = showing ? resolveZone(place, showing) : null;
  const flatRate = zone ? rateForZone(rates, zone) : null;
  const freeHere = zone != null && freeDeliveryOver > 0 && zoneEarnsFreeDelivery(zone);

  // The live courier quote for this one piece (migration 0120). Fetched whenever a
  // delivery pincode is resolved; while it is loading, and if it degrades or is not
  // enabled, the flat zone rate above is shown instead — exactly what the cart does.
  const liveMode = !!productId && !!boutiqueId;
  const [live, setLive] = useState<BoutiqueQuote | null>(null);
  const [liveUnserviceable, setLiveUnserviceable] = useState(false);
  const [quoting, setQuoting] = useState(false);

  useEffect(() => {
    if (!showing || !liveMode) { setLive(null); setLiveUnserviceable(false); setQuoting(false); return; }
    let active = true;
    setQuoting(true);
    void fetchDeliveryQuotes([{ product_id: productId!, qty: 1 }], showing.pincode)
      .then((q) => {
        if (!active) return;
        setLive(q.quotes[boutiqueId!] ?? null);
        setLiveUnserviceable(q.unserviceable.has(boutiqueId!));
      })
      .catch(() => { if (active) { setLive(null); setLiveUnserviceable(false); } })
      .finally(() => { if (active) setQuoting(false); });
    return () => { active = false; };
  }, [showing, liveMode, productId, boutiqueId]);

  // What to actually show, preferring the live quote. `rate` is null when the
  // parcel cannot be delivered at all (no flat rate for the zone AND no live
  // courier), which is the one case that reads as a refusal below.
  const usingLive = live != null;
  const rate = usingLive ? live!.shipRupees : flatRate;
  // Still fetching the live rate for a resolved pincode: show "checking" rather
  // than flashing the flat estimate and then re-pricing under the buyer.
  const liveChecking = liveMode && !!showing && quoting && !usingLive && !liveUnserviceable;
  const undeliverable = liveUnserviceable || (!usingLive && showing != null && flatRate == null && !liveChecking);

  const line = 'font-size:12.5px;font-weight:700;margin-top:8px;line-height:1.55;';

  return (
    <div style={css('margin-top:14px;padding:14px;border:1px solid var(--ag-surface-3);border-radius:16px;background:var(--ag-surface);')}>
      <label style={css('display:block;font-size:12px;font-weight:800;color:var(--ag-label);letter-spacing:.02em;')}>
        Deliver to
      </label>
      {/* No button: the pincode field stays editable, so changing it is just a
          tap-and-retype. It auto-checks the moment six digits are entered. */}
      <div style={css('margin-top:7px;')}>
        <input
          value={typed}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 6);
            setTyped(v);
            // Commit as soon as it is a whole pincode; no button to hunt for,
            // and a half-typed one never re-prices the page.
            if (PINCODE_RE.test(v)) setDeliveryPincode(v);
          }}
          placeholder="6-digit pincode"
          inputMode="numeric"
          autoComplete="postal-code"
          aria-label="Delivery pincode"
          style={css('display:block;width:100%;min-width:0;border:1.5px solid var(--ag-border);background:var(--ag-surface-2);border-radius:12px;padding:0 13px;height:44px;font-size:14px;font-weight:700;letter-spacing:.06em;color:var(--ag-ink);box-sizing:border-box;font-family:inherit;')}
        />
      </div>

      {!typed && (
        <div style={css(line + 'color:var(--ag-muted);font-weight:600;')}>
          Enter your pincode to see the exact delivery charge.
        </div>
      )}
      {(checking || liveChecking) && (
        <div style={css(line + 'color:var(--ag-muted);display:flex;align-items:center;gap:8px;')}>
          <span
            aria-hidden="true"
            className="agx-search-spin"
            style={css('width:13px;height:13px;flex:none;border-radius:50%;border:2px solid var(--ag-border);border-top-color:var(--ag-crimson);')}
          />
          <span>Finding delivery options for {typed}…</span>
        </div>
      )}

      {showing && undeliverable && (
        <div style={css(line + 'color:var(--ag-danger-text);')}>
          {boutiqueName ?? 'This boutique'} does not deliver to {showing.district || showing.pincode}.
        </div>
      )}
      {showing && !undeliverable && !liveChecking && rate != null && (
        <div style={css(line + 'color:var(--ag-good);')}>
          {rate === 0 ? 'Free delivery' : `Delivery ${fmt(rate)}`}
          <span style={css('color:var(--ag-muted);font-weight:600;')}>
            {' · '}{showing.district ? `${showing.district}, ${showing.state}` : showing.pincode}
            {/* The live quote names the courier; the flat estimate names the
                distance band it priced from. */}
            {usingLive
              ? (live!.courierName ? ` · via ${live!.courierName}` : '')
              : (zone ? ` · ${zoneLabel(zone, place).toLowerCase()}` : '')}
          </span>
          {freeDeliveryOver > 0 && rate > 0 && (usingLive || freeHere) && (
            <div style={css('color:var(--ag-muted);font-weight:600;font-size:11.5px;margin-top:3px;')}>
              Free on orders from this boutique over {fmt(freeDeliveryOver)}.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

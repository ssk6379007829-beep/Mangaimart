/**
 * "Mark shipped" — the form that replaced a one-tap status change.
 *
 * Tracking is mandatory to ship, and that rule lives in the database (migration
 * 0063's trg_orders_require_shipment), not here. This sheet exists so the seller
 * meets the rule comfortably rather than hitting it as an error; if it is ever
 * bypassed, the transition still fails.
 *
 * The tracking link is prefilled from the chosen courier's template and stays
 * editable. Most Indian courier tracking pages are form-POST with no addressable
 * URL, so many couriers have no template at all — the seller can paste the link
 * their courier gave them instead, and a parcel with no link still ships (the
 * buyer sees courier + AWB, which beats a dead URL).
 *
 * When Shiprocket is available for the shop (migration 0067) the sheet opens on
 * a booking mode instead: we create the parcel, a courier is assigned and the
 * AWB comes back, so the seller types nothing. Manual entry stays one tap away
 * and is the ONLY mode on a COD order — Shiprocket's COD remittance would pay
 * the platform rather than the seller, which is not the arrangement.
 */
import { useEffect, useMemo, useState } from 'react';
import { css } from '@/lib/css';
import { buildTrackingUrl, type Courier } from '@/data/shipments';

const OTHER = '__other__';

/** The pickup slots DTDC offers (two-hour windows). Shown to the seller so they
 *  choose when the courier collects, matching the "Schedule for Pickup" screen. */
const PICKUP_SLOTS: { start: string; end: string }[] = [
  { start: '12:00', end: '14:00' },
  { start: '14:00', end: '16:00' },
  { start: '16:00', end: '18:00' },
  { start: '18:00', end: '20:00' },
  { start: '20:00', end: '22:00' },
  { start: '22:00', end: '23:59' },
];
const todayISO = () => new Date().toISOString().slice(0, 10);

/** The shop's pickup address, confirmed (and editable) before every booking.
 *  Prefilled from the shop profile; an edit is saved back to it. */
export type PickupInfo = { phone: string; addressLine: string; city: string; state: string; pincode: string };

export type BookPayload = {
  /** The carrier to force, or undefined to let the server's fallback chain pick
   *  (honouring courierId as the preferred Shiprocket courier). */
  carrier?: string;
  /** Shiprocket courier_company_id — the auto-picked "cheapest fast" courier. */
  courierId?: string;
  date: string; slotStart: string; slotEnd: string;
  /** The pickup address the parcel is collected from, as confirmed in the sheet. */
  pickup: PickupInfo;
  /** Per-parcel weight (kg) and box (cm) when the seller overrode the product/
   *  shop defaults. Undefined = use the defaults server-side. */
  weightKg?: number;
  lengthCm?: number;
  breadthCm?: number;
  heightCm?: number;
};

/** One bookable courier in the picker. DTDC (our contracted account) has no
 *  live rate; each Shiprocket courier carries its live rate (the platform's
 *  cost) and ETA. */
export type CourierOption = {
  key: string;
  provider: 'dtdc' | 'shiprocket' | 'shadowfax';
  courierId?: string;
  label: string;
  rate: number | null;
  days: string | null;
};

export function ShipSheet({
  couriers,
  busy,
  canBook = false,
  courierOptions = [],
  pickup,
  notice,
  onCancel,
  onConfirm,
  onBook,
}: {
  couriers: Courier[];
  busy: boolean;
  /** A courier the shop can book on is switched on, and this order is prepaid. */
  canBook?: boolean;
  /** A heads-up shown in book mode — e.g. the pickup address needs fixing before
   *  Shiprocket couriers can appear. Never blocks booking by another carrier. */
  notice?: string | null;
  /** The couriers the seller may pick from, DTDC first then Shiprocket couriers
   *  cheapest-first. Empty falls back to the manual form. */
  courierOptions?: CourierOption[];
  /** The shop's saved pickup address, prefilled into the booking form. */
  pickup?: PickupInfo;
  onCancel: () => void;
  onConfirm: (v: { courierId: string | null; courierName: string; awb: string; trackingUrl: string | null }) => void;
  onBook?: (payload: BookPayload) => void;
}) {
  // Booking is the default when it is available: it is fewer taps, and the AWB
  // it produces is one a courier scan can drive, which is what eventually
  // settles the seller's payout without anyone self-attesting delivery.
  const [mode, setMode] = useState<'book' | 'manual'>(canBook ? 'book' : 'manual');
  const [courierKey, setCourierKey] = useState('');
  const [otherName, setOtherName] = useState('');
  const [awb, setAwb] = useState('');
  const [link, setLink] = useState('');
  // Once the seller edits the link themselves we stop overwriting it, or typing
  // the AWB would wipe what they pasted.
  const [linkTouched, setLinkTouched] = useState(false);
  // Fully automatic courier choice (2026-11-25): the seller no longer picks one.
  // "Cheapest among the fast" — from the live rates for this lane, take the
  // couriers within a day of the quickest ETA and pick the lowest-priced of
  // those, a balance of cheap AND quick. Falls back to DTDC (our contracted
  // account, which carries no live rate) or whatever single option exists when
  // nothing is priced to compare. Null only when no carrier is on offer, and
  // then the server's own fallback chain decides.
  const selected = useMemo<CourierOption | null>(() => {
    if (!courierOptions.length) return null;
    const priced = courierOptions.filter((c) => c.rate != null);
    if (!priced.length) return courierOptions[0];
    const etaOf = (c: CourierOption) => {
      const m = (c.days ?? '').match(/\d+/);
      return m ? Number(m[0]) : 99;
    };
    const minEta = Math.min(...priced.map(etaOf));
    const fastTier = priced.filter((c) => etaOf(c) <= minEta + 1);
    return fastTier.reduce((a, b) => ((b.rate ?? Infinity) < (a.rate ?? Infinity) ? b : a));
  }, [courierOptions]);
  const [pickupDate, setPickupDate] = useState(todayISO());
  const [slotIdx, setSlotIdx] = useState(0);
  // Only DTDC schedules a two-hour slot; Shiprocket (and the auto fallback) take
  // a date only, so the slot selector shows just for a DTDC pickup.
  const showSlot = selected?.provider === 'dtdc';
  // The pickup address the courier collects from — prefilled from the shop and
  // editable here (an edit is saved back to the shop profile). The shop phone
  // is often blank, which is why the label has printed 0000000000; collecting
  // it here fixes that at the point it matters.
  const [editPickup, setEditPickup] = useState(false);
  const [puPhone, setPuPhone] = useState('');
  const [puAddress, setPuAddress] = useState('');
  const [puCity, setPuCity] = useState('');
  const [puState, setPuState] = useState('');
  const [puPin, setPuPin] = useState('');
  useEffect(() => {
    setPuPhone(pickup?.phone ?? '');
    setPuAddress(pickup?.addressLine ?? '');
    setPuCity(pickup?.city ?? '');
    setPuState(pickup?.state ?? '');
    setPuPin(pickup?.pincode ?? '');
  }, [pickup]);
  const pin6 = puPin.replace(/\D/g, '').length === 6;
  const phone10 = puPhone.replace(/\D/g, '').length >= 10;
  const pickupReady = puAddress.trim().length > 0 && pin6 && phone10;

  const courier = useMemo(() => couriers.find((c) => c.id === courierKey), [couriers, courierKey]);
  const isOther = courierKey === OTHER;
  const autoLink = useMemo(() => buildTrackingUrl(courier?.tracking_url_template, awb), [courier, awb]);

  useEffect(() => {
    if (!linkTouched) setLink(autoLink ?? '');
  }, [autoLink, linkTouched]);

  const courierName = isOther ? otherName.trim() : (courier?.name ?? '');
  const ready = courierName.length > 0 && awb.trim().length > 0 && !busy;

  const field = 'width:100%;height:46px;border-radius:12px;border:1.5px solid var(--ag-border);background:var(--ag-bg);color:var(--ag-ink);padding:0 13px;font-size:14px;font-family:inherit;box-sizing:border-box;';
  const label = 'font-size:12px;font-weight:800;color:var(--ag-muted);letter-spacing:.05em;margin-bottom:6px;';

  return (
    <div
      style={css('position:fixed;inset:0;z-index:60;background:rgba(20,8,14,.45);display:flex;align-items:flex-end;justify-content:center;')}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={css('width:100%;max-width:520px;background:var(--ag-surface);border-radius:20px 20px 0 0;padding:18px 20px 22px;box-shadow:0 -12px 40px -18px rgba(107,20,54,.6);max-height:88vh;overflow-y:auto;')}
      >
        <div style={css("font-weight:700;font-size:20px;")}>Ship this order</div>
        <div style={css('font-size:12.5px;color:var(--ag-muted);margin-top:3px;line-height:1.5;')}>
          Schedule the pickup and we book the cheapest quick courier for you — or enter your own tracking number. Either way the customer gets a number to follow.
        </div>

        {canBook && (
          <div style={css('display:flex;gap:8px;margin-top:16px;')}>
            {([['book', 'Book a courier'], ['manual', 'I shipped it myself']] as const).map(([key, text]) => {
              const on = mode === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMode(key)}
                  style={css(`flex:1;height:42px;border-radius:12px;border:1.5px solid ${on ? '#D6336C' : 'var(--ag-border)'};background:${on ? 'var(--ag-surface-2)' : 'var(--ag-surface)'};color:${on ? 'var(--ag-crimson)' : 'var(--ag-ink-2)'};font-weight:800;font-size:13px;cursor:pointer;font-family:inherit;`)}
                >
                  {text}
                </button>
              );
            })}
          </div>
        )}

        {mode === 'book' ? (
          <>
            {notice && (
              <div style={css('margin-top:14px;display:flex;gap:9px;align-items:flex-start;background:var(--ag-warn-bg);border:1px solid var(--ag-warn-text);border-radius:13px;padding:11px 13px;')}>
                <span aria-hidden="true" style={css("font-family:'Material Symbols Outlined';font-size:18px;color:var(--ag-warn-text);flex:none;")}>info</span>
                <div style={css('font-size:12px;color:var(--ag-warn-text);font-weight:700;line-height:1.5;')}>
                  {notice} Update it in your shop profile to use Shiprocket — this order can still go by another courier below.
                </div>
              </div>
            )}
            {/* No picker — we auto-choose the cheapest quick courier for this
                pincode. One heads-up card so the seller sees who is coming and
                the cost (MangaiMart's, not theirs) before they confirm. */}
            <div style={css('margin-top:16px;border:1.5px solid var(--ag-border);border-radius:14px;padding:13px 14px;background:var(--ag-surface-2);')}>
              <div style={css('display:flex;align-items:center;gap:11px;')}>
                <span style={css('width:40px;height:40px;flex:none;border-radius:11px;background:var(--ag-surface);display:flex;align-items:center;justify-content:center;')}>
                  <span aria-hidden="true" style={css("font-family:'Material Symbols Outlined';color:var(--ag-crimson);")}>bolt</span>
                </span>
                <div style={css('flex:1;min-width:0;')}>
                  <div style={css('font-size:11px;font-weight:800;color:var(--ag-muted);letter-spacing:.05em;')}>COURIER · CHOSEN FOR YOU</div>
                  <div style={css('font-weight:800;font-size:14px;margin-top:2px;')}>{selected ? selected.label : 'Best available courier'}</div>
                  <div style={css('font-size:11.5px;color:var(--ag-muted);margin-top:2px;')}>
                    {!selected
                      ? 'The cheapest quick courier serving your buyer’s pincode'
                      : selected.provider === 'dtdc'
                        ? 'Contracted rate · pickup from your shop'
                        : [selected.days ? `~${selected.days} days` : 'Quick delivery', 'cheapest fast option'].join(' · ')}
                  </div>
                </div>
                {selected?.rate != null && (
                  <div style={css('flex:none;text-align:right;')}>
                    <span style={css('font-weight:800;font-size:15px;font-variant-numeric:tabular-nums;')}>₹{Math.round(selected.rate)}</span>
                  </div>
                )}
              </div>
              <div style={css('font-size:11px;color:var(--ag-muted);margin-top:8px;line-height:1.5;')}>
                We pick the cheapest quick courier automatically. The delivery cost is paid by MangaiMart, not deducted from you.
              </div>
            </div>

            <div style={css('display:flex;gap:10px;margin-top:12px;')}>
              <div style={css('flex:1;min-width:0;')}>
                <div style={css(label)}>PICKUP DATE</div>
                <input
                  type="date"
                  value={pickupDate}
                  min={todayISO()}
                  onChange={(e) => setPickupDate(e.target.value)}
                  style={css(field)}
                />
              </div>
              {/* The time slot is only honoured by DTDC. Shiprocket schedules a
                  date, so for a Shiprocket courier the slot is hidden and the
                  date fills the row rather than promising a window. */}
              {showSlot && (
                <div style={css('flex:1;min-width:0;')}>
                  <div style={css(label)}>TIME SLOT</div>
                  <select value={slotIdx} onChange={(e) => setSlotIdx(Number(e.target.value))} style={css(field)}>
                    {PICKUP_SLOTS.map((s, i) => <option key={i} value={i}>{s.start} – {s.end}</option>)}
                  </select>
                </div>
              )}
            </div>
            {!showSlot && (
              <div style={css('font-size:11px;color:var(--ag-muted);margin-top:6px;line-height:1.5;')}>
                This courier collects on the chosen date — it doesn’t offer a fixed time window.
              </div>
            )}

            {/* The pickup address the courier is sent to. Confirmed on every
                booking because a wrong or incomplete one is a failed pickup, not
                a wrong label — and the shop phone is often blank, which is why
                the label has printed 0000000000. Prefilled; edits save back to
                the shop profile. */}
            {pickup && (
              <div style={css('margin-top:14px;border:1px solid var(--ag-border);border-radius:14px;padding:13px 14px;')}>
                <div style={css('display:flex;align-items:flex-start;justify-content:space-between;gap:10px;')}>
                  <div style={css('flex:1;min-width:0;')}>
                    <div style={css('font-size:11.5px;font-weight:800;color:var(--ag-muted);letter-spacing:.05em;')}>PICKUP FROM</div>
                    <div style={css('font-size:13px;color:var(--ag-ink);line-height:1.5;margin-top:4px;')}>
                      {[puAddress, puCity, puState, puPin && `PIN ${puPin}`].filter(Boolean).join(', ') || 'No pickup address on file'}
                    </div>
                    <div style={css(`font-size:12.5px;margin-top:3px;font-variant-numeric:tabular-nums;color:${phone10 ? 'var(--ag-muted)' : 'var(--ag-danger-text)'};`)}>
                      {puPhone.trim() ? `Contact ${puPhone}` : 'No contact phone — add one so the courier can reach you'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditPickup((v) => !v)}
                    style={css('flex:none;height:34px;padding:0 12px;border-radius:10px;border:1.5px solid var(--ag-border);background:var(--ag-surface);color:var(--ag-crimson);font-weight:800;font-size:12.5px;cursor:pointer;font-family:inherit;')}
                  >
                    {editPickup ? 'Done' : 'Edit'}
                  </button>
                </div>

                {editPickup && (
                  <div style={css('margin-top:12px;')}>
                    <div style={css(label)}>CONTACT PHONE</div>
                    <input value={puPhone} onChange={(e) => setPuPhone(e.target.value)} inputMode="tel" placeholder="10-digit mobile" style={css(field)} />
                    <div style={css(label + 'margin-top:10px;')}>PICKUP ADDRESS</div>
                    <input value={puAddress} onChange={(e) => setPuAddress(e.target.value)} placeholder="Door no, street, area" style={css(field)} />
                    <div style={css('display:flex;gap:10px;margin-top:10px;')}>
                      <div style={css('flex:1;min-width:0;')}>
                        <div style={css(label)}>CITY / TOWN</div>
                        <input value={puCity} onChange={(e) => setPuCity(e.target.value)} style={css(field)} />
                      </div>
                      <div style={css('flex:1;min-width:0;')}>
                        <div style={css(label)}>STATE</div>
                        <input value={puState} onChange={(e) => setPuState(e.target.value)} style={css(field)} />
                      </div>
                    </div>
                    <div style={css(label + 'margin-top:10px;')}>PINCODE</div>
                    <input value={puPin} onChange={(e) => setPuPin(e.target.value)} inputMode="numeric" placeholder="6-digit" style={css(field + 'font-variant-numeric:tabular-nums;')} />
                    <div style={css('font-size:12px;color:var(--ag-muted);margin-top:7px;line-height:1.5;')}>
                      Saved to your shop so you only set it once. The courier collects from here.
                    </div>
                  </div>
                )}
              </div>
            )}

            <div style={css('margin-top:14px;background:var(--ag-surface-2);border:1px solid var(--ag-border);border-radius:14px;padding:13px 14px;')}>
              <div style={css('font-size:12.5px;color:var(--ag-muted);line-height:1.55;')}>
                The courier collects from the pickup address above on the chosen date, the tracking number comes back
                straight away, and the label is saved for you to print. Parcel weight is taken from your products — set
                it on each item so the declared weight matches what the courier weighs.
              </div>
            </div>

            <div style={css('display:flex;gap:10px;margin-top:18px;')}>
              <button
                onClick={onCancel}
                style={css('flex:1;height:50px;border:1.5px solid var(--ag-border);background:var(--ag-surface);color:var(--ag-label);border-radius:13px;font-weight:800;cursor:pointer;font-family:inherit;')}
              >
                Cancel
              </button>
              {(() => {
                const blocked = busy || (!!pickup && !pickupReady);
                // A DTDC pick is forced; anything else (a Shiprocket courier, or
                // nothing resolved) goes to the server's fallback chain with the
                // auto-picked Shiprocket courier as its preference, so a courier
                // that cannot take it falls back instead of stranding the order.
                const isDtdc = selected?.provider === 'dtdc';
                return (
                  <button
                    disabled={blocked}
                    onClick={() => onBook?.({
                      carrier: isDtdc ? 'dtdc' : undefined,
                      courierId: selected?.provider === 'shiprocket' ? selected.courierId : undefined,
                      date: pickupDate,
                      slotStart: PICKUP_SLOTS[slotIdx].start, slotEnd: PICKUP_SLOTS[slotIdx].end,
                      pickup: { phone: puPhone.trim(), addressLine: puAddress.trim(), city: puCity.trim(), state: puState.trim(), pincode: puPin.trim() },
                    })}
                    style={css(`flex:1.4;height:50px;border:none;border-radius:13px;background:${blocked ? 'var(--ag-surface-2)' : 'linear-gradient(135deg,#D6336C,#B02454)'};color:${blocked ? 'var(--ag-muted)' : '#fff'};font-weight:800;cursor:${blocked ? 'default' : 'pointer'};font-family:inherit;`)}
                  >
                    {busy ? 'Booking…' : (!!pickup && !pickupReady) ? 'Add pickup phone & pincode' : 'Schedule & ship'}
                  </button>
                );
              })()}
            </div>
          </>
        ) : (
        <>
        <div style={css('margin-top:16px;')}>
          <div style={css(label)}>COURIER</div>
          <select
            value={courierKey}
            onChange={(e) => { setCourierKey(e.target.value); setLinkTouched(false); }}
            style={css(field)}
          >
            <option value="">Select a courier…</option>
            {couriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value={OTHER}>Other courier…</option>
          </select>
        </div>

        {isOther && (
          <div style={css('margin-top:12px;')}>
            <div style={css(label)}>COURIER NAME</div>
            <input
              value={otherName}
              onChange={(e) => setOtherName(e.target.value)}
              placeholder="e.g. Sri Balaji Couriers"
              style={css(field)}
            />
          </div>
        )}

        <div style={css('margin-top:12px;')}>
          <div style={css(label)}>TRACKING / DOCKET NUMBER</div>
          <input
            value={awb}
            onChange={(e) => setAwb(e.target.value)}
            placeholder="e.g. 1234567890123"
            autoCapitalize="characters"
            style={css(field)}
          />
        </div>

        <div style={css('margin-top:12px;')}>
          <div style={css(label)}>TRACKING LINK · OPTIONAL</div>
          <input
            value={link}
            onChange={(e) => { setLink(e.target.value); setLinkTouched(true); }}
            placeholder="Paste the link your courier gave you"
            style={css(field)}
          />
          <div style={css('font-size:12px;color:var(--ag-muted);margin-top:6px;line-height:1.5;')}>
            {autoLink && !linkTouched
              ? 'Filled in from the courier’s tracking page — edit it if it doesn’t open.'
              : 'Leave blank if your courier has no tracking page. The customer still sees the courier and docket number.'}
          </div>
        </div>

        <div style={css('display:flex;gap:10px;margin-top:20px;')}>
          <button
            onClick={onCancel}
            style={css('flex:1;height:50px;border:1.5px solid var(--ag-border);background:var(--ag-surface);color:var(--ag-label);border-radius:13px;font-weight:800;cursor:pointer;font-family:inherit;')}
          >
            Cancel
          </button>
          <button
            disabled={!ready}
            onClick={() => onConfirm({
              courierId: isOther ? null : (courier?.id ?? null),
              courierName,
              awb: awb.trim(),
              trackingUrl: link.trim() || null,
            })}
            style={css(`flex:1.4;height:50px;border:none;border-radius:13px;background:${ready ? 'linear-gradient(135deg,#D6336C,#B02454)' : 'var(--ag-surface-2)'};color:${ready ? '#fff' : 'var(--ag-muted)'};font-weight:800;cursor:${ready ? 'pointer' : 'default'};font-family:inherit;`)}
          >
            {busy ? 'Shipping…' : 'Ship order'}
          </button>
        </div>
        </>
        )}
      </div>
    </div>
  );
}

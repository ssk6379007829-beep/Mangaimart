/**
 * What Shiprocket will accept as a pickup address — the client-side half.
 *
 * Shiprocket's "add pickup" validator rejects an address line 1 that is under
 * 10 characters or has no recognisable door/house/road number, and that
 * rejection used to surface as a raw JSON blob days after onboarding. This is a
 * cheap pre-check so the seller is told BEFORE they rely on it, in words they
 * can act on. It cannot perfectly predict Shiprocket's parser — a "2," door
 * number passes this yet Shiprocket still wants "No.2" or "2/1" — so the server
 * surfaces Shiprocket's own verdict too (see EXPECTED_PICKUP_ADDRESS). This only
 * catches the obvious misses up front; it never blocks a sale, since booking
 * falls back to DTDC / a manual docket when Shiprocket declines.
 */

/** The one message shown wherever a pickup address won't do, client or server,
 *  so the seller reads the same guidance everywhere. */
export const EXPECTED_PICKUP_ADDRESS =
  'Shiprocket needs your pickup address to start with a clear door/house number and be at least 10 characters — for example “No.12, Gandhi Street, Mettupalayam”.';

/**
 * A problem with this address for Shiprocket, or null when it looks usable.
 * Deliberately lenient: it flags only what is certainly wrong (too short, or no
 * number at all), because a false "this is fine" is recoverable (the server
 * still checks) while a false "this is wrong" would nag a seller whose address
 * is actually acceptable.
 */
export function pickupAddressIssue(addressLine: string | null | undefined): string | null {
  const a = (addressLine ?? '').trim();
  if (a.length < 10) return EXPECTED_PICKUP_ADDRESS;
  if (!/\d/.test(a)) return EXPECTED_PICKUP_ADDRESS;
  return null;
}

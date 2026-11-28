/**
 * Keeps buyer↔seller chat on the platform: blocks a message that shares a phone
 * number, UPI id, payment-app handle, email or external link, so neither side
 * can arrange an off-platform deal.
 *
 * Mirrored by the `block_contact_sharing()` trigger (migration 0126) — the app
 * check here is the instant, friendly one; the trigger is the backstop that a
 * direct API call cannot bypass. Keep the two patterns in step.
 *
 * ── Why phone detection is deliberately narrow ───────────────────────────────
 * This is a clothing marketplace: "available in 36 38 40 42 44 46" is normal,
 * and a naïve "ten digits with any separators" rule would read that size list as
 * a phone number and block it. So a phone is only matched as ten CONTIGUOUS
 * digits, or in the two groupings people actually write a number in (5+5,
 * 3-3-4). Space-separated two-digit size groups match none of these.
 */

export type ContactViolation = 'phone' | 'contact' | 'payment' | 'link';

/** Ten digits contiguous, or written 5+5 / 3-3-4, optionally +91-prefixed. */
const PHONE = /(?<!\d)(?:\+?91[-.\s]?)?(?:[6-9]\d{9}|[6-9]\d{4}[-.\s]\d{5}|[6-9]\d{2}[-.\s]\d{3}[-.\s]\d{4})(?!\d)/;
/** Anything of the form handle@bank or name@domain — UPI ids and emails alike. */
const CONTACT = /[a-z0-9._%+-]{2,}@[a-z0-9.-]{2,}/i;
/** Payment apps and the UPI word. */
const PAYMENT = /\b(?:g[\s-]?pay|google[\s-]?pay|phone[\s-]?pe|phonepe|paytm|bhim|upi)\b/i;
/** Outside contact channels and links. */
const LINK = /\b(?:whatsapp|wa\.me|t\.me|telegram|instagram)\b|https?:\/\/|www\./i;

/** App-generated product/order cards are never user text — leave them alone. */
const isCard = (body: string) => body.startsWith('@@PRODUCT@@') || body.startsWith('@@ORDER@@');

/** The first kind of blocked content found, or null if the message is clean. */
export function findContactViolation(body: string): ContactViolation | null {
  if (isCard(body)) return null;
  if (PHONE.test(body)) return 'phone';
  if (CONTACT.test(body)) return 'contact';
  if (PAYMENT.test(body)) return 'payment';
  if (LINK.test(body)) return 'link';
  return null;
}

/** The message shown to whoever tried to send it. */
export function contactGuardMessage(kind: ContactViolation): string {
  const what =
    kind === 'phone' ? 'a phone number'
      : kind === 'contact' ? 'contact or UPI details'
        : kind === 'payment' ? 'payment-app details'
          : 'an outside link';
  return `For your safety, you can’t share ${what} in chat. Keep your order on MangaiMart — payment and delivery are covered here.`;
}

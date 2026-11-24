/** Normalizes a buyer-entered phone number to WhatsApp's `wa.me` format
 *  (country code + number, digits only). Assumes India (+91) when a bare
 *  10-digit number is given, since the app only operates in India today. */
export function normalizeIndianPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return '91' + digits.slice(1);
  return digits;
}

/** Direct-to-contact WhatsApp deep link — opens a chat with `phone` prefilled with `message`. */
export function buildWhatsAppLink(phone: string, message: string): string {
  return `https://wa.me/${normalizeIndianPhone(phone)}?text=${encodeURIComponent(message)}`;
}

export type BillItem = { title: string; qty: number; price: number };

/** The WhatsApp message the walk-in buyer receives with their bill.
 *
 *  A friendly thank-you, then the one thing they came for — a direct link to
 *  download the bill as a PDF (`billUrl`, a 30-day signed URL) — then a nudge
 *  back to the boutique's shareable MangaiMart page so the bill doubles as
 *  promotion. The itemised breakdown lives inside the PDF itself (see
 *  BillReceipt), so this text does not restate it.
 *
 *  `billUrl` is optional only so the caller can still build a message if the
 *  upload failed; in the normal path it is always present. */
export function buildBillShareCaption(opts: {
  boutiqueName: string;
  boutiqueSlug?: string | null;
  buyerName?: string;
  billNumber: string;
  total: number;
  billUrl?: string | null;
}): string {
  const { boutiqueName, boutiqueSlug, buyerName, billNumber, total, billUrl } = opts;
  const lines: string[] = [];
  lines.push(`Hi ${buyerName?.trim() || 'there'}, thank you for shopping with ${boutiqueName}! 🌸`);
  lines.push(`Here's your bill ${billNumber} — total ₹${total.toLocaleString('en-IN')}.`);
  if (billUrl) {
    lines.push('');
    lines.push('📄 Download your bill (PDF):');
    lines.push(billUrl);
    lines.push('(link works for 30 days)');
  }
  lines.push('');
  lines.push(`Loved what you got? Visit ${boutiqueName} again and explore more boutiques on MangaiMart:`);
  if (boutiqueSlug) {
    lines.push(`${window.location.origin}/b/${boutiqueSlug}`);
  } else {
    lines.push(window.location.origin);
  }
  return lines.join('\n');
}

/**
 * The offline-sale bill as a TRUE TEXT PDF — selectable, sharp at any zoom and a
 * few KB, not an html2canvas screenshot. It is laid out to match the online-order
 * Payment Receipt (api/_receipt.js): the MangaiMart wordmark top-left, the shop's
 * own logo in a tinted rounded box top-right, a title, a Bill No / Date block, a
 * Bill From / Bill To pair, an itemised table, a totals stack and a closing note.
 *
 * Amounts are printed "Rs. 2,499", not "₹2,499": the jsPDF core fonts (Helvetica)
 * have no rupee glyph, so ₹ would render as a blank box. The on-screen preview
 * (BillInvoice.tsx) keeps ₹ because the browser has the glyph.
 */

export type BillDocItem = { title: string; qty: number; price: number };

export type BillDocData = {
  boutiqueName: string;
  boutiqueAddressLines: string[];
  boutiquePhone?: string | null;
  /** The shop's own logo, drawn top-right like the online receipt. */
  boutiqueLogoUrl?: string | null;
  billNumber: string;
  date: string;
  buyerName: string;
  buyerPhone?: string;
  items: BillDocItem[];
  discount?: number;
  total: number;
  paymentMethod?: string | null;
};

/** Shop postal address as display lines, matching api/_receipt.js: the district
 *  is dropped when it only repeats the city, which for most of this catalogue it
 *  does. */
export function boutiqueAddressLines(b: {
  address_line?: string | null;
  city?: string | null;
  district?: string | null;
  state?: string | null;
  pincode?: string | null;
}): string[] {
  const norm = (s?: string | null) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const district = norm(b.district) === norm(b.city) ? null : b.district;
  const region = [district, b.state].filter(Boolean).join(', ');
  const lastLine = [region, b.pincode].filter(Boolean).join(' ');
  return [b.address_line, b.city, lastLine].map((s) => String(s ?? '').trim()).filter(Boolean);
}

const money = (n: number) => 'Rs. ' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

// Palette, as RGB triples — the light-theme literals the online receipt uses.
const INK: [number, number, number] = [36, 16, 25];
const MUTED: [number, number, number] = [119, 93, 102];
const FAINT: [number, number, number] = [154, 130, 140];
const RULE: [number, number, number] = [239, 220, 228];
const CRIMSON: [number, number, number] = [176, 36, 84];
const TITLE: [number, number, number] = [122, 24, 54];
const TINT: [number, number, number] = [253, 238, 244];
const GOOD: [number, number, number] = [29, 122, 77];

/** The MangaiMart wordmark, served from /public — same origin, so no CORS. */
const WORDMARK_URL = '/mangaimart-wordmark.png';

/** Loads an image and returns it as a PNG data URL plus its natural size, or
 *  null if it can't be loaded (a missing shop logo must never fail the bill).
 *  Going through a canvas lets a WebP shop logo become a PNG jsPDF can embed. */
async function loadImagePng(url: string, crossOrigin = false): Promise<{ dataUrl: string; w: number; h: number } | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      if (crossOrigin) img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx || !img.naturalWidth) return resolve(null);
          ctx.drawImage(img, 0, 0);
          resolve({ dataUrl: canvas.toDataURL('image/png'), w: img.naturalWidth, h: img.naturalHeight });
        } catch {
          resolve(null); // tainted canvas (CORS) — skip the image, keep the bill
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    } catch {
      resolve(null);
    }
  });
}

/** Builds the jsPDF document. Dynamically imports jspdf so it never ships in the
 *  buyer bundle. */
async function buildDoc(data: BillDocData) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const M = 48;
  const LEFT = M;
  const RIGHT = PAGE_W - M;
  const BOTTOM = PAGE_H - 56;

  const TOTAL_X = RIGHT;
  const QTY_X = RIGHT - 78;
  const PRICE_X = RIGHT - 150;
  const ITEM_W = PRICE_X - LEFT - 14;

  const setText = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2]);
  const setDraw = (c: [number, number, number]) => doc.setDrawColor(c[0], c[1], c[2]);
  const setFill = (c: [number, number, number]) => doc.setFillColor(c[0], c[1], c[2]);

  const subtotal = data.items.reduce((s, it) => s + it.price * it.qty, 0);
  const discount = data.discount ?? 0;

  // Both logos up front; either can be null and the bill still renders.
  const [wordmark, shopLogo] = await Promise.all([
    loadImagePng(WORDMARK_URL),
    data.boutiqueLogoUrl ? loadImagePng(data.boutiqueLogoUrl, true) : Promise.resolve(null),
  ]);

  // ── Masthead: MangaiMart wordmark left, shop logo right ──────────────────────
  if (wordmark) {
    const h = 22;
    doc.addImage(wordmark.dataUrl, 'PNG', LEFT, 42, (wordmark.w / wordmark.h) * h, h);
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    setText(CRIMSON);
    doc.text('MangaiMart', LEFT, 60);
  }

  const BOX = 50;
  const boxX = RIGHT - BOX;
  const boxY = 34;
  setFill(TINT);
  setDraw(RULE);
  doc.roundedRect(boxX, boxY, BOX, BOX, 10, 10, 'FD');
  if (shopLogo) {
    const pad = 6;
    doc.addImage(shopLogo.dataUrl, 'PNG', boxX + pad, boxY + pad, BOX - pad * 2, BOX - pad * 2);
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    setText(CRIMSON);
    doc.text((data.boutiqueName || 'A').charAt(0).toUpperCase(), boxX + BOX / 2, boxY + BOX / 2 + 7, { align: 'center' });
  }

  // ── Title ────────────────────────────────────────────────────────────────────
  let y = 112;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(27);
  setText(TITLE);
  doc.text('Bill', LEFT, y);

  // ── Meta: Bill No / Date (label + bold value, stacked) ───────────────────────
  y += 26;
  const metaRow = (name: string, value: string) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    setText(FAINT);
    doc.text(name, LEFT, y);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    setText(INK);
    doc.text(value, LEFT + 92, y);
    y += 16;
  };
  metaRow('Bill No', data.billNumber);
  metaRow('Date', data.date);
  if (data.paymentMethod) metaRow('Payment', data.paymentMethod);

  // ── Bill From / Bill To ──────────────────────────────────────────────────────
  y += 18;
  const colRightX = LEFT + 270;
  const label = (text: string, x: number, yy: number) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    setText(FAINT);
    doc.text(text.toUpperCase(), x, yy);
  };
  const detail = (text: string, x: number, yy: number, strong = false) => {
    doc.setFont('helvetica', strong ? 'bold' : 'normal');
    doc.setFontSize(strong ? 12 : 10.5);
    setText(strong ? INK : MUTED);
    doc.text(text, x, yy);
  };

  label('Bill From', LEFT, y);
  label('Bill To', colRightX, y);

  let yFrom = y + 17;
  detail(data.boutiqueName || 'Boutique', LEFT, yFrom, true);
  yFrom += 15;
  for (const line of data.boutiqueAddressLines) {
    detail(line, LEFT, yFrom);
    yFrom += 14;
  }
  if (data.boutiquePhone) {
    detail(String(data.boutiquePhone), LEFT, yFrom);
    yFrom += 14;
  }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  setText(FAINT);
  doc.text(`Sold by ${data.boutiqueName || 'the boutique'} on MangaiMart.`, LEFT, yFrom + 3);
  yFrom += 17;

  let yTo = y + 17;
  detail(data.buyerName || 'Customer', colRightX, yTo, true);
  yTo += 15;
  if (data.buyerPhone) {
    detail(String(data.buyerPhone), colRightX, yTo);
    yTo += 14;
  }

  y = Math.max(yFrom, yTo) + 20;

  // ── Items table ──────────────────────────────────────────────────────────────
  const drawTableHead = () => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    setText(FAINT);
    doc.text('ITEM DESCRIPTION', LEFT, y);
    doc.text('PRICE', PRICE_X, y, { align: 'right' });
    doc.text('QTY', QTY_X, y, { align: 'right' });
    doc.text('TOTAL', TOTAL_X, y, { align: 'right' });
    y += 9;
    setDraw(RULE);
    doc.setLineWidth(1);
    doc.line(LEFT, y, RIGHT, y);
    y += 15;
  };
  drawTableHead();

  for (const it of data.items) {
    const titleLines: string[] = doc.splitTextToSize(it.title || 'Item', ITEM_W);
    const rowH = Math.max(titleLines.length * 13, 16) + 10;
    if (y + rowH > BOTTOM) {
      doc.addPage();
      y = 56;
      drawTableHead();
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    setText(INK);
    doc.text(titleLines, LEFT, y);
    doc.setFont('helvetica', 'normal');
    setText(MUTED);
    doc.text(money(it.price), PRICE_X, y, { align: 'right' });
    doc.text(String(it.qty), QTY_X, y, { align: 'right' });
    doc.setFont('helvetica', 'bold');
    setText(INK);
    doc.text(money(it.price * it.qty), TOTAL_X, y, { align: 'right' });
    y += rowH - 6;
    setDraw(RULE);
    doc.line(LEFT, y, RIGHT, y);
    y += 15;
  }

  // ── Totals ───────────────────────────────────────────────────────────────────
  const totalRow = (name: string, value: string, emphasis = false, colour: [number, number, number] = MUTED) => {
    if (y + 22 > BOTTOM) {
      doc.addPage();
      y = 56;
    }
    if (emphasis) {
      y += 4;
      setDraw(RULE);
      doc.line(PRICE_X - 40, y, RIGHT, y);
      y += 17;
    }
    doc.setFont('helvetica', emphasis ? 'bold' : 'normal');
    doc.setFontSize(emphasis ? 13 : 10.5);
    setText(emphasis ? INK : colour);
    doc.text(name, PRICE_X, y, { align: 'right' });
    doc.setFont('helvetica', 'bold');
    setText(emphasis ? CRIMSON : INK);
    doc.text(value, TOTAL_X, y, { align: 'right' });
    y += emphasis ? 6 : 16;
  };

  y += 4;
  totalRow('Items', money(subtotal));
  if (discount > 0) totalRow('Discount', '- ' + money(discount), false, GOOD);
  totalRow('Amount Paid', money(data.total), true);

  // ── Note ─────────────────────────────────────────────────────────────────────
  y += 28;
  if (y + 60 > BOTTOM) {
    doc.addPage();
    y = 56;
  }
  setDraw(RULE);
  doc.line(LEFT, y, RIGHT, y);
  y += 20;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  setText(FAINT);
  doc.text('NOTE', LEFT, y);
  y += 15;
  doc.setFontSize(10.5);
  setText(MUTED);
  const note = doc.splitTextToSize(
    `Thank you for shopping with ${data.boutiqueName || 'us'}. This bill records an in-store purchase handled by the boutique.`,
    RIGHT - LEFT,
  );
  doc.text(note, LEFT, y);
  y += note.length * 14 + 6;
  setText(FAINT);
  doc.text('This is a bill for an in-store sale, not a tax invoice. Powered by MangaiMart.', LEFT, y);

  return doc;
}

/** The bill PDF as a File, for upload + WhatsApp sharing. */
export async function billPdfFile(data: BillDocData, filename: string): Promise<File> {
  const doc = await buildDoc(data);
  const blob = doc.output('blob');
  return new File([blob], filename, { type: 'application/pdf' });
}

/** Saves the bill PDF to the seller's device. */
export async function downloadBillDoc(data: BillDocData, filename: string): Promise<void> {
  const doc = await buildDoc(data);
  doc.save(filename);
}

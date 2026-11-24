/**
 * The offline-sale bill as a TRUE TEXT PDF — selectable, sharp at any zoom and a
 * few KB, not an html2canvas screenshot. It mirrors the online-order receipt
 * (api/_receipt.js): a clean white invoice with a Bill From / Bill To block, an
 * itemised table and a totals stack, so an in-store bill reads the same as the
 * one online buyers are emailed.
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

/** Builds the jsPDF document. Dynamically imports jspdf so it never ships in the
 *  buyer bundle. */
async function buildDoc(data: BillDocData) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const M = 48; // page margin
  const LEFT = M;
  const RIGHT = PAGE_W - M;
  const BOTTOM = PAGE_H - 56;

  // Right-aligned column anchors for the items table.
  const TOTAL_X = RIGHT;
  const QTY_X = RIGHT - 78;
  const PRICE_X = RIGHT - 150;
  const ITEM_W = PRICE_X - LEFT - 14;

  const setText = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2]);
  const setDraw = (c: [number, number, number]) => doc.setDrawColor(c[0], c[1], c[2]);

  const subtotal = data.items.reduce((s, it) => s + it.price * it.qty, 0);
  const discount = data.discount ?? 0;

  let y = 64;

  // ── Brand header ───────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  setText(CRIMSON);
  doc.text('MangaiMart', LEFT, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  setText(FAINT);
  doc.text('BILL', RIGHT, y - 12, { align: 'right' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  setText(INK);
  doc.text(data.billNumber, RIGHT, y + 2, { align: 'right' });

  y += 16;
  setDraw(RULE);
  doc.setLineWidth(1);
  doc.line(LEFT, y, RIGHT, y);

  // ── Meta (date) ──────────────────────────────────────────────────────────────
  y += 22;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  setText(FAINT);
  doc.text('DATE', LEFT, y);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  setText(INK);
  doc.text(data.date, LEFT + 44, y);

  // ── Bill From / Bill To ──────────────────────────────────────────────────────
  y += 30;
  const colRightX = LEFT + 270;
  const label = (text: string, x: number, yy: number) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    setText(FAINT);
    doc.text(text, x, yy);
  };
  const detail = (text: string, x: number, yy: number, strong = false) => {
    doc.setFont('helvetica', strong ? 'bold' : 'normal');
    doc.setFontSize(strong ? 12 : 10.5);
    setText(strong ? INK : MUTED);
    doc.text(text, x, yy);
  };

  label('BILL FROM', LEFT, y);
  label('BILL TO', colRightX, y);

  let yl = y + 16;
  detail(data.boutiqueName || 'Boutique', LEFT, yl, true);
  let yFrom = yl + 15;
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
  doc.text(`Sold by ${data.boutiqueName || 'the boutique'} on MangaiMart.`, LEFT, yFrom + 2);
  yFrom += 16;

  let yTo = yl + 15;
  detail(data.buyerName || 'Customer', colRightX, yTo, true);
  yTo += 15;
  if (data.buyerPhone) {
    detail(String(data.buyerPhone), colRightX, yTo);
    yTo += 14;
  }

  y = Math.max(yFrom, yTo) + 18;

  // ── Items table ──────────────────────────────────────────────────────────────
  const drawTableHead = () => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    setText(FAINT);
    doc.text('ITEM DESCRIPTION', LEFT, y);
    doc.text('PRICE', PRICE_X, y, { align: 'right' });
    doc.text('QTY', QTY_X, y, { align: 'right' });
    doc.text('TOTAL', TOTAL_X, y, { align: 'right' });
    y += 8;
    setDraw(RULE);
    doc.line(LEFT, y, RIGHT, y);
    y += 14;
  };
  drawTableHead();

  for (const it of data.items) {
    const titleLines: string[] = doc.splitTextToSize(it.title || 'Item', ITEM_W);
    const rowH = Math.max(titleLines.length * 13, 16) + 10;
    if (y + rowH > BOTTOM) {
      doc.addPage();
      y = 64;
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
    y += 14;
  }

  // ── Totals ───────────────────────────────────────────────────────────────────
  const totalRow = (name: string, value: string, emphasis = false, colour: [number, number, number] = MUTED) => {
    if (y + 20 > BOTTOM) {
      doc.addPage();
      y = 64;
    }
    if (emphasis) {
      y += 4;
      setDraw(RULE);
      doc.line(PRICE_X - 40, y, RIGHT, y);
      y += 16;
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
  if (discount > 0) totalRow('Discount', '- ' + money(discount), false, [29, 122, 77]);
  if (data.paymentMethod) totalRow('Payment', data.paymentMethod);
  totalRow('Total', money(data.total), true);

  // ── Footer ───────────────────────────────────────────────────────────────────
  y += 26;
  if (y + 40 > BOTTOM) {
    doc.addPage();
    y = 64;
  }
  setDraw(RULE);
  doc.line(LEFT, y, RIGHT, y);
  y += 20;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  setText(MUTED);
  doc.text(`Thank you for shopping with ${data.boutiqueName || 'us'}!`, LEFT, y);
  y += 15;
  doc.setFontSize(8.5);
  setText(FAINT);
  doc.text('This is a bill for an in-store purchase. Powered by MangaiMart.', LEFT, y);

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

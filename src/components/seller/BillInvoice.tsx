import { css } from '@/lib/css';
import { fmt } from '@/data/demo';
import type { BillDocData } from '@/lib/billPdf';

/** On-screen preview of the offline bill, in the same clean invoice style as the
 *  online-order receipt (api/_receipt.js) and the generated PDF (src/lib/billPdf.ts).
 *
 *  A document, so the colours are literal light-theme values rather than --ag-*
 *  tokens: this card is always white with dark text, in light mode and dark. */
const INK = '#241019';
const MUTED = '#775D66';
const FAINT = '#9A828C';
const RULE = '#EFDCE4';
const CRIMSON = '#B02454';
const GOOD = '#1D7A4D';

const labelStyle = `font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;color:${FAINT};`;

export function BillInvoice({ data }: { data: BillDocData }) {
  const subtotal = data.items.reduce((s, it) => s + it.price * it.qty, 0);
  const discount = data.discount ?? 0;

  return (
    <div style={css(`width:100%;max-width:440px;background:#fff;color:${INK};font-family:"Archivo",sans-serif;padding:26px 28px;border:1px solid ${RULE};border-radius:16px;`)}>
      {/* Brand header */}
      <div style={css('display:flex;align-items:flex-end;justify-content:space-between;')}>
        <div style={css(`font-family:var(--ag-display);font-weight:700;font-size:22px;color:${CRIMSON};`)}>MangaiMart</div>
        <div style={css('text-align:right;')}>
          <div style={css(labelStyle)}>Bill</div>
          <div style={css(`font-weight:800;font-size:14px;color:${INK};font-variant-numeric:tabular-nums;margin-top:2px;`)}>{data.billNumber}</div>
        </div>
      </div>
      <div style={css(`height:1px;background:${RULE};margin:14px 0;`)} />

      {/* Date */}
      <div style={css('display:flex;align-items:center;gap:8px;')}>
        <span style={css(labelStyle)}>Date</span>
        <span style={css(`font-weight:700;font-size:13px;color:${INK};`)}>{data.date}</span>
      </div>

      {/* Bill From / Bill To */}
      <div style={css('display:flex;gap:16px;margin-top:18px;')}>
        <div style={css('flex:1;min-width:0;')}>
          <div style={css(labelStyle)}>Bill From</div>
          <div style={css(`font-weight:800;font-size:13.5px;color:${INK};margin-top:5px;`)}>{data.boutiqueName || 'Boutique'}</div>
          {data.boutiqueAddressLines.map((l, i) => (
            <div key={i} style={css(`font-size:12px;color:${MUTED};line-height:1.5;`)}>{l}</div>
          ))}
          {data.boutiquePhone && <div style={css(`font-size:12px;color:${MUTED};line-height:1.5;`)}>{data.boutiquePhone}</div>}
          <div style={css(`font-size:10.5px;color:${FAINT};margin-top:6px;line-height:1.5;`)}>Sold by {data.boutiqueName || 'the boutique'} on MangaiMart.</div>
        </div>
        <div style={css('flex:1;min-width:0;')}>
          <div style={css(labelStyle)}>Bill To</div>
          <div style={css(`font-weight:800;font-size:13.5px;color:${INK};margin-top:5px;`)}>{data.buyerName || 'Customer'}</div>
          {data.buyerPhone && <div style={css(`font-size:12px;color:${MUTED};line-height:1.5;`)}>{data.buyerPhone}</div>}
        </div>
      </div>

      {/* Items */}
      <div style={css('margin-top:20px;')}>
        <div style={css(`display:flex;padding-bottom:7px;border-bottom:1px solid ${RULE};${labelStyle}`)}>
          <span style={css('flex:1;')}>Item Description</span>
          <span style={css('width:72px;text-align:right;')}>Price</span>
          <span style={css('width:34px;text-align:right;')}>Qty</span>
          <span style={css('width:78px;text-align:right;')}>Total</span>
        </div>
        {data.items.map((it, i) => (
          <div key={i} style={css(`display:flex;align-items:flex-start;padding:9px 0;border-bottom:1px solid ${RULE};font-size:12.5px;`)}>
            <span style={css(`flex:1;color:${INK};font-weight:600;padding-right:8px;`)}>{it.title}</span>
            <span style={css(`width:72px;text-align:right;color:${MUTED};font-variant-numeric:tabular-nums;`)}>{fmt(it.price)}</span>
            <span style={css(`width:34px;text-align:right;color:${MUTED};font-variant-numeric:tabular-nums;`)}>{it.qty}</span>
            <span style={css(`width:78px;text-align:right;font-weight:700;color:${INK};font-variant-numeric:tabular-nums;`)}>{fmt(it.price * it.qty)}</span>
          </div>
        ))}
      </div>

      {/* Totals */}
      <div style={css('margin-top:14px;display:flex;flex-direction:column;align-items:flex-end;gap:5px;')}>
        <Row label="Items" value={fmt(subtotal)} />
        {discount > 0 && <Row label="Discount" value={'- ' + fmt(discount)} colour={GOOD} />}
        {data.paymentMethod && <Row label="Payment" value={data.paymentMethod} />}
        <div style={css(`display:flex;justify-content:space-between;gap:20px;min-width:220px;margin-top:6px;padding-top:10px;border-top:1px solid ${RULE};`)}>
          <span style={css(`font-weight:800;font-size:14px;color:${INK};`)}>Total</span>
          <span style={css(`font-weight:800;font-size:18px;color:${CRIMSON};font-variant-numeric:tabular-nums;`)}>{fmt(data.total)}</span>
        </div>
      </div>

      {/* Footer */}
      <div style={css(`height:1px;background:${RULE};margin:20px 0 14px;`)} />
      <div style={css(`font-size:12.5px;color:${MUTED};`)}>Thank you for shopping with {data.boutiqueName || 'us'}!</div>
      <div style={css(`font-size:10.5px;color:${FAINT};margin-top:6px;line-height:1.5;`)}>This is a bill for an in-store purchase. Powered by MangaiMart.</div>
    </div>
  );
}

function Row({ label, value, colour }: { label: string; value: string; colour?: string }) {
  return (
    <div style={css('display:flex;justify-content:space-between;gap:20px;min-width:220px;')}>
      <span style={css(`font-size:12.5px;color:${colour ?? MUTED};`)}>{label}</span>
      <span style={css(`font-size:12.5px;font-weight:700;color:${colour ?? INK};font-variant-numeric:tabular-nums;`)}>{value}</span>
    </div>
  );
}

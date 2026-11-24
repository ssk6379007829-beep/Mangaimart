import { css } from '@/lib/css';
import { fmt } from '@/data/demo';
import type { BillDocData } from '@/lib/billPdf';

/** On-screen preview of the offline bill, laid out like the online-order Payment
 *  Receipt (api/_receipt.js) and the generated PDF (src/lib/billPdf.ts): MangaiMart
 *  wordmark top-left, the shop's logo in a tinted box top-right, a title, a
 *  Bill No / Date block, Bill From / Bill To, an items table, totals and a note.
 *
 *  A document, so the colours are literal light-theme values rather than --ag-*
 *  tokens: this card is always white with dark text, in light mode and dark. */
const INK = '#241019';
const MUTED = '#775D66';
const FAINT = '#9A828C';
const RULE = '#EFDCE4';
const CRIMSON = '#B02454';
const TITLE = '#7A1836';
const TINT = '#FDEEF4';
const GOOD = '#1D7A4D';

const labelStyle = `font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${FAINT};`;

export function BillInvoice({ data }: { data: BillDocData }) {
  const subtotal = data.items.reduce((s, it) => s + it.price * it.qty, 0);
  const discount = data.discount ?? 0;
  const initial = (data.boutiqueName || 'A').charAt(0).toUpperCase();

  return (
    <div style={css(`width:100%;max-width:460px;background:#fff;color:${INK};font-family:"Archivo",sans-serif;padding:26px 28px;border:1px solid ${RULE};border-radius:16px;`)}>
      {/* Masthead: MangaiMart wordmark + shop logo */}
      <div style={css('display:flex;align-items:flex-start;justify-content:space-between;gap:12px;')}>
        <img src="/mangaimart-wordmark.png" alt="MangaiMart" style={css('height:24px;width:auto;object-fit:contain;')} />
        <div style={css(`width:50px;height:50px;flex:none;border-radius:12px;background:${TINT};border:1px solid ${RULE};display:flex;align-items:center;justify-content:center;overflow:hidden;`)}>
          {data.boutiqueLogoUrl
            ? <img src={data.boutiqueLogoUrl} alt={data.boutiqueName} style={css('width:100%;height:100%;object-fit:cover;')} />
            : <span style={css(`font-weight:700;font-size:20px;color:${CRIMSON};`)}>{initial}</span>}
        </div>
      </div>

      {/* Title */}
      <div style={css(`font-family:var(--ag-display);font-weight:700;font-size:28px;color:${TITLE};margin-top:16px;`)}>Bill</div>

      {/* Meta */}
      <div style={css('margin-top:12px;display:flex;flex-direction:column;gap:3px;')}>
        <MetaRow name="Bill No" value={data.billNumber} mono />
        <MetaRow name="Date" value={data.date} />
        {data.paymentMethod && <MetaRow name="Payment" value={data.paymentMethod} />}
      </div>

      {/* Bill From / Bill To */}
      <div style={css('display:flex;gap:16px;margin-top:20px;')}>
        <div style={css('flex:1;min-width:0;')}>
          <div style={css(labelStyle)}>Bill From</div>
          <div style={css(`font-weight:800;font-size:13.5px;color:${INK};margin-top:6px;`)}>{data.boutiqueName || 'Boutique'}</div>
          {data.boutiqueAddressLines.map((l, i) => (
            <div key={i} style={css(`font-size:12px;color:${MUTED};line-height:1.5;`)}>{l}</div>
          ))}
          {data.boutiquePhone && <div style={css(`font-size:12px;color:${MUTED};line-height:1.5;`)}>{data.boutiquePhone}</div>}
          <div style={css(`font-size:10.5px;color:${FAINT};margin-top:7px;line-height:1.5;`)}>Sold by {data.boutiqueName || 'the boutique'} on MangaiMart.</div>
        </div>
        <div style={css('flex:1;min-width:0;')}>
          <div style={css(labelStyle)}>Bill To</div>
          <div style={css(`font-weight:800;font-size:13.5px;color:${INK};margin-top:6px;`)}>{data.buyerName || 'Customer'}</div>
          {data.buyerPhone && <div style={css(`font-size:12px;color:${MUTED};line-height:1.5;`)}>{data.buyerPhone}</div>}
        </div>
      </div>

      {/* Items */}
      <div style={css('margin-top:22px;')}>
        <div style={css(`display:flex;padding-bottom:8px;border-bottom:1px solid ${RULE};${labelStyle}`)}>
          <span style={css('flex:1;')}>Item Description</span>
          <span style={css('width:72px;text-align:right;')}>Price</span>
          <span style={css('width:34px;text-align:right;')}>Qty</span>
          <span style={css('width:78px;text-align:right;')}>Total</span>
        </div>
        {data.items.map((it, i) => (
          <div key={i} style={css(`display:flex;align-items:flex-start;padding:10px 0;border-bottom:1px solid ${RULE};font-size:12.5px;`)}>
            <span style={css(`flex:1;color:${INK};font-weight:700;padding-right:8px;`)}>{it.title}</span>
            <span style={css(`width:72px;text-align:right;color:${MUTED};font-variant-numeric:tabular-nums;`)}>{fmt(it.price)}</span>
            <span style={css(`width:34px;text-align:right;color:${MUTED};font-variant-numeric:tabular-nums;`)}>{it.qty}</span>
            <span style={css(`width:78px;text-align:right;font-weight:700;color:${INK};font-variant-numeric:tabular-nums;`)}>{fmt(it.price * it.qty)}</span>
          </div>
        ))}
      </div>

      {/* Totals */}
      <div style={css('margin-top:14px;display:flex;flex-direction:column;align-items:flex-end;gap:6px;')}>
        <Row label="Items" value={fmt(subtotal)} />
        {discount > 0 && <Row label="Discount" value={'- ' + fmt(discount)} colour={GOOD} />}
        <div style={css(`display:flex;justify-content:space-between;gap:20px;min-width:230px;margin-top:6px;padding-top:11px;border-top:1px solid ${RULE};`)}>
          <span style={css(`font-weight:800;font-size:15px;color:${INK};`)}>Amount Paid</span>
          <span style={css(`font-weight:800;font-size:19px;color:${CRIMSON};font-variant-numeric:tabular-nums;`)}>{fmt(data.total)}</span>
        </div>
      </div>

      {/* Note */}
      <div style={css(`height:1px;background:${RULE};margin:22px 0 14px;`)} />
      <div style={css(labelStyle)}>Note</div>
      <div style={css(`font-size:12px;color:${MUTED};margin-top:6px;line-height:1.55;`)}>Thank you for shopping with {data.boutiqueName || 'us'}. This bill records an in-store purchase handled by the boutique.</div>
      <div style={css(`font-size:10.5px;color:${FAINT};margin-top:8px;line-height:1.5;`)}>This is a bill for an in-store sale, not a tax invoice. Powered by MangaiMart.</div>
    </div>
  );
}

function MetaRow({ name, value, mono }: { name: string; value: string; mono?: boolean }) {
  return (
    <div style={css('display:flex;align-items:center;gap:10px;')}>
      <span style={css(`font-size:11.5px;color:${FAINT};width:74px;flex:none;`)}>{name}</span>
      <span style={css(`font-size:12.5px;font-weight:700;color:${INK};${mono ? 'font-variant-numeric:tabular-nums;letter-spacing:.02em;' : ''}`)}>{value}</span>
    </div>
  );
}

function Row({ label, value, colour }: { label: string; value: string; colour?: string }) {
  return (
    <div style={css('display:flex;justify-content:space-between;gap:20px;min-width:230px;')}>
      <span style={css(`font-size:12.5px;color:${colour ?? MUTED};`)}>{label}</span>
      <span style={css(`font-size:12.5px;font-weight:700;color:${colour ?? INK};font-variant-numeric:tabular-nums;`)}>{value}</span>
    </div>
  );
}

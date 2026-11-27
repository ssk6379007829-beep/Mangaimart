import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { css } from '@/lib/css';
import {
  fetchBoutiquePrivate, fetchBoutiqueDuplicates, fetchProductCounts,
  type AdminBoutiqueRow,
} from '@/data/boutiques';
import { BOUTIQUE_STATUS_LABEL, type BoutiquePrivate, type BoutiqueStatus } from '@/data/types';
import { resolvePincode } from '@/data/pincodes';
import type { PincodeArea } from '@/lib/pincode';
import { lookupIfsc, type IfscResult } from '@/lib/ifsc';
import { normalizeIndianPhone, buildWhatsAppLink } from '@/lib/whatsapp';
import {
  identityFlags, bankBranchFlags, locationFlags, publicDuplicates, privateDuplicates,
  behaviourFlags, sortFlags, reviewVerdict, verificationMessage, instagramUrl,
  type ReviewFlag, type ReviewTone, type DuplicateSignal,
} from '@/lib/boutiqueReview';

/**
 * The full boutique application in a slide-in drawer — everything the seven-step
 * setup wizard collected, the withheld GST/payout fields (read through
 * `boutique_private`), the automatic checks, and the decision controls.
 *
 * Extracted from the old Approvals screen so the merged Boutiques page can open
 * the SAME panel for every boutique, not only the ones in the review queue.
 * Which decision buttons show depends on the boutique's current status:
 *  - not yet live  → Reject · Needs changes · Approve
 *  - live          → Reject · Suspend
 *  - rejected      → Needs changes · Approve
 * so one screen handles both "review this application" and "manage this shop".
 *
 * ── What this screen is actually for ────────────────────────────────────────
 * Reading the application proves only that a form was filled in. Nothing the
 * wizard collects is verified against anything: there are no documents, GST is
 * optional and never checked against the registry, and since payouts are made by
 * hand the bank account is not penny-dropped either. The thing that separates a
 * real boutique from an invented one is a two-minute phone call, and everything
 * on this screen exists to serve that call rather than to replace it. So the
 * drawer makes the call one tap away and does, up front, the comparisons a
 * thorough admin would do by hand and nobody does by the fiftieth application.
 * The rules and their wording live in `src/lib/boutiqueReview.ts`.
 */

const STATUS_CHIP: Record<BoutiqueStatus, { bg: string; fg: string }> = {
  draft: { bg: 'var(--ag-surface-2)', fg: 'var(--ag-muted)' },
  pending: { bg: 'var(--ag-warn-bg)', fg: 'var(--ag-warn-text)' },
  changes_requested: { bg: 'var(--ag-gold-bg)', fg: 'var(--ag-gold-text)' },
  approved: { bg: 'var(--ag-good-bg)', fg: 'var(--ag-good-text)' },
  rejected: { bg: 'var(--ag-bad-bg)', fg: 'var(--ag-bad-text)' },
};

/** One palette for every tag, so a colour means the same thing everywhere. */
const TONE_STYLE: Record<ReviewTone, { bg: string; fg: string; border: string; icon: string }> = {
  bad: { bg: 'var(--ag-bad-bg)', fg: 'var(--ag-bad-text)', border: 'var(--ag-bad-bg)', icon: 'error' },
  warn: { bg: 'var(--ag-gold-bg)', fg: 'var(--ag-gold-text)', border: 'var(--ag-gold-border)', icon: 'help' },
  info: { bg: 'var(--ag-surface-2)', fg: 'var(--ag-muted)', border: 'var(--ag-border-soft)', icon: 'info' },
  good: { bg: 'var(--ag-good-bg)', fg: 'var(--ag-good-text)', border: 'var(--ag-good-bg)', icon: 'check_circle' },
};

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/** A tag. `compact` is the table-row form — no detail, no wrapping. */
export function Tag({ flag, compact = false }: { flag: ReviewFlag; compact?: boolean }) {
  const t = TONE_STYLE[flag.tone];
  if (compact) {
    return (
      <span
        title={flag.detail}
        style={css(`display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;background:${t.bg};color:${t.fg};font-size:10.5px;font-weight:800;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;`)}
      >
        <span aria-hidden="true" style={css("font-family:'Material Symbols Outlined';font-size:12px;")}>{t.icon}</span>
        {flag.label}
      </span>
    );
  }
  return (
    <div style={css(`display:flex;gap:9px;align-items:flex-start;padding:9px 11px;border-radius:12px;background:${t.bg};border:1px solid ${t.border};`)}>
      <span aria-hidden="true" style={css(`font-family:'Material Symbols Outlined';font-size:17px;color:${t.fg};line-height:1.3;`)}>{t.icon}</span>
      <div style={css('flex:1;min-width:0;')}>
        <div style={css(`font-size:12.5px;font-weight:800;color:${t.fg};`)}>{flag.label}</div>
        {flag.detail && (
          <div style={css(`font-size:12px;font-weight:600;line-height:1.55;color:${t.fg};opacity:.85;margin-top:3px;`)}>{flag.detail}</div>
        )}
      </div>
    </div>
  );
}

/** An outbound link rendered as a button, so the admin never copies a value by
 *  hand to act on it. Everything here opens in a new tab. */
function LinkChip({ href, icon, children, tone = 'default' }: {
  href: string; icon: string; children: ReactNode; tone?: 'default' | 'primary' | 'wa';
}) {
  const colour = tone === 'wa' ? '#128C7E' : tone === 'primary' ? 'var(--ag-crimson)' : 'var(--ag-label)';
  const border = tone === 'default' ? 'var(--ag-border)' : colour;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={css(`display:inline-flex;align-items:center;gap:7px;height:38px;padding:0 13px;border-radius:11px;background:var(--ag-surface);border:1.5px solid ${border};color:${colour};font-weight:800;font-size:12.5px;text-decoration:none;font-family:inherit;`)}
    >
      <span aria-hidden="true" style={css("font-family:'Material Symbols Outlined';font-size:17px;")}>{icon}</span>
      {children}
    </a>
  );
}

/** A value that is also a link — used inside the field tables. */
function ValueLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={css('color:var(--ag-crimson);font-weight:700;text-decoration:underline;text-underline-offset:2px;word-break:break-word;')}
    >
      {children}
    </a>
  );
}

/** Two values that ought to agree, shown together with the verdict between them. */
function Compare({ value, against, agrees, note }: {
  value: ReactNode; against: string; agrees: boolean; note?: string;
}) {
  const t = TONE_STYLE[agrees ? 'good' : 'warn'];
  return (
    <span style={css('display:inline-flex;flex-wrap:wrap;align-items:center;gap:7px;')}>
      <span>{value}</span>
      <span
        title={note}
        style={css(`display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:999px;background:${t.bg};color:${t.fg};font-size:10.5px;font-weight:800;`)}
      >
        <span aria-hidden="true" style={css("font-family:'Material Symbols Outlined';font-size:12px;")}>{t.icon}</span>
        {agrees ? 'matches' : 'differs from'} {against}
      </span>
    </span>
  );
}

/** The full application, plus the decisions an admin can record for this status. */
export function BoutiqueReviewDrawer({
  boutique, all, seedArea, seedCount, onClose, onDecide,
}: {
  boutique: AdminBoutiqueRow;
  all: readonly AdminBoutiqueRow[];
  seedArea?: PincodeArea | null;
  seedCount?: number | null;
  onClose: () => void;
  onDecide: (b: AdminBoutiqueRow, status: BoutiqueStatus, note?: string) => void;
}) {
  const [priv, setPriv] = useState<BoutiquePrivate | null>(null);
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState<'changes_requested' | 'rejected' | null>(null);
  const [busy, setBusy] = useState(false);
  const [ifsc, setIfsc] = useState<IfscResult | null>(null);
  const [dupes, setDupes] = useState<{ applied: boolean; signals: DuplicateSignal[] } | null>(null);

  const [area, setArea] = useState<PincodeArea | null | undefined>(seedArea);
  const [productCount, setProductCount] = useState<number | null>(seedCount ?? null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const pin = (boutique.pincode ?? '').trim();
    if (!pin) { setArea(null); return; }
    void resolvePincode(pin).then((a) => { if (!cancelled) setArea(a); });
    return () => { cancelled = true; };
  }, [boutique.pincode]);

  useEffect(() => {
    let cancelled = false;
    void fetchProductCounts([boutique.id]).then((m) => {
      if (!cancelled) setProductCount(m.get(boutique.id) ?? 0);
    });
    return () => { cancelled = true; };
  }, [boutique.id]);

  useEffect(() => {
    let cancelled = false;
    fetchBoutiquePrivate(boutique.id)
      .then((p) => { if (!cancelled) setPriv(p); })
      .catch(() => { /* the private block simply stays empty */ });
    return () => { cancelled = true; };
  }, [boutique.id]);

  useEffect(() => {
    let cancelled = false;
    void fetchBoutiqueDuplicates(boutique.id).then((d) => { if (!cancelled) setDupes(d); });
    return () => { cancelled = true; };
  }, [boutique.id]);

  useEffect(() => {
    const code = (priv?.bank_ifsc ?? '').trim();
    if (!code) { setIfsc(null); return; }
    const ac = new AbortController();
    void lookupIfsc(code, ac.signal).then(setIfsc).catch(() => setIfsc(null));
    return () => ac.abort();
  }, [priv?.bank_ifsc]);

  const chip = STATUS_CHIP[boutique.status];
  const dash = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '—' : String(v));

  const flags = useMemo(() => sortFlags([
    ...identityFlags(boutique, priv),
    ...bankBranchFlags(boutique, ifsc),
    ...locationFlags(boutique, area),
    ...publicDuplicates(boutique, all),
    ...privateDuplicates(dupes?.signals ?? []),
    ...behaviourFlags(boutique, productCount),
  ]), [boutique, priv, ifsc, area, all, dupes, productCount]);

  const verdict = reviewVerdict(flags);
  const verdictTone = TONE_STYLE[verdict.tone];

  const phone = (priv?.phone ?? '').trim();
  const whatsapp = (priv?.whatsapp ?? '').trim() || phone;
  const email = (priv?.email ?? '').trim();
  const insta = (boutique.instagram ?? '').trim();
  const map = (boutique.map_url ?? '').trim();

  const owner = (boutique.owner_name || boutique.owner?.full_name || '').trim();
  const holder = (priv?.bank_account_name ?? '').trim();
  const holderFlag = flags.find((f) => f.id === 'bank-name-match' || f.id === 'bank-name-mismatch');

  const groups: { title: string; rows: [string, ReactNode][] }[] = [
    {
      title: 'Boutique',
      rows: [
        ['Name', dash(boutique.name)],
        ['Owner', dash(owner)],
        ['Category', dash(boutique.category)],
        ['Bio', dash(boutique.description)],
        ['Years in business', dash(boutique.years_in_business)],
      ],
    },
    {
      title: 'Contact',
      rows: [
        ['Mobile', phone ? <ValueLink href={`tel:+${normalizeIndianPhone(phone)}`}>{phone}</ValueLink> : '—'],
        ['WhatsApp', (priv?.whatsapp ?? '').trim()
          ? <ValueLink href={buildWhatsAppLink(priv!.whatsapp!, verificationMessage(boutique))}>{priv!.whatsapp}</ValueLink>
          : '—'],
        ['Email', email ? <ValueLink href={`mailto:${email}`}>{email}</ValueLink> : '—'],
        ['Instagram', insta ? <ValueLink href={instagramUrl(insta)}>@{insta.replace(/^@/, '')}</ValueLink> : '—'],
      ],
    },
    {
      title: 'Address',
      rows: [
        ['Shop address', dash(boutique.address_line)],
        ['Area', dash(boutique.area)],
        ['City / district', `${dash(boutique.city)} · ${dash(boutique.district)}`],
        ['State / pincode', area
          ? <Compare
              value={`${dash(boutique.state)} · ${dash(boutique.pincode)}`}
              against="the pincode directory"
              agrees={!flags.some((f) => f.id === 'pincode-state-mismatch' || f.id === 'pincode-district-mismatch')}
              note={`${area.pincode} → ${area.district}, ${area.state}`}
            />
          : `${dash(boutique.state)} · ${dash(boutique.pincode)}`],
        ['Map link', map ? <ValueLink href={map}>Open the shop’s pin</ValueLink> : '—'],
      ],
    },
    {
      title: 'Store settings',
      rows: [
        ['Timing', boutique.open_time && boutique.close_time ? `${boutique.open_time} – ${boutique.close_time}` : '—'],
        ['Working days', boutique.working_days?.length ? boutique.working_days.join(', ') : '—'],
        ['Delivery', boutique.delivery_available ? `${dash(boutique.delivery_areas)} · ₹${boutique.delivery_charge ?? 0}` : 'Store pickup only'],
        ['Payments', 'Online only'],
      ],
    },
    {
      title: 'Documents & payout (private)',
      rows: [
        ['GST number', dash(priv?.gst_number)],
        ['Registration', dash(priv?.business_reg_number)],
        ['UPI ID', dash(priv?.upi_id)],
        ['Account holder', holder && owner
          ? <Compare
              value={holder}
              against="the owner"
              agrees={holderFlag?.id === 'bank-name-match'}
              note={holderFlag?.detail}
            />
          : dash(holder)],
        ['Account number', dash(priv?.bank_account_number)],
        ['IFSC', ifsc?.state === 'valid'
          ? <span>{dash(priv?.bank_ifsc)} <span style={css('color:var(--ag-muted);font-weight:600;')}>· {ifsc.bank}, {ifsc.branch}</span></span>
          : dash(priv?.bank_ifsc)],
      ],
    },
  ];

  const confirm = () => {
    if (!asking) return;
    if (note.trim().length < 5) return;
    setBusy(true);
    onDecide(boutique, asking, note.trim());
  };

  const isApproved = boutique.status === 'approved';

  return (
    <div
      onClick={onClose}
      style={css('position:fixed;inset:0;z-index:200;background:rgba(42,26,32,.45);display:flex;justify-content:flex-end;animation:agx-fade .18s ease;')}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={css('width:min(560px,100%);height:100%;background:var(--ag-bg);overflow-y:auto;box-shadow:-24px 0 60px -30px rgba(0,0,0,.6);')}
      >
        <div style={css('position:sticky;top:0;z-index:2;background:linear-gradient(135deg,#8E1C44,#B02454 60%,#D6336C);color:#fff;padding:20px;')}>
          <div style={css('display:flex;align-items:flex-start;gap:12px;')}>
            <div style={css("width:48px;height:48px;flex:none;border-radius:15px;overflow:hidden;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:21px;")}>
              {boutique.logo_url ? <img src={boutique.logo_url} alt="" style={css('width:100%;height:100%;object-fit:cover;')} /> : boutique.name.charAt(0)}
            </div>
            <div style={css('flex:1;min-width:0;')}>
              <div style={css("font-family:var(--ag-display);font-weight:700;font-size:22px;line-height:1.2;")}>{boutique.name}</div>
              <div style={css('font-size:12.5px;opacity:.85;margin-top:3px;')}>Submitted {fmtDate(boutique.submitted_at)}</div>
              <span style={css(`display:inline-block;margin-top:8px;font-size:11px;font-weight:800;padding:4px 10px;border-radius:8px;background:${chip.bg};color:${chip.fg};`)}>{BOUTIQUE_STATUS_LABEL[boutique.status]}</span>
            </div>
            <button
              onClick={onClose}
              style={css('width:36px;height:36px;flex:none;border-radius:11px;border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.14);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;')}
            >
              <span aria-hidden="true" style={css("font-family:'Material Symbols Outlined';font-size:19px;")}>close</span>
            </button>
          </div>
        </div>

        <div style={css('padding:16px 20px 24px;display:flex;flex-direction:column;gap:14px;')}>
          {priv?.review_note && (
            <div style={css('background:var(--ag-gold-bg);border:1px solid var(--ag-gold-border);border-radius:16px;padding:13px 15px;')}>
              <div style={css('font-size:11.5px;font-weight:800;color:#B9862F;letter-spacing:.04em;')}>PREVIOUS NOTE TO SELLER</div>
              <div style={css('font-size:13px;color:var(--ag-gold-text);font-weight:600;line-height:1.6;margin-top:5px;white-space:pre-wrap;')}>{priv.review_note}</div>
            </div>
          )}

          {/* ── Reach the seller ──────────────────────────────────────────── */}
          <div style={css('background:var(--ag-surface);border:1px solid var(--ag-surface-3);border-radius:18px;padding:15px 17px;')}>
            <div style={css("font-weight:700;font-size:16px;")}>Verify by calling</div>
            <div style={css('font-size:12px;color:var(--ag-muted);font-weight:600;margin-top:3px;line-height:1.55;')}>
              Nothing below is checked against any registry. Ask for a landmark near the shop, how long they have run it, and a short video of the shop front — a fake application cannot answer the first and will not send the last.
            </div>
            <div style={css('display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;')}>
              {phone && <LinkChip href={`tel:+${normalizeIndianPhone(phone)}`} icon="call" tone="primary">Call {phone}</LinkChip>}
              {whatsapp && (
                <LinkChip href={buildWhatsAppLink(whatsapp, verificationMessage(boutique))} icon="chat" tone="wa">
                  WhatsApp
                </LinkChip>
              )}
              {map && <LinkChip href={map} icon="location_on">Map pin</LinkChip>}
              {insta && <LinkChip href={instagramUrl(insta)} icon="photo_camera">Instagram</LinkChip>}
              {email && <LinkChip href={`mailto:${email}`} icon="mail">Email</LinkChip>}
            </div>
            {!phone && !whatsapp && (
              <div style={css('font-size:12px;font-weight:700;color:var(--ag-bad-text);margin-top:10px;')}>
                No contact number on this application — there is no way to verify it. Send it back rather than guessing.
              </div>
            )}
          </div>

          {/* ── What the checks found ─────────────────────────────────────── */}
          <div style={css('background:var(--ag-surface);border:1px solid var(--ag-surface-3);border-radius:18px;padding:15px 17px;')}>
            <div style={css('display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;')}>
              <div style={css("font-weight:700;font-size:16px;")}>Automatic checks</div>
              <span style={css('font-size:11.5px;font-weight:700;color:var(--ag-muted);')}>{flags.length} check{flags.length === 1 ? '' : 's'}</span>
            </div>

            <div style={css(`margin-top:10px;display:flex;gap:9px;align-items:flex-start;padding:10px 12px;border-radius:12px;background:${verdictTone.bg};`)}>
              <span aria-hidden="true" style={css(`font-family:'Material Symbols Outlined';font-size:18px;color:${verdictTone.fg};`)}>{verdictTone.icon}</span>
              <div style={css(`font-size:12.5px;font-weight:700;line-height:1.55;color:${verdictTone.fg};`)}>{verdict.text}</div>
            </div>

            <div style={css('margin-top:10px;display:flex;flex-direction:column;gap:7px;')}>
              {flags.map((f) => <Tag key={f.id} flag={f} />)}
            </div>

            {dupes && !dupes.applied && (
              <div style={css('margin-top:10px;font-size:11.5px;font-weight:700;color:var(--ag-muted);line-height:1.55;')}>
                Phone, email, bank account and UPI were <strong>not</strong> checked against other boutiques — migration 0106 has not been applied. The duplicates above cover only shop name, address, pincode and map pin.
              </div>
            )}
          </div>

          {groups.map((g) => (
            <div key={g.title} style={css('background:var(--ag-surface);border:1px solid var(--ag-surface-3);border-radius:18px;padding:15px 17px;')}>
              <div style={css("font-weight:700;font-size:16px;")}>{g.title}</div>
              <div style={css('margin-top:9px;display:flex;flex-direction:column;gap:7px;')}>
                {g.rows.map(([k, v]) => (
                  <div key={k} style={css('display:flex;gap:12px;align-items:baseline;')}>
                    <span style={css('flex:none;width:130px;font-size:11.5px;font-weight:700;color:var(--ag-muted);')}>{k}</span>
                    <span style={css('flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--ag-ink);word-break:break-word;')}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Decision --------------------------------------------------- */}
          {asking ? (
            <div style={css('background:var(--ag-surface);border:1px solid var(--ag-surface-3);border-radius:18px;padding:16px 17px;')}>
              <div style={css("font-weight:700;font-size:16px;")}>
                {asking === 'rejected' ? 'Reason for rejection' : 'What needs changing?'}
              </div>
              <div style={css('font-size:12px;color:var(--ag-muted);font-weight:600;margin-top:3px;')}>
                The seller sees this word for word on their verification screen.
              </div>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                autoFocus
                placeholder={asking === 'rejected'
                  ? 'We could not verify the business registration provided…'
                  : '1. The shop address does not match the map link\n2. Upload a clearer boutique logo'}
                style={css('width:100%;margin-top:11px;border:1.5px solid var(--ag-border);background:var(--ag-surface);border-radius:13px;padding:12px 14px;font-size:14px;font-weight:500;color:var(--ag-ink);box-sizing:border-box;font-family:inherit;resize:vertical;min-height:110px;')}
              />
              <div style={css('display:flex;gap:10px;margin-top:12px;')}>
                <button
                  onClick={() => { setAsking(null); setNote(''); }}
                  disabled={busy}
                  style={css('height:46px;padding:0 18px;border:1.5px solid var(--ag-border);background:var(--ag-surface);color:var(--ag-label);border-radius:13px;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;')}
                >
                  Cancel
                </button>
                <button
                  onClick={confirm}
                  disabled={busy || note.trim().length < 5}
                  style={css(`flex:1;height:46px;border:none;border-radius:13px;background:${asking === 'rejected' ? 'var(--ag-bad-text)' : 'var(--ag-gold-text)'};color:#fff;font-weight:800;font-size:14px;cursor:pointer;opacity:${busy || note.trim().length < 5 ? 0.55 : 1};font-family:inherit;`)}
                >
                  {busy ? 'Saving…' : asking === 'rejected' ? 'Reject boutique' : 'Send correction list'}
                </button>
              </div>
            </div>
          ) : (
            <div>
              {!isApproved && flags.some((f) => f.tone === 'bad') && (
                <div style={css('font-size:12px;font-weight:700;color:var(--ag-bad-text);line-height:1.55;margin-bottom:9px;')}>
                  Approving publishes this shop and all {productCount ?? 0} of its products immediately. There {flags.filter((f) => f.tone === 'bad').length === 1 ? 'is a contradiction' : 'are contradictions'} above that nobody has explained yet.
                </div>
              )}
              <div style={css('display:flex;gap:10px;flex-wrap:wrap;')}>
                <button
                  onClick={() => setAsking('rejected')}
                  style={css('flex:1;min-width:130px;height:48px;border:1.5px solid var(--ag-border);background:var(--ag-surface);color:var(--ag-bad-text);border-radius:13px;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;')}
                >
                  Reject
                </button>
                {isApproved ? (
                  // A live shop: the only forward action is to take it back down.
                  // Suspending returns it to the review queue (pending) exactly as
                  // the old Boutiques table's pause button did.
                  <button
                    onClick={() => onDecide(boutique, 'pending')}
                    style={css('flex:1;min-width:130px;height:48px;border:1.5px solid var(--ag-gold-border);background:var(--ag-surface);color:#B9862F;border-radius:13px;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;')}
                  >
                    Suspend
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => setAsking('changes_requested')}
                      style={css('flex:1;min-width:130px;height:48px;border:1.5px solid var(--ag-gold-border);background:var(--ag-surface);color:#B9862F;border-radius:13px;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;')}
                    >
                      Needs changes
                    </button>
                    <button
                      onClick={() => onDecide(boutique, 'approved')}
                      style={css('flex:1;min-width:130px;height:48px;border:none;background:var(--ag-good-text);color:#fff;border-radius:13px;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;')}
                    >
                      Approve
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

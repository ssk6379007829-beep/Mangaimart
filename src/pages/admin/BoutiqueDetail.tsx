import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { css } from '@/lib/css';
import { useShop } from '@/state/ShopContext';
import { useAsync } from '@/hooks/useAsync';
import { TONES } from '@/data/demo';
import {
  fetchAllBoutiquesAdmin, setBoutiqueStatus, fetchProductCounts,
  type AdminBoutiqueRow,
} from '@/data/boutiques';
import { BOUTIQUE_STATUS_LABEL, type BoutiqueStatus } from '@/data/types';
import { Card, Field, Icon, StatCard, T } from '@/components/admin/kit';
import { adminPath } from '@/lib/adminPath';
import { BoutiqueReviewPanel } from '@/components/admin/BoutiqueReviewPanel';

/**
 * The whole shop in one place — its history, its numbers and the controls to
 * manage it. Opened from the Boutiques list; this is what "click a boutique and
 * see everything about it" means.
 *
 * Built in tabs so each slice of the shop (its catalogue, orders, settlements,
 * reviews, settings) has room without a 560px drawer crushing it. The Overview
 * is the shop at a glance; the Application tab carries the full KYC, the
 * automatic checks, the verification call and the status decision.
 */

const STATUS_CHIP: Record<BoutiqueStatus, { bg: string; fg: string }> = {
  draft: { bg: 'var(--ag-surface-2)', fg: 'var(--ag-muted)' },
  pending: { bg: 'var(--ag-warn-bg)', fg: 'var(--ag-warn-text)' },
  changes_requested: { bg: 'var(--ag-gold-bg)', fg: 'var(--ag-gold-text)' },
  approved: { bg: 'var(--ag-good-bg)', fg: 'var(--ag-good-text)' },
  rejected: { bg: 'var(--ag-bad-bg)', fg: 'var(--ag-bad-text)' },
};

type TabKey = 'overview' | 'application';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'application', label: 'Application' },
];

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export function BoutiqueDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { showToast } = useShop();
  const [tab, setTab] = useState<TabKey>('overview');

  const { data: rows, loading, error, reload } = useAsync(() => fetchAllBoutiquesAdmin(), []);
  const all = useMemo(() => rows ?? [], [rows]);
  const boutique = useMemo(() => all.find((b) => b.id === id) ?? null, [all, id]);

  const { data: counts } = useAsync(() => fetchProductCounts([id]), [id]);
  const productCount = counts?.get(id) ?? null;

  const back = () => navigate(adminPath('boutiques'));

  const decide = async (b: AdminBoutiqueRow, status: BoutiqueStatus, note?: string) => {
    try {
      await setBoutiqueStatus(b.id, status, note);
      showToast(`${b.name} — ${BOUTIQUE_STATUS_LABEL[status].toLowerCase()}`);
      reload();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Update failed', 'error');
    }
  };

  if (loading && !boutique) {
    return <div style={css(`padding:24px;color:${T.muted};font-size:14px;`)}>Loading boutique…</div>;
  }
  if (error) {
    return (
      <div style={css('display:flex;flex-direction:column;gap:12px;')}>
        <BackLink onClick={back} />
        <div style={css('padding:20px;color:var(--ag-bad-text);font-size:13.5px;')}>Could not load this boutique — {error}</div>
      </div>
    );
  }
  if (!boutique) {
    return (
      <div style={css('display:flex;flex-direction:column;gap:12px;')}>
        <BackLink onClick={back} />
        <div style={css(`padding:20px;color:${T.muted};font-size:13.5px;`)}>That boutique no longer exists, or you cannot open it.</div>
      </div>
    );
  }

  const chip = STATUS_CHIP[boutique.status];
  const owner = boutique.owner_name || boutique.owner?.full_name || '—';

  return (
    <div style={css('display:flex;flex-direction:column;gap:16px;')}>
      <BackLink onClick={back} />

      {/* Identity header */}
      <div style={css(T.card + 'padding:18px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;')}>
        <div style={css(`width:58px;height:58px;flex:none;border-radius:16px;overflow:hidden;background:${TONES[boutique.tone ?? 0]};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:24px;color:rgba(42,26,32,.5);`)}>
          {boutique.logo_url ? <img src={boutique.logo_url} alt="" style={css('width:100%;height:100%;object-fit:cover;')} /> : boutique.name.charAt(0)}
        </div>
        <div style={css('flex:1;min-width:0;')}>
          <div style={css("font-family:var(--ag-display);font-weight:700;font-size:24px;line-height:1.15;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{boutique.name}</div>
          <div style={css(`font-size:13px;color:${T.muted};margin-top:3px;`)}>
            {owner}{boutique.city ? ` · ${boutique.city}` : ''}{boutique.category ? ` · ${boutique.category}` : ''}
          </div>
        </div>
        <span style={css(`font-size:11.5px;font-weight:800;padding:5px 12px;border-radius:9px;flex:none;background:${chip.bg};color:${chip.fg};`)}>
          {BOUTIQUE_STATUS_LABEL[boutique.status]}
        </span>
      </div>

      {/* Tabs */}
      <div style={css('display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--ag-border-soft);padding-bottom:2px;')}>
        {TABS.map((t) => {
          const on = t.key === tab;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={css(`height:38px;padding:0 15px;border:none;border-radius:11px 11px 0 0;background:transparent;color:${on ? 'var(--ag-crimson)' : T.muted};font-weight:800;font-size:13.5px;cursor:pointer;font-family:inherit;border-bottom:2.5px solid ${on ? 'var(--ag-crimson)' : 'transparent'};`)}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'overview' && (
        <div style={css('display:flex;flex-direction:column;gap:16px;')}>
          <div className="agx-adm-g4">
            <StatCard label="Products" value={productCount == null ? '—' : String(productCount)} icon="shopping_bag" tint="var(--ag-surface-2)" ic="#D6336C" />
            <StatCard label="Orders" value={String(boutique.orders_count ?? 0)} icon="receipt_long" tint="var(--ag-info-bg)" ic="var(--ag-info-text)" sub={boutique.units_sold ? `${boutique.units_sold} units` : undefined} />
            <StatCard label="Rating" value={boutique.reviews_count > 0 ? String(boutique.rating) : '—'} icon="star" tint="var(--ag-warn-bg)" ic="#E8A13C" sub={`${boutique.reviews_count} review${boutique.reviews_count === 1 ? '' : 's'}`} />
            <StatCard label="Followers" value={String(boutique.followers_count ?? 0)} icon="favorite" tint="var(--ag-good-bg)" ic="var(--ag-good-text)" />
          </div>

          <div className="agx-adm-g2">
            <Card>
              <div style={css('font-weight:800;font-size:15px;margin-bottom:6px;')}>Shop details</div>
              <Field label="Status" value={BOUTIQUE_STATUS_LABEL[boutique.status]} />
              <Field label="Owner" value={owner} />
              <Field label="Category" value={boutique.category || '—'} />
              <Field label="City" value={boutique.city || '—'} />
              <Field label="District / state" value={`${boutique.district || '—'} · ${boutique.state || '—'}`} />
              <Field label="Pincode" value={boutique.pincode || '—'} />
              <Field label="Instagram" value={boutique.instagram ? `@${boutique.instagram.replace(/^@/, '')}` : '—'} />
            </Card>

            <Card>
              <div style={css('font-weight:800;font-size:15px;margin-bottom:6px;')}>Timeline & fulfilment</div>
              <Field label="Joined" value={fmtDate(boutique.created_at)} />
              <Field label="Submitted" value={fmtDate(boutique.submitted_at)} />
              <Field label="Last reviewed" value={fmtDate(boutique.reviewed_at)} />
              <Field label="Delivery" value={boutique.delivery_available ? `${boutique.delivery_areas || 'Local'} · ₹${boutique.delivery_charge ?? 0}` : 'Store pickup only'} />
              <Field label="Dispatch" value={boutique.dispatch_days_min != null && boutique.dispatch_days_max != null ? `${boutique.dispatch_days_min}–${boutique.dispatch_days_max} days` : '—'} />
              <Field label="Return window" value={boutique.return_window_days != null ? `${boutique.return_window_days} days` : '—'} />
              <Field label="Timing" value={boutique.open_time && boutique.close_time ? `${boutique.open_time} – ${boutique.close_time}` : '—'} />
            </Card>
          </div>

          {boutique.description && (
            <Card>
              <div style={css('font-weight:800;font-size:15px;margin-bottom:6px;')}>About</div>
              <div style={css('font-size:13.5px;line-height:1.6;color:var(--ag-ink);')}>{boutique.description}</div>
            </Card>
          )}
        </div>
      )}

      {tab === 'application' && (
        <BoutiqueReviewPanel
          key={boutique.id}
          boutique={boutique}
          all={all}
          seedCount={productCount}
          onDecide={decide}
        />
      )}
    </div>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={css(`display:inline-flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;color:${T.muted};font-weight:700;font-size:13px;font-family:inherit;padding:0;width:fit-content;`)}
    >
      <Icon name="arrow_back" size={18} />
      All boutiques
    </button>
  );
}

export default BoutiqueDetail;

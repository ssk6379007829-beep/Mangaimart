import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { css } from '@/lib/css';
import { fmtInr } from '@/lib/tokens';
import { useShop } from '@/state/ShopContext';
import { useAuth } from '@/auth/AuthContext';
import { useAsync } from '@/hooks/useAsync';
import { canSeePlatformMoney } from '@/lib/staffAccess';
import { TONES } from '@/data/demo';
import {
  fetchAllBoutiquesAdmin, setBoutiqueStatus, fetchProductCounts,
  type AdminBoutiqueRow,
} from '@/data/boutiques';
import { fetchProductsAdmin, setProductStatus, type AdminProductRow } from '@/data/adminProducts';
import { fetchOrdersForBoutique } from '@/data/orders';
import { fetchPayoutSummaries, fetchBoutiquePayouts, type PayoutSummary } from '@/data/payouts';
import { BOUTIQUE_STATUS_LABEL, type BoutiqueStatus } from '@/data/types';
import { Card, EmptyState, Field, Icon, IconButton, StatCard, StatusPill, T } from '@/components/admin/kit';
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

type TabKey = 'overview' | 'products' | 'orders' | 'payouts' | 'application';

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export function BoutiqueDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { showToast } = useShop();
  const { profile } = useAuth();
  // Orders totals and settlement figures are platform money (migration 0086), so
  // those two tabs are admin-only; a staff reviewer still gets the catalogue,
  // overview and application.
  const canMoney = canSeePlatformMoney(profile?.role);
  const [tab, setTab] = useState<TabKey>('overview');

  const tabs = useMemo(() => ([
    { key: 'overview' as const, label: 'Overview' },
    { key: 'products' as const, label: 'Products' },
    ...(canMoney ? [{ key: 'orders' as const, label: 'Orders' }, { key: 'payouts' as const, label: 'Payouts' }] : []),
    { key: 'application' as const, label: 'Application' },
  ]), [canMoney]);

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
        {tabs.map((t) => {
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

      {tab === 'products' && <ProductsTab boutiqueId={boutique.id} />}

      {tab === 'orders' && canMoney && <OrdersTab boutiqueId={boutique.id} />}

      {tab === 'payouts' && canMoney && <PayoutsTab boutiqueId={boutique.id} />}

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

/** This shop's catalogue, with one-tap hide / restore moderation. */
function ProductsTab({ boutiqueId }: { boutiqueId: string }) {
  const { showToast } = useShop();
  const { data, loading, reload } = useAsync(
    () => fetchProductsAdmin({ page: 0, pageSize: 200, status: 'all', boutiqueId }),
    [boutiqueId],
  );
  const rows = data?.rows ?? [];
  const [busyId, setBusyId] = useState<string | null>(null);

  const toggle = async (p: AdminProductRow) => {
    const next = p.status === 'hidden' ? 'active' : 'hidden';
    setBusyId(p.id);
    try {
      await setProductStatus(p.id, next);
      showToast(next === 'hidden' ? `${p.title} hidden` : `${p.title} restored`);
      reload();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not update', 'error');
    } finally {
      setBusyId(null);
    }
  };

  if (loading && rows.length === 0) return <div style={css(`padding:18px;color:${T.muted};font-size:13.5px;`)}>Loading products…</div>;
  if (rows.length === 0) return <Card><EmptyState icon="shopping_bag" title="No products" sub="This shop has not listed anything yet." /></Card>;

  return (
    <div style={css('display:flex;flex-direction:column;gap:10px;')}>
      {rows.map((p) => (
        <div key={p.id} style={css(T.card + `padding:12px 14px;display:flex;align-items:center;gap:13px;${p.status === 'hidden' ? 'opacity:.62;' : ''}`)}>
          <div style={css(`width:46px;height:46px;flex:none;border-radius:11px;overflow:hidden;background:${TONES[p.tone % TONES.length]};`)}>
            {p.image_url && <img src={p.image_url} alt="" style={css('width:100%;height:100%;object-fit:cover;')} />}
          </div>
          <div style={css('flex:1;min-width:0;')}>
            <div style={css('font-weight:700;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;')}>{p.title}</div>
            <div style={css(`font-size:11.5px;color:${T.muted};`)}>{p.category || '—'} · stock {p.stock}</div>
          </div>
          <span style={css('font-weight:800;font-size:13px;font-variant-numeric:tabular-nums;')}>{fmtInr(p.price)}</span>
          <StatusPill status={p.status} />
          <IconButton
            icon={p.status === 'hidden' ? 'visibility' : 'visibility_off'}
            title={p.status === 'hidden' ? 'Restore to the storefront' : 'Hide from the storefront'}
            onClick={() => { if (busyId !== p.id) void toggle(p); }}
          />
        </div>
      ))}
    </div>
  );
}

/** This shop's orders — its fulfilment history (admin only). */
function OrdersTab({ boutiqueId }: { boutiqueId: string }) {
  const { data, loading } = useAsync(() => fetchOrdersForBoutique(boutiqueId), [boutiqueId]);
  const orders = data ?? [];

  if (loading && orders.length === 0) return <div style={css(`padding:18px;color:${T.muted};font-size:13.5px;`)}>Loading orders…</div>;
  if (orders.length === 0) return <Card><EmptyState icon="receipt_long" title="No orders" sub="This shop has not taken any orders yet." /></Card>;

  return (
    <div style={css('display:flex;flex-direction:column;gap:10px;')}>
      {orders.map((o) => (
        <div key={o.id} style={css(T.card + 'padding:13px 15px;display:flex;align-items:center;gap:13px;')}>
          <div style={css('flex:1;min-width:0;')}>
            <div style={css('font-weight:700;font-size:13.5px;')}>{o.order_number}</div>
            <div style={css(`font-size:11.5px;color:${T.muted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`)}>
              {o.buyer?.full_name ?? o.guest_name ?? 'Guest'} · {o.items?.length ?? 0} item{(o.items?.length ?? 0) === 1 ? '' : 's'} · {new Date(o.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
            </div>
          </div>
          <StatusPill status={o.refunded ? 'refunded' : o.status} />
          <span style={css('font-weight:800;font-size:13.5px;font-variant-numeric:tabular-nums;')}>{fmtInr(o.total)}</span>
        </div>
      ))}
    </div>
  );
}

/** What this shop has earned and what it has been paid (admin only). */
function PayoutsTab({ boutiqueId }: { boutiqueId: string }) {
  const { data: summaries, loading: loadingSummary } = useAsync(() => fetchPayoutSummaries(), []);
  const { data: history, loading: loadingHistory } = useAsync(() => fetchBoutiquePayouts(boutiqueId), [boutiqueId]);
  const summary: PayoutSummary | undefined = (summaries ?? []).find((s) => s.boutique_id === boutiqueId);
  const payouts = history ?? [];

  return (
    <div style={css('display:flex;flex-direction:column;gap:16px;')}>
      <div className="agx-adm-g4">
        <StatCard label="Awaiting settlement" value={summary ? String(summary.orders) : '0'} icon="pending_actions" tint="var(--ag-warn-bg)" ic="var(--ag-gold-text)" sub="delivered orders" />
        <StatCard label="Goods owed" value={fmtInr(summary?.prepaidGoods ?? 0)} icon="inventory_2" tint="var(--ag-surface-2)" ic="#D6336C" />
        <StatCard label="Commission" value={fmtInr(summary?.prepaidCommission ?? 0)} icon="percent" tint="var(--ag-info-bg)" ic="var(--ag-info-text)" />
        <StatCard label="Net payable now" value={fmtInr(summary?.net ?? 0)} icon="account_balance" tint="var(--ag-good-bg)" ic="var(--ag-good-text)" sub={summary?.heldValue ? `${fmtInr(summary.heldValue)} held` : undefined} />
      </div>

      <div>
        <div style={css('font-weight:800;font-size:15px;margin-bottom:10px;')}>Settlement history</div>
        {loadingHistory && payouts.length === 0 ? (
          <div style={css(`padding:14px;color:${T.muted};font-size:13.5px;`)}>Loading payouts…</div>
        ) : payouts.length === 0 ? (
          <Card><EmptyState icon="account_balance" title="No payouts yet" sub={loadingSummary ? 'Checking the current balance…' : 'This shop has not been settled yet.'} /></Card>
        ) : (
          <div style={css('display:flex;flex-direction:column;gap:10px;')}>
            {payouts.map((p) => (
              <div key={p.id} style={css(T.card + 'padding:13px 15px;display:flex;align-items:center;gap:13px;')}>
                <div style={css('flex:1;min-width:0;')}>
                  <div style={css('font-weight:700;font-size:13.5px;')}>{fmtInr(p.amount)} · {p.orders_count} order{p.orders_count === 1 ? '' : 's'}</div>
                  <div style={css(`font-size:11.5px;color:${T.muted};`)}>
                    {new Date(p.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} · {p.provider === 'razorpayx' ? 'RazorpayX' : 'Manual'}{p.utr ? ` · UTR ${p.utr}` : ''}
                  </div>
                </div>
                <StatusPill status={p.status === 'paid' ? 'paid' : p.status === 'failed' ? 'failed' : 'pending'} label={p.status} />
              </div>
            ))}
          </div>
        )}
      </div>
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

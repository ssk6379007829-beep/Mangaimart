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
  fetchAllBoutiquesAdmin, setBoutiqueStatus, fetchProductCounts, updateBoutique,
  type AdminBoutiqueRow, type BoutiquePatch,
} from '@/data/boutiques';
import { fetchProductsAdmin, setProductStatus, type AdminProductRow } from '@/data/adminProducts';
import { fetchOrdersForBoutique, fetchCustomersForBoutique } from '@/data/orders';
import { fetchReviewsForBoutique } from '@/data/reviews';
import { fetchReturnsForBoutique } from '@/data/returns';
import { fetchActivityForEntity } from '@/data/activityLog';
import { fetchPayoutSummaries, fetchBoutiquePayouts, settlePayout, type PayoutSummary } from '@/data/payouts';
import { BOUTIQUE_STATUS_LABEL, type BoutiqueStatus } from '@/data/types';
import { Avatar, Card, ConfirmDialog, EmptyState, Field, GhostButton, Icon, IconButton, StatCard, StatusPill, T, Toggle } from '@/components/admin/kit';
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

type TabKey = 'overview' | 'products' | 'orders' | 'customers' | 'payouts' | 'reviews' | 'delivery' | 'activity' | 'application';

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
    ...(canMoney ? [
      { key: 'orders' as const, label: 'Orders' },
      { key: 'customers' as const, label: 'Customers' },
      { key: 'payouts' as const, label: 'Payouts' },
    ] : []),
    { key: 'reviews' as const, label: 'Reviews & Returns' },
    ...(canMoney ? [{ key: 'delivery' as const, label: 'Delivery' }, { key: 'activity' as const, label: 'Activity' }] : []),
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
            <DetailsCard boutique={boutique} editable={canMoney} onSaved={reload} />

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

      {tab === 'customers' && canMoney && <CustomersTab boutiqueId={boutique.id} />}

      {tab === 'payouts' && canMoney && <PayoutsTab boutiqueId={boutique.id} />}

      {tab === 'reviews' && <ReviewsReturnsTab boutiqueId={boutique.id} canReturns={canMoney} />}

      {tab === 'delivery' && canMoney && <DeliveryTab boutique={boutique} onSaved={reload} />}

      {tab === 'activity' && canMoney && <ActivityTab boutique={boutique} />}

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
  const navigate = useNavigate();
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
        <div
          key={p.id}
          className="agx-adm-row" data-clickable="true"
          onClick={() => navigate(adminPath(`products/${p.id}`), { state: { product: p } })}
          style={css(T.card + `padding:12px 14px;display:flex;align-items:center;gap:13px;cursor:pointer;${p.status === 'hidden' ? 'opacity:.62;' : ''}`)}
        >
          <div style={css(`width:46px;height:46px;flex:none;border-radius:11px;overflow:hidden;background:${TONES[p.tone % TONES.length]};`)}>
            {p.image_url && <img src={p.image_url} alt="" style={css('width:100%;height:100%;object-fit:cover;')} />}
          </div>
          <div style={css('flex:1;min-width:0;')}>
            <div style={css('font-weight:700;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;')}>{p.title}</div>
            <div style={css(`font-size:11.5px;color:${T.muted};`)}>{p.category || '—'} · stock {p.stock}</div>
          </div>
          <span style={css('font-weight:800;font-size:13px;font-variant-numeric:tabular-nums;')}>{fmtInr(p.price)}</span>
          <StatusPill status={p.status} />
          <span onClick={(e) => e.stopPropagation()} style={css('display:flex;')}>
            <IconButton
              icon={p.status === 'hidden' ? 'visibility' : 'visibility_off'}
              title={p.status === 'hidden' ? 'Restore to the storefront' : 'Hide from the storefront'}
              onClick={() => { if (busyId !== p.id) void toggle(p); }}
            />
          </span>
        </div>
      ))}
    </div>
  );
}

/** This shop's orders — its fulfilment history (admin only). */
function OrdersTab({ boutiqueId }: { boutiqueId: string }) {
  const navigate = useNavigate();
  const { data, loading } = useAsync(() => fetchOrdersForBoutique(boutiqueId), [boutiqueId]);
  const orders = data ?? [];

  if (loading && orders.length === 0) return <div style={css(`padding:18px;color:${T.muted};font-size:13.5px;`)}>Loading orders…</div>;
  if (orders.length === 0) return <Card><EmptyState icon="receipt_long" title="No orders" sub="This shop has not taken any orders yet." /></Card>;

  return (
    <div style={css('display:flex;flex-direction:column;gap:10px;')}>
      {orders.map((o) => (
        <div
          key={o.id}
          className="agx-adm-row" data-clickable="true"
          onClick={() => navigate(adminPath(`orders/${o.id}`))}
          style={css(T.card + 'padding:13px 15px;display:flex;align-items:center;gap:13px;cursor:pointer;')}
        >
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
  const { showToast } = useShop();
  const [refreshKey, setRefreshKey] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data: summaries, loading: loadingSummary } = useAsync(() => fetchPayoutSummaries(), [refreshKey]);
  const { data: history, loading: loadingHistory } = useAsync(() => fetchBoutiquePayouts(boutiqueId), [boutiqueId, refreshKey]);
  const summary: PayoutSummary | undefined = (summaries ?? []).find((s) => s.boutique_id === boutiqueId);
  const payouts = history ?? [];

  // Settling records a payout for the delivered, not-yet-settled balance. The
  // Payouts page remains the place to send payout advice / run RazorpayX; this
  // is the quick "mark it paid" an admin wants while looking at the shop.
  const settle = async () => {
    setBusy(true);
    try {
      const rec = await settlePayout(boutiqueId);
      showToast(`Settled ${fmtInr(rec.amount)} to ${rec.boutique?.name ?? 'the shop'}`);
      setConfirming(false);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not settle', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={css('display:flex;flex-direction:column;gap:16px;')}>
      <div className="agx-adm-g4">
        <StatCard label="Awaiting settlement" value={summary ? String(summary.orders) : '0'} icon="pending_actions" tint="var(--ag-warn-bg)" ic="var(--ag-gold-text)" sub="delivered orders" />
        <StatCard label="Goods owed" value={fmtInr(summary?.prepaidGoods ?? 0)} icon="inventory_2" tint="var(--ag-surface-2)" ic="#D6336C" />
        <StatCard label="Commission" value={fmtInr(summary?.prepaidCommission ?? 0)} icon="percent" tint="var(--ag-info-bg)" ic="var(--ag-info-text)" />
        <StatCard label="Net payable now" value={fmtInr(summary?.net ?? 0)} icon="account_balance" tint="var(--ag-good-bg)" ic="var(--ag-good-text)" sub={summary?.heldValue ? `${fmtInr(summary.heldValue)} held` : undefined} />
      </div>

      {summary && summary.net > 0 && (
        <div>
          <GhostButton tone="primary" icon="payments" onClick={() => setConfirming(true)}>
            Settle {fmtInr(summary.net)} now
          </GhostButton>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title="Settle this payout?"
        message={`Record a payout of ${fmtInr(summary?.net ?? 0)} for ${summary?.orders ?? 0} delivered order${summary?.orders === 1 ? '' : 's'}. This marks them settled and moves the balance to the shop's payout history. Send the payout advice from the Payouts page.`}
        confirmLabel="Settle now"
        busy={busy}
        onConfirm={() => void settle()}
        onCancel={() => setConfirming(false)}
      />

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

/** Who buys from this shop, by lifetime spend (admin only). A registered buyer
 *  opens their account page; a guest has no account to open. */
function CustomersTab({ boutiqueId }: { boutiqueId: string }) {
  const navigate = useNavigate();
  const { data, loading } = useAsync(() => fetchCustomersForBoutique(boutiqueId), [boutiqueId]);
  const customers = [...(data ?? [])].sort((a, b) => b.spent - a.spent);

  if (loading && customers.length === 0) return <div style={css(`padding:18px;color:${T.muted};font-size:13.5px;`)}>Loading customers…</div>;
  if (customers.length === 0) return <Card><EmptyState icon="diversity_3" title="No customers yet" sub="Buyers of this shop will appear here." /></Card>;

  return (
    <div style={css('display:flex;flex-direction:column;gap:10px;')}>
      {customers.map((c) => {
        const registered = !c.buyer_id.startsWith('guest:');
        return (
          <div
            key={c.buyer_id}
            className={registered ? 'agx-adm-row' : undefined}
            data-clickable={registered ? 'true' : undefined}
            onClick={registered ? () => navigate(adminPath(`users/${c.buyer_id}`)) : undefined}
            style={css(T.card + `padding:12px 15px;display:flex;align-items:center;gap:13px;${registered ? 'cursor:pointer;' : ''}`)}
          >
            <Avatar name={c.name} tone={c.tone} />
            <div style={css('flex:1;min-width:0;')}>
              <div style={css('font-weight:700;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;')}>{c.name}{registered ? '' : ' · guest'}</div>
              <div style={css(`font-size:11.5px;color:${T.muted};`)}>{c.city || '—'} · {c.orders} order{c.orders === 1 ? '' : 's'}</div>
            </div>
            <span style={css('font-weight:800;font-size:13.5px;font-variant-numeric:tabular-nums;color:var(--ag-crimson);')}>{fmtInr(c.spent)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The shop's descriptive details — read-only, with an admin edit mode for the
 *  correction fields. The name/slug are deliberately NOT editable here: they
 *  drive the storefront URL and SEO, and the seller owns them. */
function DetailsCard({ boutique, editable, onSaved }: { boutique: AdminBoutiqueRow; editable: boolean; onSaved: () => void }) {
  const { showToast } = useShop();
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ownerName, setOwnerName] = useState(boutique.owner_name ?? '');
  const [category, setCategory] = useState(boutique.category ?? '');
  const [description, setDescription] = useState(boutique.description ?? '');
  const [area, setArea] = useState(boutique.area ?? '');
  const [city, setCity] = useState(boutique.city ?? '');
  const [district, setDistrict] = useState(boutique.district ?? '');
  const [stateName, setStateName] = useState(boutique.state ?? '');
  const [pincode, setPincode] = useState(boutique.pincode ?? '');
  const [instagram, setInstagram] = useState(boutique.instagram ?? '');

  const owner = boutique.owner_name || boutique.owner?.full_name || '—';

  const save = async () => {
    setBusy(true);
    try {
      await updateBoutique(boutique.id, {
        owner_name: ownerName.trim(),
        category: category.trim(),
        description: description.trim(),
        area: area.trim(),
        city: city.trim(),
        district: district.trim(),
        state: stateName.trim(),
        pincode: pincode.trim(),
        instagram: instagram.trim() || null,
      });
      showToast('Shop details updated');
      setEdit(false);
      onSaved();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save', 'error');
    } finally {
      setBusy(false);
    }
  };

  const label = css('font-size:12px;font-weight:700;color:var(--ag-label);display:block;margin-top:12px;');
  const field = css('width:100%;margin-top:5px;border:1.5px solid var(--ag-border);background:var(--ag-surface);border-radius:11px;padding:0 12px;height:40px;font-size:13.5px;font-weight:600;color:var(--ag-ink);font-family:inherit;box-sizing:border-box;');

  if (edit) {
    return (
      <Card>
        <div style={css('display:flex;align-items:center;justify-content:space-between;gap:10px;')}>
          <div style={css('font-weight:800;font-size:15px;')}>Edit shop details</div>
        </div>
        <label style={label}>Owner name<input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} style={field} /></label>
        <label style={label}>Category<input value={category} onChange={(e) => setCategory(e.target.value)} style={field} /></label>
        <label style={label}>Bio<textarea value={description} onChange={(e) => setDescription(e.target.value)} style={css(field + 'height:72px;padding:9px 12px;resize:vertical;')} /></label>
        <div className="agx-adm-g2">
          <label style={label}>Area<input value={area} onChange={(e) => setArea(e.target.value)} style={field} /></label>
          <label style={label}>City<input value={city} onChange={(e) => setCity(e.target.value)} style={field} /></label>
          <label style={label}>District<input value={district} onChange={(e) => setDistrict(e.target.value)} style={field} /></label>
          <label style={label}>State<input value={stateName} onChange={(e) => setStateName(e.target.value)} style={field} /></label>
          <label style={label}>Pincode<input value={pincode} onChange={(e) => setPincode(e.target.value)} style={field} /></label>
          <label style={label}>Instagram handle<input value={instagram} onChange={(e) => setInstagram(e.target.value)} style={field} /></label>
        </div>
        <div style={css('display:flex;gap:10px;margin-top:16px;')}>
          <GhostButton onClick={() => setEdit(false)}>Cancel</GhostButton>
          <GhostButton tone="primary" icon="save" onClick={() => { if (!busy) void save(); }}>{busy ? 'Saving…' : 'Save'}</GhostButton>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div style={css('display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;')}>
        <div style={css('font-weight:800;font-size:15px;')}>Shop details</div>
        {editable && <IconButton icon="edit" title="Edit shop details" onClick={() => setEdit(true)} />}
      </div>
      <Field label="Status" value={BOUTIQUE_STATUS_LABEL[boutique.status]} />
      <Field label="Owner" value={owner} />
      <Field label="Category" value={boutique.category || '—'} />
      <Field label="City" value={boutique.city || '—'} />
      <Field label="District / state" value={`${boutique.district || '—'} · ${boutique.state || '—'}`} />
      <Field label="Pincode" value={boutique.pincode || '—'} />
      <Field label="Instagram" value={boutique.instagram ? `@${boutique.instagram.replace(/^@/, '')}` : '—'} />
    </Card>
  );
}

function Stars({ n }: { n: number }) {
  return (
    <span style={css('display:inline-flex;gap:1px;')} aria-label={`${n} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => <Icon key={i} name="star" size={14} color={i <= n ? '#E8A13C' : 'var(--ag-border)'} />)}
    </span>
  );
}

/** The shop's public reviews (read-only) and any return requests against it. */
function ReviewsReturnsTab({ boutiqueId, canReturns }: { boutiqueId: string; canReturns: boolean }) {
  const { data: reviews, loading } = useAsync(() => fetchReviewsForBoutique(boutiqueId), [boutiqueId]);
  const { data: returns } = useAsync(
    () => (canReturns ? fetchReturnsForBoutique(boutiqueId) : Promise.resolve([])),
    [boutiqueId, canReturns],
  );
  const rv = reviews ?? [];
  const rt = returns ?? [];

  return (
    <div style={css('display:flex;flex-direction:column;gap:16px;')}>
      {canReturns && rt.length > 0 && (
        <div>
          <div style={css('font-weight:800;font-size:15px;margin-bottom:10px;')}>Return requests</div>
          <div style={css('display:flex;flex-direction:column;gap:10px;')}>
            {rt.map((r) => (
              <div key={r.id} style={css(T.card + 'padding:13px 15px;display:flex;align-items:center;gap:13px;')}>
                <div style={css('flex:1;min-width:0;')}>
                  <div style={css('font-weight:700;font-size:13px;text-transform:capitalize;')}>{r.reason.replace(/_/g, ' ')}</div>
                  {r.note && <div style={css(`font-size:12px;color:${T.muted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`)}>{r.note}</div>}
                </div>
                <StatusPill status={r.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div style={css('display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;flex-wrap:wrap;')}>
          <div style={css('font-weight:800;font-size:15px;')}>Reviews</div>
          <a href={adminPath('reviews')} style={css('font-size:12.5px;font-weight:700;color:var(--ag-crimson);text-decoration:none;')}>Moderate in Reviews →</a>
        </div>
        {loading && rv.length === 0 ? (
          <div style={css(`padding:14px;color:${T.muted};font-size:13.5px;`)}>Loading reviews…</div>
        ) : rv.length === 0 ? (
          <Card><EmptyState icon="reviews" title="No reviews yet" sub="Buyer reviews for this shop will appear here." /></Card>
        ) : (
          <div style={css('display:flex;flex-direction:column;gap:12px;')}>
            {rv.map((r) => (
              <div key={r.id} style={css(T.card + 'padding:15px 17px;')}>
                <div style={css('display:flex;align-items:center;gap:10px;flex-wrap:wrap;')}>
                  <Stars n={r.rating} />
                  <span style={css('font-weight:700;font-size:13px;')}>{r.author_name ?? 'Anonymous'}</span>
                  {r.verified_purchase && <span style={css('font-size:10.5px;font-weight:800;color:var(--ag-good-text);background:var(--ag-good-bg);padding:2px 7px;border-radius:6px;')}>Verified</span>}
                  <span style={css(`font-size:11.5px;color:${T.muted};`)}>· {r.product_title ?? 'Product'}</span>
                </div>
                {r.body && <div style={css('font-size:13.5px;line-height:1.55;margin-top:8px;color:var(--ag-ink);')}>{r.body}</div>}
                {r.seller_reply && (
                  <div style={css('margin-top:10px;padding:10px 12px;background:var(--ag-surface-2);border-radius:10px;')}>
                    <div style={css(`font-size:10.5px;font-weight:800;color:${T.muted};text-transform:uppercase;letter-spacing:.04em;`)}>Seller reply</div>
                    <div style={css('font-size:12.5px;margin-top:3px;')}>{r.seller_reply}</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Editable delivery & fulfilment terms — the seller's own (0076–0078), which
 *  the admin can correct here. NULL in a zone band means the shop does not
 *  deliver there. */
function DeliveryTab({ boutique, onSaved }: { boutique: AdminBoutiqueRow; onSaved: () => void }) {
  const { showToast } = useShop();
  const [available, setAvailable] = useState(!!boutique.delivery_available);
  const [areas, setAreas] = useState(boutique.delivery_areas ?? '');
  const [local, setLocal] = useState<string>(String(boutique.delivery_charge ?? 0));
  const [district, setDistrict] = useState<string>(boutique.delivery_charge_district?.toString() ?? '');
  const [stateRate, setStateRate] = useState<string>(boutique.delivery_charge_state?.toString() ?? '');
  const [national, setNational] = useState<string>(boutique.delivery_charge_national?.toString() ?? '');
  const [freeOver, setFreeOver] = useState<string>(String(boutique.free_delivery_over ?? 0));
  const [dispatchMin, setDispatchMin] = useState<string>(String(boutique.dispatch_days_min ?? 1));
  const [dispatchMax, setDispatchMax] = useState<string>(String(boutique.dispatch_days_max ?? 3));
  const [returnDays, setReturnDays] = useState<string>(String(boutique.return_window_days ?? 0));
  const [busy, setBusy] = useState(false);

  const num = (v: string): number => Math.max(0, Math.round(Number(v) || 0));
  const numOrNull = (v: string): number | null => (v.trim() === '' ? null : num(v));

  const save = async () => {
    setBusy(true);
    const patch: BoutiquePatch = {
      delivery_available: available,
      delivery_areas: areas.trim(),
      delivery_charge: num(local),
      delivery_charge_district: numOrNull(district),
      delivery_charge_state: numOrNull(stateRate),
      delivery_charge_national: numOrNull(national),
      free_delivery_over: num(freeOver),
      dispatch_days_min: num(dispatchMin),
      dispatch_days_max: num(dispatchMax),
      return_window_days: num(returnDays),
    };
    try {
      await updateBoutique(boutique.id, patch);
      showToast('Delivery terms updated');
      onSaved();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save', 'error');
    } finally {
      setBusy(false);
    }
  };

  const label = css('font-size:12px;font-weight:700;color:var(--ag-label);display:block;margin-top:14px;');
  const field = css('width:100%;margin-top:6px;border:1.5px solid var(--ag-border);background:var(--ag-surface);border-radius:11px;padding:0 13px;height:42px;font-size:14px;font-weight:600;color:var(--ag-ink);font-family:inherit;box-sizing:border-box;font-variant-numeric:tabular-nums;');

  return (
    <div style={css('max-width:620px;display:flex;flex-direction:column;gap:16px;')}>
      <Card>
        <div style={css('display:flex;align-items:center;justify-content:space-between;gap:12px;')}>
          <div>
            <div style={css('font-weight:800;font-size:15px;')}>Delivery</div>
            <div style={css(`font-size:12px;color:${T.muted};margin-top:2px;`)}>The shop's own charges, priced by distance. Leave a band blank if the shop doesn't deliver there.</div>
          </div>
          <Toggle on={available} onChange={setAvailable} label="Delivery available" />
        </div>

        {available && (
          <>
            <label style={label}>Delivery areas (free text)
              <input value={areas} onChange={(e) => setAreas(e.target.value)} placeholder="e.g. Coimbatore city" style={field} />
            </label>
            <div className="agx-adm-g2">
              <label style={label}>Local charge (₹)
                <input inputMode="numeric" value={local} onChange={(e) => setLocal(e.target.value)} style={field} />
              </label>
              <label style={label}>Free delivery over (₹, local + district)
                <input inputMode="numeric" value={freeOver} onChange={(e) => setFreeOver(e.target.value)} style={field} />
              </label>
              <label style={label}>Same district (₹)
                <input inputMode="numeric" value={district} onChange={(e) => setDistrict(e.target.value)} placeholder="blank = no delivery" style={field} />
              </label>
              <label style={label}>Same state (₹)
                <input inputMode="numeric" value={stateRate} onChange={(e) => setStateRate(e.target.value)} placeholder="blank = no delivery" style={field} />
              </label>
              <label style={label}>Rest of India (₹)
                <input inputMode="numeric" value={national} onChange={(e) => setNational(e.target.value)} placeholder="blank = no delivery" style={field} />
              </label>
            </div>
          </>
        )}
      </Card>

      <Card>
        <div style={css('font-weight:800;font-size:15px;')}>Dispatch & returns</div>
        <div className="agx-adm-g2">
          <label style={label}>Dispatch min (days)
            <input inputMode="numeric" value={dispatchMin} onChange={(e) => setDispatchMin(e.target.value)} style={field} />
          </label>
          <label style={label}>Dispatch max (days)
            <input inputMode="numeric" value={dispatchMax} onChange={(e) => setDispatchMax(e.target.value)} style={field} />
          </label>
          <label style={label}>Change-of-mind return window (days)
            <input inputMode="numeric" value={returnDays} onChange={(e) => setReturnDays(e.target.value)} style={field} />
          </label>
        </div>
        <div style={css(`font-size:11.5px;color:${T.muted};margin-top:10px;line-height:1.5;`)}>
          The platform's own 30-day cover for a faulty item is separate and always applies — this is only the shop's change-of-mind window.
        </div>
      </Card>

      <div>
        <GhostButton tone="primary" icon="save" onClick={() => { if (!busy) void save(); }}>
          {busy ? 'Saving…' : 'Save delivery terms'}
        </GhostButton>
      </div>
    </div>
  );
}

/** A plain history of what has happened to this shop. */
function ActivityTab({ boutique }: { boutique: AdminBoutiqueRow }) {
  const { data: log } = useAsync(() => fetchActivityForEntity('boutique', boutique.id), [boutique.id]);

  const events = useMemo(() => {
    const out: { at: string; label: string; icon: string }[] = [];
    if (boutique.created_at) out.push({ at: boutique.created_at, label: 'Joined MangaiMart', icon: 'person_add' });
    if (boutique.submitted_at) out.push({ at: boutique.submitted_at, label: 'Submitted for review', icon: 'send' });
    if (boutique.reviewed_at) out.push({ at: boutique.reviewed_at, label: `Reviewed → ${BOUTIQUE_STATUS_LABEL[boutique.status]}`, icon: 'verified' });
    for (const a of log ?? []) {
      out.push({ at: a.created_at, label: `${a.action.replace(/[._]/g, ' ')} · ${a.actor_name}`, icon: 'history' });
    }
    return out.sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());
  }, [boutique, log]);

  if (events.length === 0) return <Card><EmptyState icon="history" title="No activity" sub="Nothing has been recorded for this shop yet." /></Card>;

  return (
    <Card>
      <div style={css('display:flex;flex-direction:column;gap:2px;')}>
        {events.map((e, i) => (
          <div key={i} style={css(`display:flex;align-items:flex-start;gap:12px;padding:11px 0;${i > 0 ? 'border-top:1px solid var(--ag-border-soft);' : ''}`)}>
            <span style={css(`width:32px;height:32px;flex:none;border-radius:10px;background:var(--ag-surface-2);display:flex;align-items:center;justify-content:center;color:var(--ag-crimson);`)}>
              <Icon name={e.icon} size={17} />
            </span>
            <div style={css('flex:1;min-width:0;')}>
              <div style={css('font-size:13px;font-weight:700;text-transform:capitalize;')}>{e.label}</div>
              <div style={css(`font-size:11.5px;color:${T.muted};`)}>{new Date(e.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
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

import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { css } from '@/lib/css';
import { useShop } from '@/state/ShopContext';
import { useAuth } from '@/auth/AuthContext';
import { useAsync } from '@/hooks/useAsync';
import { canSeePlatformMoney } from '@/lib/staffAccess';
import { logAdminAction } from '@/data/activityLog';
import { fetchOrder, updateOrderStatus } from '@/data/orders';
import { refundOrder, clearLegacyRefundFlag, buyerPaid } from '@/data/admin';
import type { OrderWithDetails } from '@/data/types';
import { Avatar, GhostButton, Icon, StatusPill, STICKY_HEADER, T } from '@/components/admin/kit';
import { adminPath } from '@/lib/adminPath';
import { OrderDetail } from '@/pages/admin/OrdersAdmin';

/**
 * One order, full-page — the fulfilment timeline, customer, items and payment
 * that the drawer used to hold, plus the manage actions (status, cancel, refund)
 * in a sticky header. Opened from the Orders list.
 *
 * Cancelling and refunding are money going back out, so they stay admin-only
 * (`canSeePlatformMoney`); the server re-checks via `staff_set_order_status` and
 * the missing staff UPDATE policy on `orders` (migration 0086). Status is patched
 * locally after each action so the page stays correct even for a staff caller
 * whose direct re-read of the order returns nothing.
 */
export function OrderDetailPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { showToast } = useShop();
  const { profile } = useAuth();
  const canAct = canSeePlatformMoney(profile?.role);

  const seed = (location.state as { order?: OrderWithDetails } | null)?.order;
  const [order, setOrder] = useState<OrderWithDetails | null>(seed?.id === id ? seed : null);
  const { data: fetched, loading } = useAsync(() => fetchOrder(id), [id]);
  useEffect(() => { if (fetched) setOrder(fetched); }, [fetched]);

  const [busyRefund, setBusyRefund] = useState(false);

  const back = () => navigate(adminPath('orders'));
  const log = (action: string, meta?: Record<string, unknown>) =>
    logAdminAction({ actor_id: profile?.id, actor_name: profile?.full_name ?? 'Admin', action, entity_type: 'order', entity_id: id, meta });

  const setStatusFor = async (next: OrderWithDetails['status']) => {
    if (!order) return;
    try {
      await updateOrderStatus(order.id, next);
      await log(`order.${next}`, { order: order.order_number });
      showToast(`${order.order_number} → ${next}`);
      setOrder((p) => (p ? { ...p, status: next } : p));
    } catch (e) { showToast(e instanceof Error ? e.message : 'Update failed', 'error'); }
  };

  const refund = async () => {
    if (!order || busyRefund) return;
    setBusyRefund(true);
    const res = await refundOrder(order.id, 'Refunded from the Orders console');
    setBusyRefund(false);
    if (!res.ok) { showToast(res.error ?? 'Refund failed', 'error'); return; }
    await log('order.refund', {
      order: order.order_number,
      amount: buyerPaid({ total: order.total, shipping_fee: order.shipping_fee ?? 0, platform_discount: order.platform_discount ?? 0 }),
      refund_id: res.refundId,
    });
    showToast(`${order.order_number} refunded`);
    setOrder((p) => (p ? { ...p, refunded: true, refund_id: res.refundId ?? null } : p));
  };

  const clearFlag = async () => {
    if (!order || busyRefund) return;
    setBusyRefund(true);
    const res = await clearLegacyRefundFlag(order.id);
    setBusyRefund(false);
    if (!res.ok) { showToast(res.error ?? 'Update failed', 'error'); return; }
    await log('order.unrefund', { order: order.order_number });
    showToast(`${order.order_number} refund flag cleared`);
    setOrder((p) => (p ? { ...p, refunded: false, refund_id: null } : p));
  };

  if (loading && !order) return <div style={css(`padding:24px;color:${T.muted};font-size:14px;`)}>Loading order…</div>;
  if (!order) {
    return (
      <Shell onBack={back}><div style={css(`padding:20px;color:${T.muted};font-size:13.5px;`)}>That order could not be opened.</div></Shell>
    );
  }

  const name = order.buyer?.full_name ?? order.guest_name ?? 'Guest';

  return (
    <Shell onBack={back}>
      <div style={css(T.card + STICKY_HEADER)}>
        <div style={css('display:flex;align-items:center;gap:14px;flex-wrap:wrap;')}>
          <Avatar name={name} tone={name.charCodeAt(0) % 8} />
          <div style={css('flex:1;min-width:0;')}>
            <div style={css("font-family:var(--ag-display);font-weight:700;font-size:22px;line-height:1.15;")}>{order.order_number}</div>
            <div style={css(`font-size:13px;color:${T.muted};margin-top:2px;`)}>
              {order.buyer_id
                ? <CrossLink onClick={() => navigate(adminPath(`users/${order.buyer_id}`))}>{name}</CrossLink>
                : name}
              {' · '}
              {order.boutique_id
                ? <CrossLink onClick={() => navigate(adminPath(`boutiques/${order.boutique_id}`))}>{order.boutique?.name ?? '—'}</CrossLink>
                : (order.boutique?.name ?? '—')}
              {' · '}{new Date(order.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
            </div>
          </div>
          <StatusPill status={order.status} />
          {order.refunded && <StatusPill status="refunded" label="Refunded" />}
        </div>
        {canAct && (
          <div style={css('display:flex;gap:9px;flex-wrap:wrap;')}>
            {order.status !== 'rejected' && (
              <GhostButton icon="cancel" tone="danger" onClick={() => void setStatusFor('rejected')}>Cancel order</GhostButton>
            )}
            {!order.refunded && (
              <GhostButton icon="currency_rupee" tone="primary" disabled={busyRefund} onClick={() => void refund()}>
                {busyRefund ? 'Refunding…' : 'Refund buyer'}
              </GhostButton>
            )}
            {order.refunded && !order.refund_id && (
              <GhostButton icon="undo" disabled={busyRefund} onClick={() => void clearFlag()}>Clear refund flag</GhostButton>
            )}
          </div>
        )}
      </div>

      <OrderDetail o={order} onSetStatus={(s) => void setStatusFor(s)} />
    </Shell>
  );
}

/** An inline link to another admin entity's page. */
function CrossLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={css('background:none;border:none;padding:0;cursor:pointer;font:inherit;color:var(--ag-crimson);font-weight:700;text-decoration:underline;text-underline-offset:2px;')}>
      {children}
    </button>
  );
}

function Shell({ onBack, children }: { onBack: () => void; children: React.ReactNode }) {
  return (
    <div style={css('display:flex;flex-direction:column;gap:16px;')}>
      <button onClick={onBack} style={css(`display:inline-flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;color:${T.muted};font-weight:700;font-size:13px;font-family:inherit;padding:0;width:fit-content;`)}>
        <Icon name="arrow_back" size={18} /> All orders
      </button>
      {children}
    </div>
  );
}

export default OrderDetailPage;

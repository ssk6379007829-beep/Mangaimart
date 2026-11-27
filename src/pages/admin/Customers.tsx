import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { css } from '@/lib/css';
import { fmtInr } from '@/lib/tokens';
import { useAuth } from '@/auth/AuthContext';
import { useAsync } from '@/hooks/useAsync';
import { canSeePlatformMoney } from '@/lib/staffAccess';
import { adminPath } from '@/lib/adminPath';
import { fetchCustomersAdmin, fetchCustomerOrders } from '@/data/orders';
import { StatCard, SearchInput, Select, DataTable, Avatar, Drawer, EmptyState, Field, Icon, StatusPill, T, type Column } from '@/components/admin/kit';
import type { CustomerStat } from '@/data/orders';

const compactInr = (n: number) =>
  n >= 100000 ? '₹' + (n / 100000).toFixed(1) + 'L' : n >= 1000 ? '₹' + (n / 1000).toFixed(1) + 'k' : fmtInr(n);

type SortKey = 'spent' | 'orders' | 'name';

export function Customers() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  // Only an admin can open the full account page (Users is admin-only). A
  // registered buyer groups under their profile id; a guest groups under a
  // synthetic `guest:` key that has no account to open.
  const canOpenUser = canSeePlatformMoney(profile?.role);
  const { data, loading } = useAsync(() => fetchCustomersAdmin(), []);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('spent');
  // Staff can't open the admin Users page, so they get a drawer with the
  // customer's history here instead (fed by the staff-safe RPC).
  const [detail, setDetail] = useState<CustomerStat | null>(null);

  const all = data ?? [];
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? all.filter((c) => c.name.toLowerCase().includes(needle) || (c.city ?? '').toLowerCase().includes(needle))
      : all;
    return [...filtered].sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name) : sort === 'orders' ? b.orders - a.orders : b.spent - a.spent,
    );
  }, [all, q, sort]);

  const totalRevenue = all.reduce((s, c) => s + c.spent, 0);
  const totalOrders = all.reduce((s, c) => s + c.orders, 0);
  const repeat = all.filter((c) => c.orders > 1).length;
  const avgSpend = all.length ? totalRevenue / all.length : 0;

  const columns: Column<CustomerStat>[] = [
    {
      key: 'name', header: 'CUSTOMER', width: '2fr',
      render: (c) => (
        <div style={css('display:flex;align-items:center;gap:10px;min-width:0;')}>
          <Avatar name={c.name} tone={c.tone} />
          <div style={css('min-width:0;')}>
            <div style={css('font-weight:700;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;')}>{c.name}</div>
            <div style={css(`font-size:11.5px;color:${T.muted};`)}>{c.orders > 1 ? 'Repeat buyer' : 'First order'}</div>
          </div>
        </div>
      ),
    },
    { key: 'city', header: 'CITY', width: '1fr', render: (c) => <span style={css('font-size:13px;color:var(--ag-label);')}>{c.city ?? '—'}</span> },
    { key: 'orders', header: 'ORDERS', width: '90px', align: 'right', render: (c) => <span style={css('font-weight:700;font-size:13px;')}>{c.orders}</span> },
    { key: 'aov', header: 'AVG ORDER', width: '120px', align: 'right', render: (c) => <span style={css(`font-size:12.5px;color:${T.muted};`)}>{compactInr(c.orders ? c.spent / c.orders : 0)}</span> },
    { key: 'spent', header: 'LIFETIME', width: '130px', align: 'right', render: (c) => <span style={css('font-weight:800;font-size:13.5px;color:var(--ag-crimson);')}>{fmtInr(c.spent)}</span> },
  ];

  return (
    <div style={css('display:flex;flex-direction:column;gap:16px;')}>
      <div className="agx-adm-g4">
        <StatCard label="Customers" value={String(all.length)} icon="group" tint="var(--ag-surface-2)" ic="#D6336C" />
        <StatCard label="Repeat buyers" value={String(repeat)} icon="autorenew" tint="var(--ag-good-bg)" ic="var(--ag-good-text)" sub={all.length ? `${Math.round((repeat / all.length) * 100)}%` : '0%'} />
        <StatCard label="Total orders" value={String(totalOrders)} icon="receipt_long" tint="var(--ag-info-bg)" ic="var(--ag-info-text)" />
        <StatCard label="Avg. lifetime" value={compactInr(avgSpend)} icon="payments" tint="var(--ag-warn-bg)" ic="var(--ag-gold-text)" />
      </div>

      <div style={css('display:flex;gap:10px;flex-wrap:wrap;')}>
        <SearchInput value={q} onChange={setQ} placeholder="Search customers or city…" />
        <Select value={sort} onChange={(v) => setSort(v as SortKey)} options={[
          { value: 'spent', label: 'Top spenders' },
          { value: 'orders', label: 'Most orders' },
          { value: 'name', label: 'Name A–Z' },
        ]} />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        getId={(c) => c.buyer_id}
        onRowClick={(c) => {
          if (c.buyer_id.startsWith('guest:')) return;        // no account to open
          if (canOpenUser) navigate(adminPath(`users/${c.buyer_id}`));
          else setDetail(c);                                   // staff: drawer
        }}
      />

      <CustomerDrawer customer={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

/** A customer's profile summary + order history — the staff view that stands in
 *  for the admin account page. Order history comes through the staff-safe RPC
 *  (migration 0124); it is an empty list until that migration is applied. */
function CustomerDrawer({ customer, onClose }: { customer: CustomerStat | null; onClose: () => void }) {
  const { data: orders, loading } = useAsync(
    () => (customer ? fetchCustomerOrders(customer.buyer_id) : Promise.resolve([])),
    [customer?.buyer_id],
  );

  return (
    <Drawer open={!!customer} onClose={onClose} title={customer?.name ?? 'Customer'}>
      {customer && (
        <div style={css('display:flex;flex-direction:column;gap:2px;')}>
          <div style={css('display:flex;align-items:center;gap:12px;margin-bottom:10px;')}>
            <Avatar name={customer.name} tone={customer.tone} />
            <div style={css('min-width:0;')}>
              <div style={css('font-weight:800;font-size:15px;')}>{customer.name}</div>
              <div style={css(`font-size:12.5px;color:${T.muted};`)}>{customer.city || '—'}</div>
            </div>
          </div>

          <Field label="Orders" value={String(customer.orders)} />
          <Field label="Lifetime spend" value={fmtInr(customer.spent)} />
          <Field label="Average order" value={fmtInr(customer.orders ? customer.spent / customer.orders : 0)} />

          <div style={css('font-weight:800;font-size:13px;margin:16px 0 8px;')}>Order history</div>
          {loading && (orders?.length ?? 0) === 0 ? (
            <div style={css(`padding:12px;color:${T.muted};font-size:13px;`)}>Loading…</div>
          ) : (orders?.length ?? 0) === 0 ? (
            <EmptyState icon="receipt_long" title="No orders" />
          ) : (
            <div style={css('display:flex;flex-direction:column;gap:8px;')}>
              {(orders ?? []).map((o) => (
                <div key={o.id} style={css('background:var(--ag-surface);border-radius:12px;padding:12px 14px;display:flex;align-items:center;gap:10px;')}>
                  <Icon name="receipt_long" size={18} color="var(--ag-muted-soft)" />
                  <div style={css('flex:1;min-width:0;')}>
                    <div style={css('font-weight:700;font-size:12.5px;')}>{o.order_number}</div>
                    <div style={css(`font-size:11px;color:${T.muted};`)}>{o.boutique} · {new Date(o.created_at).toLocaleDateString('en-IN')}</div>
                  </div>
                  <div style={css('text-align:right;')}>
                    <div style={css('font-weight:800;font-size:12.5px;')}>{fmtInr(o.total)}</div>
                    <StatusPill status={o.status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

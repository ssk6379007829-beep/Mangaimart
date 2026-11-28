import { useMemo, useState } from 'react';
import { css } from '@/lib/css';
import { useAsync } from '@/hooks/useAsync';
import { T, Card, DataTable, Drawer, EmptyState, Field, Select, type Column } from '@/components/admin/kit';
import {
  fetchSellerFeedback, SELLER_FEEDBACK_CATEGORY_LABEL, type AdminSellerFeedbackRow,
} from '@/data/sellerFeedback';

/**
 * What sellers say about MangaiMart itself (migration 0128).
 *
 * The seller-side mirror of /admin/feedback. Private — there is no public read
 * on `seller_feedback` and no quote flow; a boutique owner's note goes to the
 * operator and nowhere else, and nothing here affects any rating. Collected from
 * the Help page and an occasional pop-up after a delivery or payout.
 */

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function Stars({ n }: { n: number }) {
  return (
    <span style={css('display:inline-flex;gap:1px;')} aria-label={`${n} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          aria-hidden="true"
          style={css(`font-family:'Material Symbols Outlined';font-size:16px;color:${i <= n ? '#E8A33D' : 'var(--ag-muted-soft)'};${i <= n ? "font-variation-settings:'FILL' 1;" : ''}`)}
        >
          star
        </span>
      ))}
    </span>
  );
}

function CategoryChip({ category }: { category: string }) {
  return (
    <span style={css(`font-size:11.5px;font-weight:800;padding:3px 9px;border-radius:7px;background:var(--ag-surface-2);color:${T.muted};white-space:nowrap;`)}>
      {SELLER_FEEDBACK_CATEGORY_LABEL[category] ?? category}
    </span>
  );
}

export function SellerFeedback() {
  const { data, loading } = useAsync(fetchSellerFeedback, []);
  const [rating, setRating] = useState('all');
  const [category, setCategory] = useState('all');
  const [detail, setDetail] = useState<AdminSellerFeedbackRow | null>(null);

  const rows = useMemo(() => {
    let all = data ?? [];
    if (rating === 'low') all = all.filter((r) => r.rating <= 2);
    else if (rating === 'high') all = all.filter((r) => r.rating >= 4);
    if (category !== 'all') all = all.filter((r) => r.category === category);
    return all;
  }, [data, rating, category]);

  const stats = useMemo(() => {
    const all = data ?? [];
    if (all.length === 0) return { avg: 0, count: 0, detractors: 0, written: 0 };
    const sum = all.reduce((s, r) => s + r.rating, 0);
    return {
      avg: sum / all.length,
      count: all.length,
      detractors: all.filter((r) => r.rating <= 2).length,
      written: all.filter((r) => r.body.trim().length > 0).length,
    };
  }, [data]);

  const columns: Column<AdminSellerFeedbackRow>[] = [
    { key: 'rating', header: 'RATING', width: '130px', render: (r) => <Stars n={r.rating} /> },
    { key: 'category', header: 'ABOUT', width: '150px', render: (r) => <CategoryChip category={r.category} /> },
    {
      key: 'body', header: 'WHAT THEY SAID', width: '2.4fr',
      render: (r) => (
        r.body.trim()
          ? <span style={css('font-size:13px;line-height:1.55;')}>{r.body}</span>
          : <span style={css(`font-size:13px;color:${T.muted};`)}>Rating only — no comment</span>
      ),
    },
    {
      key: 'boutique', header: 'BOUTIQUE', width: '1fr',
      render: (r) => (
        <div>
          <div style={css('font-size:13px;')}>{r.boutique?.name ?? 'Boutique'}</div>
          <div style={css(`font-size:12px;color:${T.muted};`)}>{r.boutique?.city ?? '—'}</div>
        </div>
      ),
    },
    {
      key: 'when', header: 'WHEN', width: '130px',
      render: (r) => <span style={css(`font-size:12.5px;color:${T.muted};`)}>{fmtDate(r.created_at)}</span>,
    },
  ];

  return (
    <div>
      <div style={css('display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;')}>
        <Card style="padding:14px 18px;flex:1;min-width:150px;">
          <div style={css(`font-size:11.5px;font-weight:800;color:${T.muted};letter-spacing:.05em;`)}>AVERAGE</div>
          <div style={css("font-family:var(--ag-display);font-weight:700;font-size:26px;margin-top:2px;")}>
            {stats.count ? stats.avg.toFixed(2) : '—'}
          </div>
        </Card>
        <Card style="padding:14px 18px;flex:1;min-width:150px;">
          <div style={css(`font-size:11.5px;font-weight:800;color:${T.muted};letter-spacing:.05em;`)}>RESPONSES</div>
          <div style={css("font-family:var(--ag-display);font-weight:700;font-size:26px;margin-top:2px;")}>{stats.count}</div>
        </Card>
        <Card style="padding:14px 18px;flex:1;min-width:150px;">
          {/* The sellers who are unhappy — the ones most likely to leave. */}
          <div style={css(`font-size:11.5px;font-weight:800;color:${T.muted};letter-spacing:.05em;`)}>1–2 STARS</div>
          <div style={css(`font-family:var(--ag-display);font-weight:700;font-size:26px;margin-top:2px;color:${stats.detractors ? '#C0455E' : 'inherit'};`)}>
            {stats.detractors}
          </div>
        </Card>
        <Card style="padding:14px 18px;flex:1;min-width:150px;">
          <div style={css(`font-size:11.5px;font-weight:800;color:${T.muted};letter-spacing:.05em;`)}>WITH A COMMENT</div>
          <div style={css("font-family:var(--ag-display);font-weight:700;font-size:26px;margin-top:2px;")}>{stats.written}</div>
        </Card>
      </div>

      <Card style="padding:14px 18px;margin-bottom:14px;">
        <div style={css(`font-size:13px;color:${T.muted};line-height:1.6;`)}>
          What <strong>sellers</strong> tell us about MangaiMart — collected from the seller Help page and an occasional
          prompt after a delivery or payout. <strong>Private</strong>: no buyer or other seller can see any of it, and
          none of it affects a boutique’s score. Buyer feedback about the platform is separate, at <strong>/admin/feedback</strong>.
        </div>
      </Card>

      <div style={css('display:flex;justify-content:flex-end;gap:10px;margin-bottom:12px;flex-wrap:wrap;')}>
        <div style={css('max-width:220px;flex:1;min-width:160px;')}>
          <Select
            value={category}
            onChange={setCategory}
            options={[
              { value: 'all', label: 'All categories' },
              ...Object.entries(SELLER_FEEDBACK_CATEGORY_LABEL).map(([value, label]) => ({ value, label })),
            ]}
          />
        </div>
        <div style={css('max-width:200px;flex:1;min-width:150px;')}>
          <Select
            value={rating}
            onChange={setRating}
            options={[
              { value: 'all', label: 'All ratings' },
              { value: 'low', label: 'Unhappy (1–2★)' },
              { value: 'high', label: 'Happy (4–5★)' },
            ]}
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        getId={(r) => r.id}
        onRowClick={setDetail}
        empty={
          <EmptyState
            icon="storefront"
            title="No seller feedback yet"
            sub="Sellers are asked after a delivery or payout, and can share feedback any time from their Help page. Nothing will appear here until they do."
          />
        }
      />

      <Drawer open={!!detail} onClose={() => setDetail(null)} title="Seller feedback">
        {detail && (
          <div style={css('display:flex;flex-direction:column;gap:2px;')}>
            <div style={css('display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;')}>
              <Stars n={detail.rating} />
              <span style={css('font-weight:800;font-size:15px;')}>{detail.rating}/5</span>
              <CategoryChip category={detail.category} />
            </div>
            <div style={css(`font-size:14px;line-height:1.6;color:var(--ag-ink);${detail.body.trim() ? '' : `color:${T.muted};font-style:italic;`}`)}>
              {detail.body.trim() || 'Rating only — the seller left no comment.'}
            </div>

            <div style={css('margin-top:14px;')}>
              <Field label="Boutique" value={detail.boutique?.name ?? 'Boutique'} />
              <Field label="City" value={detail.boutique?.city ?? '—'} />
              <Field label="Owner" value={detail.seller?.full_name ?? '—'} />
              <Field label="Category" value={SELLER_FEEDBACK_CATEGORY_LABEL[detail.category] ?? detail.category} />
              <Field label="When" value={fmtDate(detail.created_at)} />
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

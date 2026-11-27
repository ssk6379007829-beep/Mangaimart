import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { css } from '@/lib/css';
import { fmtInr } from '@/lib/tokens';
import { useShop } from '@/state/ShopContext';
import { useAuth } from '@/auth/AuthContext';
import { useAsync } from '@/hooks/useAsync';
import { canSeePlatformMoney } from '@/lib/staffAccess';
import { logAdminAction } from '@/data/activityLog';
import {
  fetchProductAdminById, fetchProductOrders, setProductStatus, softDeleteProduct, restoreProduct, updateProduct,
  type AdminProductRow, type ProductStatus, type UpdateProductInput,
} from '@/data/adminProducts';
import { fetchProduct } from '@/data/products';
import { fetchReviews } from '@/data/reviews';
import { TONES } from '@/data/demo';
import {
  Card, ConfirmDialog, EmptyState, Field, GhostButton, Icon, StatusPill, T,
} from '@/components/admin/kit';
import { adminPath } from '@/lib/adminPath';

/**
 * One product, full-page — its photos and details, the reviews on it, the orders
 * it has appeared in, and the moderation controls (approve / hide / reject /
 * edit / delete) the list used to keep in a pop-up. Opened from the Products
 * list.
 *
 * Rejecting asks for a reason (migration 0092) that reaches the seller in their
 * console and on WhatsApp; delete is a soft-delete that can be restored. The
 * product row is patched locally after each action so the page stays correct.
 */

type Dialog = 'reject' | 'delete' | null;

export function ProductDetailPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { showToast } = useShop();
  const { profile } = useAuth();
  const canMoney = canSeePlatformMoney(profile?.role);

  const seed = (location.state as { product?: AdminProductRow } | null)?.product;
  const [product, setProduct] = useState<AdminProductRow | null>(seed?.id === id ? seed : null);
  const { data: fetched, loading } = useAsync(() => fetchProductAdminById(id), [id]);
  useEffect(() => { if (fetched) setProduct(fetched); }, [fetched]);

  // Rich buyer-facing fields (images, description, sizes). Hidden for a deleted
  // product, so this can be null while the admin row above still loads.
  const { data: rich } = useAsync(() => fetchProduct(id).catch(() => null), [id]);
  const { data: reviews } = useAsync(() => fetchReviews(id), [id]);
  const { data: orders } = useAsync(() => (canMoney ? fetchProductOrders(id) : Promise.resolve([])), [id, canMoney]);

  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const back = () => navigate(adminPath('products'));
  const log = (action: string, meta?: Record<string, unknown>) =>
    logAdminAction({ actor_id: profile?.id, actor_name: profile?.full_name ?? 'Admin', action, entity_type: 'product', entity_id: id, meta });

  const patch = (p: Partial<AdminProductRow>) => setProduct((prev) => (prev ? { ...prev, ...p } : prev));

  const setStatus = async (next: ProductStatus) => {
    if (!product) return;
    try {
      await setProductStatus(product.id, next);
      await log(`product.${next}`, { title: product.title });
      showToast(`${product.title} → ${next}`);
      patch({ status: next });
    } catch (e) { showToast(e instanceof Error ? e.message : 'Update failed', 'error'); }
  };

  const doReject = async () => {
    if (!product) return;
    setBusy(true);
    try {
      await setProductStatus(product.id, 'rejected', reason.trim() || null);
      await log('product.rejected', { title: product.title, note: reason.trim() || null });
      showToast(`${product.title} rejected`);
      patch({ status: 'rejected' });
      setDialog(null); setReason('');
    } catch (e) { showToast(e instanceof Error ? e.message : 'Update failed', 'error'); }
    finally { setBusy(false); }
  };

  const doDelete = async () => {
    if (!product) return;
    setBusy(true);
    try {
      await softDeleteProduct(product.id);
      await log('product.delete', { title: product.title });
      showToast(`${product.title} deleted`);
      patch({ deleted_at: new Date().toISOString() });
      setDialog(null);
    } catch (e) { showToast(e instanceof Error ? e.message : 'Delete failed', 'error'); }
    finally { setBusy(false); }
  };

  const doRestore = async () => {
    if (!product) return;
    try {
      await restoreProduct(product.id);
      await log('product.restore', { title: product.title });
      showToast(`${product.title} restored`);
      patch({ deleted_at: null });
    } catch (e) { showToast(e instanceof Error ? e.message : 'Restore failed', 'error'); }
  };

  if (loading && !product) return <div style={css(`padding:24px;color:${T.muted};font-size:14px;`)}>Loading product…</div>;
  if (!product) return <Shell onBack={back}><div style={css(`padding:20px;color:${T.muted};font-size:13.5px;`)}>That product could not be opened.</div></Shell>;

  const p = product;
  const deleted = !!p.deleted_at;
  const images = rich?.images?.length ? rich.images : (p.image_url ? [p.image_url] : []);

  return (
    <Shell onBack={back}>
      {/* Header */}
      <div style={css(T.card + 'padding:18px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;')}>
        <div style={css(`width:64px;height:64px;flex:none;border-radius:14px;overflow:hidden;background:${TONES[p.tone % TONES.length]};`)}>
          {p.image_url && <img src={p.image_url} alt="" style={css('width:100%;height:100%;object-fit:cover;')} />}
        </div>
        <div style={css('flex:1;min-width:0;')}>
          <div style={css("font-family:var(--ag-display);font-weight:700;font-size:22px;line-height:1.15;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{p.title}</div>
          <div style={css(`font-size:13px;color:${T.muted};margin-top:3px;`)}>{p.boutique?.name ?? '—'} · {p.category || '—'}</div>
        </div>
        <div style={css('text-align:right;')}>
          <div style={css('font-weight:800;font-size:18px;font-variant-numeric:tabular-nums;')}>{fmtInr(p.price)}</div>
          <div style={css(`font-size:12px;color:${p.stock <= 5 ? 'var(--ag-danger-text)' : T.muted};`)}>stock {p.stock}</div>
        </div>
        <StatusPill status={deleted ? 'rejected' : p.status} label={deleted ? 'Deleted' : undefined} />
      </div>

      {/* Moderation actions */}
      <div style={css('display:flex;gap:9px;flex-wrap:wrap;')}>
        {deleted ? (
          <GhostButton tone="primary" icon="restore_from_trash" onClick={() => void doRestore()}>Restore product</GhostButton>
        ) : (
          <>
            <GhostButton icon="edit" onClick={() => setEditing((v) => !v)}>{editing ? 'Close editor' : 'Edit'}</GhostButton>
            {p.status !== 'active' && <GhostButton icon="check" onClick={() => void setStatus('active')}>Approve</GhostButton>}
            {p.status !== 'hidden' && <GhostButton icon="visibility_off" onClick={() => void setStatus('hidden')}>Hide</GhostButton>}
            {p.status !== 'rejected' && <GhostButton icon="block" onClick={() => { setReason(''); setDialog('reject'); }}>Reject</GhostButton>}
            <GhostButton tone="danger" icon="delete" onClick={() => setDialog('delete')}>Delete</GhostButton>
          </>
        )}
      </div>

      {editing && !deleted && <EditCard product={p} onSaved={(v) => { patch(v); setEditing(false); }} log={log} />}

      {/* Gallery */}
      {images.length > 0 && (
        <div style={css('display:flex;gap:10px;flex-wrap:wrap;')}>
          {images.slice(0, 8).map((src, i) => (
            <img key={i} src={src} alt="" style={css('width:96px;height:96px;border-radius:12px;object-fit:cover;')} />
          ))}
        </div>
      )}

      <div className="agx-adm-g2">
        <Card>
          <div style={css('font-weight:800;font-size:15px;margin-bottom:6px;')}>Details</div>
          <Field label="Status" value={<StatusPill status={deleted ? 'rejected' : p.status} label={deleted ? 'Deleted' : undefined} />} />
          <Field label="Category" value={p.category || '—'} />
          <Field label="Price" value={fmtInr(p.price)} />
          <Field label="Stock" value={String(p.stock)} />
          <Field label="Rating" value={p.reviews_count > 0 ? `${p.rating} (${p.reviews_count})` : '—'} />
          <Field label="Listed" value={new Date(p.created_at).toLocaleDateString('en-IN')} />
        </Card>

        {(rich?.description || rich?.sizes?.length || rich?.color) && (
          <Card>
            <div style={css('font-weight:800;font-size:15px;margin-bottom:6px;')}>Description</div>
            {rich?.description && <div style={css('font-size:13.5px;line-height:1.6;color:var(--ag-ink);')}>{rich.description}</div>}
            {rich?.sizes?.length ? <div style={css(`font-size:12.5px;color:${T.muted};margin-top:10px;`)}>Sizes: {rich.sizes.join(', ')}</div> : null}
            {rich?.color ? <div style={css(`font-size:12.5px;color:${T.muted};margin-top:4px;`)}>Colour: {rich.color}</div> : null}
          </Card>
        )}
      </div>

      {/* In orders (admin) */}
      {canMoney && (orders?.length ?? 0) > 0 && (
        <div>
          <div style={css('font-weight:800;font-size:15px;margin-bottom:10px;')}>In orders</div>
          <div style={css('display:flex;flex-direction:column;gap:10px;')}>
            {(orders ?? []).map((o) => (
              <div
                key={o.id}
                className="agx-adm-row" data-clickable="true"
                onClick={() => navigate(adminPath(`orders/${o.id}`))}
                style={css(T.card + 'padding:12px 15px;display:flex;align-items:center;gap:13px;cursor:pointer;')}
              >
                <div style={css('flex:1;min-width:0;')}>
                  <div style={css('font-weight:700;font-size:13px;')}>{o.order_number}</div>
                  <div style={css(`font-size:11.5px;color:${T.muted};`)}>Qty {o.qty} · {new Date(o.created_at).toLocaleDateString('en-IN')}</div>
                </div>
                <StatusPill status={o.status} />
                <span style={css('font-weight:800;font-size:13px;font-variant-numeric:tabular-nums;')}>{fmtInr(o.price * o.qty)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reviews */}
      <div>
        <div style={css('font-weight:800;font-size:15px;margin-bottom:10px;')}>Reviews</div>
        {(reviews?.length ?? 0) === 0 ? (
          <Card><EmptyState icon="reviews" title="No reviews" sub="No buyer has reviewed this product yet." /></Card>
        ) : (
          <div style={css('display:flex;flex-direction:column;gap:12px;')}>
            {(reviews ?? []).map((r) => (
              <div key={r.id} style={css(T.card + 'padding:15px 17px;')}>
                <div style={css('display:flex;align-items:center;gap:10px;flex-wrap:wrap;')}>
                  <Stars n={r.rating} />
                  <span style={css('font-weight:700;font-size:13px;')}>{r.author_name ?? 'Anonymous'}</span>
                  <span style={css(`font-size:11.5px;color:${T.muted};`)}>· {new Date(r.created_at).toLocaleDateString('en-IN')}</span>
                </div>
                {r.body && <div style={css('font-size:13.5px;line-height:1.55;margin-top:8px;color:var(--ag-ink);')}>{r.body}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={dialog === 'reject'}
        title="Reject this listing?"
        message={`${p.title} will be hidden from buyers, and the seller is told why.`}
        confirmLabel="Reject" danger busy={busy}
        onConfirm={() => void doReject()} onCancel={() => { setDialog(null); setReason(''); }}
      >
        <label style={css(`display:block;margin-top:14px;font-size:12px;font-weight:800;color:${T.muted};`)}>
          Reason the seller will see
          <textarea
            rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. The photos show a different colour to the one listed."
            style={css(`display:block;width:100%;margin-top:6px;border:1.5px solid ${T.field};border-radius:12px;background:var(--ag-surface);font-size:13.5px;font-family:inherit;color:var(--ag-ink);padding:10px 12px;box-sizing:border-box;resize:vertical;line-height:1.5;`)}
          />
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'delete'}
        title="Delete product?"
        message={`${p.title} will be soft-deleted and hidden from buyers. It can be restored later.`}
        confirmLabel="Delete" danger busy={busy}
        onConfirm={() => void doDelete()} onCancel={() => setDialog(null)}
      />
    </Shell>
  );
}

function Stars({ n }: { n: number }) {
  return (
    <span style={css('display:inline-flex;gap:1px;')} aria-label={`${n} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => <Icon key={i} name="star" size={14} color={i <= n ? '#E8A13C' : 'var(--ag-border)'} />)}
    </span>
  );
}

function Shell({ onBack, children }: { onBack: () => void; children: React.ReactNode }) {
  return (
    <div style={css('display:flex;flex-direction:column;gap:16px;')}>
      <button onClick={onBack} style={css(`display:inline-flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;color:${T.muted};font-weight:700;font-size:13px;font-family:inherit;padding:0;width:fit-content;`)}>
        <Icon name="arrow_back" size={18} /> All products
      </button>
      {children}
    </div>
  );
}

/** Admin edit of the merchandising fields — the same updateProduct the list uses. */
function EditCard({ product, onSaved, log }: { product: AdminProductRow; onSaved: (v: Partial<AdminProductRow>) => void; log: (action: string, meta?: Record<string, unknown>) => void }) {
  const { showToast } = useShop();
  const [title, setTitle] = useState(product.title);
  const [category, setCategory] = useState(product.category);
  const [price, setPrice] = useState(String(product.price));
  const [stock, setStock] = useState(String(product.stock));
  const [status, setStatus] = useState<ProductStatus>(product.status);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!title.trim()) { showToast('Title is required', 'warning'); return; }
    setBusy(true);
    const input: UpdateProductInput = { title: title.trim(), category: category.trim(), price: Number(price) || 0, stock: Number(stock) || 0, status };
    try {
      await updateProduct(product.id, input);
      await log('product.update', { title: input.title });
      showToast(`${input.title} updated`);
      onSaved(input);
    } catch (e) { showToast(e instanceof Error ? e.message : 'Update failed', 'error'); }
    finally { setBusy(false); }
  };

  const label = css('font-size:12px;font-weight:700;color:var(--ag-label);display:block;margin-top:12px;');
  const field = css('width:100%;margin-top:5px;border:1.5px solid var(--ag-border);background:var(--ag-surface);border-radius:11px;padding:0 12px;height:40px;font-size:13.5px;font-weight:600;color:var(--ag-ink);font-family:inherit;box-sizing:border-box;');

  return (
    <Card>
      <div style={css('font-weight:800;font-size:15px;')}>Edit product</div>
      <label style={label}>Title<input value={title} onChange={(e) => setTitle(e.target.value)} style={field} /></label>
      <div className="agx-adm-g2">
        <label style={label}>Category<input value={category} onChange={(e) => setCategory(e.target.value)} style={field} /></label>
        <label style={label}>Status
          <select value={status} onChange={(e) => setStatus(e.target.value as ProductStatus)} style={css(field + 'cursor:pointer;')}>
            <option value="active">Active</option>
            <option value="pending">Pending</option>
            <option value="hidden">Hidden</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
        <label style={label}>Price (₹)<input inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} style={field} /></label>
        <label style={label}>Stock<input inputMode="numeric" value={stock} onChange={(e) => setStock(e.target.value)} style={field} /></label>
      </div>
      <div style={css('margin-top:16px;')}>
        <GhostButton tone="primary" icon="save" onClick={() => { if (!busy) void save(); }}>{busy ? 'Saving…' : 'Save changes'}</GhostButton>
      </div>
    </Card>
  );
}

export default ProductDetailPage;

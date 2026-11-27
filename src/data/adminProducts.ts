import { supabase } from '@/lib/supabase';
import type { Paged } from './adminUsers';

export type ProductStatus = 'pending' | 'active' | 'hidden' | 'rejected';

export interface AdminProductRow {
  id: string;
  title: string;
  category: string;
  price: number;
  stock: number;
  status: ProductStatus;
  featured: boolean;
  image_url: string | null;
  tone: number;
  reviews_count: number;
  rating: number;
  deleted_at: string | null;
  created_at: string;
  boutique: { name: string; tone: number } | null;
}

export interface ProductsQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: 'all' | ProductStatus | 'deleted';
  lowStock?: boolean;
  /** Scope the listing to one shop — the admin boutique page's Products tab. */
  boutiqueId?: string;
}

const SELECT = 'id, title, category, price, stock, status, featured, image_url, tone, reviews_count, rating, deleted_at, created_at, boutique:boutiques(name, tone)';

export async function fetchProductsAdmin(q: ProductsQuery): Promise<Paged<AdminProductRow>> {
  let query = supabase.from('products').select(SELECT, { count: 'exact' });

  if (q.status === 'deleted') query = query.not('deleted_at', 'is', null);
  else {
    query = query.is('deleted_at', null);
    if (q.status && q.status !== 'all') query = query.eq('status', q.status);
  }
  if (q.boutiqueId) query = query.eq('boutique_id', q.boutiqueId);
  if (q.lowStock) query = query.lte('stock', 5);
  if (q.search?.trim()) {
    const s = `%${q.search.trim()}%`;
    query = query.or(`title.ilike.${s},category.ilike.${s}`);
  }

  const from = q.page * q.pageSize;
  query = query.order('created_at', { ascending: false }).range(from, from + q.pageSize - 1);

  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: (data ?? []) as unknown as AdminProductRow[], total: count ?? 0 };
}

/**
 * Move a listing through moderation.
 *
 * `reviewNote` is why it was refused (migration 0092). It reaches the seller two
 * ways — their console, and the `seller_product_rejected` WhatsApp message that
 * quotes it — so a rejection without one tells them they failed and not what to
 * fix, which is a support ticket rather than feedback.
 *
 * Approving clears the note. A listing that has been corrected should not carry
 * the reason it was once wrong, least of all into a future message.
 */
export async function setProductStatus(id: string, status: ProductStatus, reviewNote?: string | null) {
  const patch: { status: ProductStatus; review_note?: string | null } = { status };
  if (status === 'rejected') patch.review_note = reviewNote?.trim() || null;
  if (status === 'active') patch.review_note = null;
  const { error } = await supabase.from('products').update(patch).eq('id', id);
  if (error) throw error;
}

export async function bulkSetProductStatus(ids: string[], status: ProductStatus, reviewNote?: string | null) {
  const patch: { status: ProductStatus; review_note?: string | null } = { status };
  if (status === 'rejected') patch.review_note = reviewNote?.trim() || null;
  if (status === 'active') patch.review_note = null;
  const { error } = await supabase.from('products').update(patch).in('id', ids);
  if (error) throw error;
}

export async function setProductFeatured(id: string, featured: boolean) {
  const { error } = await supabase.from('products').update({ featured }).eq('id', id);
  if (error) throw error;
}

export async function softDeleteProduct(id: string) {
  const { error } = await supabase.from('products').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function bulkSoftDeleteProducts(ids: string[]) {
  const { error } = await supabase.from('products').update({ deleted_at: new Date().toISOString() }).in('id', ids);
  if (error) throw error;
}

export async function restoreProduct(id: string) {
  const { error } = await supabase.from('products').update({ deleted_at: null }).eq('id', id);
  if (error) throw error;
}

export interface UpdateProductInput {
  title: string;
  category: string;
  price: number;
  stock: number;
  status: ProductStatus;
}

/**
 * One product's admin row — for the full product page reached by URL. Unlike
 * `fetchProduct` (buyer/seller, which hides soft-deleted rows) this keeps a
 * deleted product visible so it can be restored. Returns null if absent.
 */
export async function fetchProductAdminById(id: string): Promise<AdminProductRow | null> {
  const { data, error } = await supabase.from('products').select(SELECT).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as unknown as AdminProductRow) ?? null;
}

export interface ProductOrderRow {
  id: string;
  order_number: string;
  created_at: string;
  status: string;
  qty: number;
  price: number;
}

/**
 * Orders that included this product, newest first. Admin-only in practice —
 * staff hold no read policy on `orders`/`order_items` (migration 0086), so this
 * returns an empty list for them rather than throwing.
 */
export async function fetchProductOrders(productId: string): Promise<ProductOrderRow[]> {
  const { data, error } = await supabase
    .from('order_items')
    .select('qty, price, order:orders!inner(id, order_number, created_at, status)')
    .eq('product_id', productId)
    .limit(100);
  if (error) {
    console.warn('[products] order history unavailable:', error.message);
    return [];
  }
  const rows = (data ?? []) as unknown as {
    qty: number; price: number; order: { id: string; order_number: string; created_at: string; status: string } | null;
  }[];
  return rows
    .filter((r) => r.order)
    .map((r) => ({ id: r.order!.id, order_number: r.order!.order_number, created_at: r.order!.created_at, status: r.order!.status, qty: r.qty, price: r.price }))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

/** Admin edit of the core merchandising fields on an existing product. */
export async function updateProduct(id: string, input: UpdateProductInput) {
  const { error } = await supabase
    .from('products')
    .update({
      title: input.title.trim(),
      category: input.category.trim(),
      price: input.price,
      stock: input.stock,
      status: input.status,
    })
    .eq('id', id);
  if (error) throw error;
}

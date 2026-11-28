/**
 * Seller feedback about MangaiMart itself (migration 0128).
 *
 * The seller-side mirror of buyer `platform_feedback` (src/data/feedback.ts):
 * a boutique owner rates the platform, picks a category and writes a note. It is
 * PRIVATE — there is no public read, no consent/quote flow, and no effect on any
 * rating. The operator reads it at /admin/seller-feedback.
 *
 * Everything degrades quietly if 0128 has not been applied: the prompt never
 * decides it is eligible (the eligibility/`hasGiven` reads fail soft to false),
 * so nothing appears, rather than a seller screen breaking. The submit itself
 * fails loudly — by then the seller has asked for it to be sent.
 */
import { supabase } from '@/lib/supabase';

/** The triage buckets, mirrored by the CHECK constraint in migration 0128. */
export const SELLER_FEEDBACK_CATEGORIES = [
  { value: 'experience', label: 'Overall experience' },
  { value: 'bug', label: 'Something is broken' },
  { value: 'feature', label: 'Feature request' },
  { value: 'payments', label: 'Payments & payouts' },
  { value: 'delivery', label: 'Delivery & shipping' },
  { value: 'other', label: 'Something else' },
] as const;

export type SellerFeedbackCategory = (typeof SELLER_FEEDBACK_CATEGORIES)[number]['value'];

export const SELLER_FEEDBACK_CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  SELLER_FEEDBACK_CATEGORIES.map((c) => [c.value, c.label]),
);

/** Record a boutique owner's feedback about the platform. */
export async function submitSellerFeedback(input: {
  boutiqueId: string;
  sellerId: string;
  rating: number;
  category: SellerFeedbackCategory;
  body: string;
}): Promise<void> {
  const rating = Math.min(5, Math.max(1, Math.round(input.rating)));
  const { error } = await supabase.from('seller_feedback').insert({
    boutique_id: input.boutiqueId,
    seller_id: input.sellerId,
    rating,
    category: input.category,
    body: input.body.trim(),
  });
  if (error) throw error;
}

/**
 * Has this boutique already sent feedback? Drives the pop-up's "don't nag"
 * rule — one note is plenty. Fails soft to `false` (0128 not applied, a
 * momentary read error), which only means the prompt stays eligible; the
 * localStorage cooldown in the hook keeps that from becoming a nuisance.
 */
export async function hasGivenSellerFeedback(boutiqueId: string): Promise<boolean> {
  if (!boutiqueId) return false;
  const { count, error } = await supabase
    .from('seller_feedback')
    .select('id', { count: 'exact', head: true })
    .eq('boutique_id', boutiqueId);
  if (error) return false;
  return (count ?? 0) > 0;
}

/**
 * Is there anything to ask ABOUT yet — a delivered order or a completed payout?
 * We only prompt a seller who has actually experienced the platform doing its
 * job, so a brand-new shop is never interrupted. Either signal is enough.
 *
 * Both reads are head-only counts scoped by RLS to the seller's own boutique.
 * Fails soft to `false` so an un-applied migration or a blip just means "not
 * yet", never a thrown error on a seller screen.
 */
export async function sellerFeedbackEligible(boutiqueId: string): Promise<boolean> {
  if (!boutiqueId) return false;
  try {
    const [delivered, paid] = await Promise.all([
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('boutique_id', boutiqueId)
        .eq('status', 'delivered'),
      supabase
        .from('payouts')
        .select('id', { count: 'exact', head: true })
        .eq('boutique_id', boutiqueId)
        .eq('status', 'paid'),
    ]);
    return (delivered.count ?? 0) > 0 || (paid.count ?? 0) > 0;
  } catch {
    return false;
  }
}

/* ── Admin ─────────────────────────────────────────────────────────────────── */

export type AdminSellerFeedbackRow = {
  id: string;
  boutique_id: string;
  seller_id: string | null;
  rating: number;
  category: string;
  body: string;
  created_at: string;
  boutique: { name: string; city: string | null } | null;
  seller: { full_name: string | null } | null;
};

const BOUTIQUE_JOIN = 'boutique:boutiques!seller_feedback_boutique_id_fkey(name, city)';
const SELLER_JOIN = 'seller:profiles!seller_feedback_seller_id_fkey(full_name)';

/** Everything sellers have said about MangaiMart, newest first. Admin-only by RLS. */
export async function fetchSellerFeedback(): Promise<AdminSellerFeedbackRow[]> {
  const { data, error } = await supabase
    .from('seller_feedback')
    .select(`id, boutique_id, seller_id, rating, category, body, created_at, ${BOUTIQUE_JOIN}, ${SELLER_JOIN}`)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as unknown as AdminSellerFeedbackRow[];
}

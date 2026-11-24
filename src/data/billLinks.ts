import { supabase } from '@/lib/supabase';

/** A short, URL-safe code with no visually ambiguous characters (no 0/o/1/l).
 *  32-char alphabet × 8 = ~1.1e12 combinations, so collisions are rare and the
 *  insert below retries on the off chance of one. */
function shortCode(len = 8): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/**
 * Records a short link for a bill PDF and returns its code. The WhatsApp message
 * then carries `<origin>/r/<code>`, which middleware.js resolves to `signedUrl`
 * (migration 0118). Stores the already-signed URL so the edge redirect needs no
 * service key — just a read through the resolver function.
 */
export async function createBillLink(input: {
  bucket: string;
  path: string;
  signedUrl: string;
  orderId?: string | null;
  boutiqueId?: string | null;
  createdBy: string;
  expiresAt: string; // ISO timestamp, matching the signed URL's expiry
}): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = shortCode();
    const { error } = await supabase.from('bill_links').insert({
      code,
      bucket: input.bucket,
      path: input.path,
      signed_url: input.signedUrl,
      order_id: input.orderId ?? null,
      boutique_id: input.boutiqueId ?? null,
      created_by: input.createdBy,
      expires_at: input.expiresAt,
    });
    if (!error) return code;
    // 23505 = unique_violation: the random code collided — try another one.
    if (error.code !== '23505') throw error;
  }
  throw new Error('Could not create a short bill link');
}

import { supabase } from '@/lib/supabase';

/**
 * Return requests (migration 0074).
 *
 * Both writes go through SECURITY DEFINER functions rather than a table write:
 * `return_requests` has RLS on and NO insert/update policy at all, so a direct
 * write from the browser is denied by design. The functions re-derive the
 * boutique from the order, re-check ownership, and enforce the return window
 * server-side — none of which a client-side check could be trusted to do.
 *
 * The window rule they enforce, because the UI has to explain it:
 *   • damaged / defective / wrong_item / not_as_described — a FAULT claim.
 *     Accepted regardless of `platform_settings.return_window_days`, up to a
 *     hard 30 days from delivery.
 *   • size_issue / changed_mind — GOODWILL. Gated on the admin's window, and
 *     refused outright when that window is 0.
 */

export type ReturnReason =
  | 'damaged'
  | 'defective'
  | 'wrong_item'
  | 'not_as_described'
  | 'size_issue'
  | 'changed_mind';

// picked_up / received were added in 0123 when the reverse Shiprocket pickup
// gave the return a parcel to track: approved → picked_up → received → refunded.
export type ReturnStatus =
  | 'requested'
  | 'approved'
  | 'picked_up'
  | 'received'
  | 'rejected'
  | 'refunded';

export interface ReturnRequest {
  id: string;
  order_id: string;
  boutique_id: string;
  buyer_id: string;
  reason: ReturnReason;
  note: string;
  photos: string[];
  status: ReturnStatus;
  seller_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** The reverse parcel booked for an approved return (migration 0123). */
export interface ReturnShipment {
  id: string;
  return_request_id: string;
  order_id: string;
  boutique_id: string;
  provider: 'shiprocket';
  awb: string | null;
  courier_name: string | null;
  label_url: string | null;
  freight_charge: number | null;
  status: 'booked' | 'pickup_pending' | 'picked_up' | 'in_transit' | 'received' | 'cancelled' | 'failed';
  last_status: string | null;
  last_status_at: string | null;
  created_at: string;
}

/** Which reasons are a fault claim, and so exempt from the goodwill window. */
export const FAULT_REASONS: ReturnReason[] = ['damaged', 'defective', 'wrong_item', 'not_as_described'];

export function isFaultReason(r: ReturnReason): boolean {
  return FAULT_REASONS.includes(r);
}

/** Buyer-facing labels. Kept here so the buyer sheet and the seller queue agree. */
export const RETURN_REASON_LABEL: Record<ReturnReason, string> = {
  damaged: 'Arrived damaged',
  defective: 'Faulty or defective',
  wrong_item: 'Wrong item sent',
  not_as_described: 'Not as described',
  size_issue: 'Size doesn’t fit',
  changed_mind: 'Changed my mind',
};

export const RETURN_STATUS_LABEL: Record<ReturnStatus, string> = {
  requested: 'Awaiting the boutique',
  approved: 'Return approved',
  picked_up: 'Picked up — on its way back',
  received: 'Received by the boutique',
  rejected: 'Not accepted',
  refunded: 'Refunded',
};

const COLUMNS =
  'id, order_id, boutique_id, buyer_id, reason, note, photos, status, seller_note, created_at, resolved_at';

/**
 * A missing table means 0074 has not been applied. Every read below treats that
 * as "no requests" rather than an error, so a console screen still renders on a
 * deployment that is one migration behind.
 */
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === 'PGRST205' || /return_requests/.test(error.message ?? '');
}

/** The return request on one order, if there is one. */
export async function fetchReturnForOrder(orderId: string): Promise<ReturnRequest | null> {
  const { data, error } = await supabase
    .from('return_requests')
    .select(COLUMNS)
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  return (data as unknown as ReturnRequest) ?? null;
}

/** Every return request for a boutique — the seller's queue. */
export async function fetchReturnsForBoutique(boutiqueId: string): Promise<ReturnRequest[]> {
  const { data, error } = await supabase
    .from('return_requests')
    .select(COLUMNS)
    .eq('boutique_id', boutiqueId)
    .order('created_at', { ascending: false });
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return (data ?? []) as unknown as ReturnRequest[];
}

/**
 * Raise a return. Rejects with the server's own message — those strings are
 * written to be shown to the buyer verbatim ("The 7-day return window for this
 * order has closed"), so surfacing them beats a generic failure.
 */
export async function requestReturn(input: {
  orderId: string;
  reason: ReturnReason;
  note?: string;
  photos?: string[];
}): Promise<string> {
  const { data, error } = await supabase.rpc('request_return', {
    p_order_id: input.orderId,
    p_reason: input.reason,
    p_note: input.note ?? '',
    p_photos: input.photos ?? [],
  });
  if (error) {
    if (isMissingTable(error)) {
      throw new Error('Returns are not enabled yet — apply migration 0074.');
    }
    throw new Error(error.message || 'Could not raise this return.');
  }
  return data as string;
}

/**
 * Seller/admin answer.
 *
 * REJECT goes straight through the RPC — nothing moves but the decision.
 *
 * APPROVE is routed through the `return-pickup` Edge Function instead of the
 * RPC, because approving now has to BOOK the Shiprocket reverse pickup too
 * (migration 0123). That function approves the request (through the same audited
 * RPC) and books the parcel in one call, so the seller clicks once. `note` is
 * required to reject.
 */
export async function resolveReturnRequest(
  requestId: string,
  status: 'approved' | 'rejected',
  note?: string,
): Promise<void> {
  if (status === 'approved') {
    await bookReturnPickup(requestId);
    return;
  }
  const { error } = await supabase.rpc('resolve_return_request', {
    p_request_id: requestId,
    p_status: status,
    p_note: note ?? null,
  });
  if (error) throw new Error(error.message || 'Could not save that decision.');
}

const RETURN_SHIPMENT_COLUMNS =
  'id, return_request_id, order_id, boutique_id, provider, awb, courier_name, label_url, freight_charge, status, last_status, last_status_at, created_at';

/**
 * Book the reverse pickup for an approved return — collected from the buyer,
 * delivered back to the boutique. Approves the request as part of the same call.
 *
 * Returns the server's own message on a refusal: like the forward booking, those
 * strings are written to be shown verbatim ("Shiprocket could not arrange a
 * courier…"), so surfacing them beats a generic failure. A booking failure
 * leaves the request approved, so the seller can retry without re-approving.
 */
export async function bookReturnPickup(
  returnRequestId: string,
): Promise<{ awb: string; courierName: string; labelUrl: string | null; freightCharge: number | null }> {
  const { data, error } = await supabase.functions.invoke('return-pickup', {
    body: { returnRequestId },
  });
  if (error) {
    // supabase-js hides the real body behind an opaque "non-2xx"; dig it out.
    let message = error.message;
    const res = (error as { context?: Response }).context;
    if (res && typeof res.json === 'function') {
      try {
        const body = await res.json();
        if (body?.error) message = body.error as string;
      } catch { /* not JSON — keep the generic message */ }
    }
    throw new Error(message || 'Could not book the return pickup.');
  }
  if (!data?.ok) throw new Error(data?.error ?? 'Could not book the return pickup.');
  return {
    awb: data.awb as string,
    courierName: data.courierName as string,
    labelUrl: (data.labelUrl as string | null) ?? null,
    freightCharge: (data.freightCharge as number | null) ?? null,
  };
}

/** The reverse parcel on a return, if one has been booked. Never throws on a
 *  missing table — a deploy that is one migration behind simply shows none. */
export async function fetchReturnShipment(returnRequestId: string): Promise<ReturnShipment | null> {
  const { data, error } = await supabase
    .from('return_shipments')
    .select(RETURN_SHIPMENT_COLUMNS)
    .eq('return_request_id', returnRequestId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error) || /return_shipments/.test(error.message ?? '')) return null;
    throw error;
  }
  return (data as unknown as ReturnShipment) ?? null;
}

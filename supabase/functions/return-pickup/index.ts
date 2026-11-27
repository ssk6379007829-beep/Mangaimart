/**
 * Book a Shiprocket REVERSE pickup for an approved return, and record it.
 *
 * The second half of the returns flow (migration 0074 + 0123). When the seller
 * approves a return, the browser calls this with the return request's id; this
 * function approves it (if not already) and books the parcel the OTHER way —
 * collected from the BUYER, delivered back to the BOUTIQUE.
 *
 * Mirrors `shiprocket-book` deliberately: same token cache, same ownership
 * check, same best-effort label/pickup, same "booked but unsaved" guard. The
 * three differences that matter:
 *
 *   • pickup_*   is the BUYER (guest_* on the order), shipping_* is the SELLER.
 *   • AWB is assigned with is_return = 1, so Shiprocket treats it as a return.
 *   • it writes `return_shipments`, never `shipments`, and flips the
 *     return_request to 'picked_up'/'approved' state — never the ORDER.
 *
 * WHY AN EDGE FUNCTION. `api/` is at the Vercel Hobby ceiling of 12 routes, and
 * SQL cannot call Shiprocket. Same escape hatch as every other booking function.
 *
 * REFUND is NOT issued here. The money goes back only once the parcel is
 * physically received (apply_return_scan marks it 'received', an admin issues
 * the Razorpay refund in /admin/refunds) — a prepaid order means we are holding
 * the buyer's money, and "approved but never shipped back" must never pay out.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  CORS, SrError, getToken, json, serviceClient, srFetch, stateForPincode,
} from '../_shared/shiprocket.ts';

type ReturnRow = {
  id: string;
  order_id: string;
  boutique_id: string;
  buyer_id: string;
  reason: string;
  status: string;
};

type OrderRow = {
  id: string;
  order_number: string;
  total: number;
  payment_method: string | null;
  created_at: string;
  guest_name: string | null;
  guest_phone: string | null;
  guest_city: string | null;
  guest_address: string | null;
  guest_pincode: string | null;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { returnRequestId } = await req.json().catch(() => ({ returnRequestId: null }));
    if (!returnRequestId) return json({ error: 'returnRequestId is required' }, 400);

    // ── Who is asking ───────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Not signed in' }, 401);

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
    );
    const { data: userData } = await userClient.auth.getUser();
    const user = userData?.user;
    if (!user) return json({ error: 'Not signed in' }, 401);

    const db = serviceClient();

    // ── Is the integration on at all ────────────────────────────────────────
    const { data: settings } = await db
      .from('platform_settings').select('shiprocket_enabled').eq('id', 1).maybeSingle();
    if (!settings?.shiprocket_enabled) {
      return json({ error: 'Shiprocket booking is switched off for this platform' }, 409);
    }

    // ── The return request ──────────────────────────────────────────────────
    const { data: ret, error: retErr } = await db
      .from('return_requests')
      .select('id, order_id, boutique_id, buyer_id, reason, status')
      .eq('id', returnRequestId)
      .maybeSingle<ReturnRow>();
    if (retErr || !ret) return json({ error: 'Return request not found' }, 404);

    // ── The shop, and that it belongs to the caller ─────────────────────────
    // `boutiques` cannot be read with select('*') — column grants since 0021.
    const { data: shop } = await db
      .from('boutiques')
      .select('id, name, owner_id, phone, address_line, district, state, pincode')
      .eq('id', ret.boutique_id)
      .maybeSingle();
    if (!shop) return json({ error: 'Boutique not found' }, 404);

    // Owner, or a staff/admin acting from the console.
    let allowed = shop.owner_id === user.id;
    if (!allowed) {
      const { data: me } = await db.from('profiles').select('role').eq('id', user.id).maybeSingle();
      allowed = me?.role === 'admin' || me?.role === 'staff';
    }
    if (!allowed) return json({ error: 'Not your order' }, 403);

    if (ret.status === 'rejected' || ret.status === 'refunded') {
      return json({ error: 'This return is already closed' }, 409);
    }

    // Already has a booked parcel? Do not book a second one.
    const { data: existing } = await db
      .from('return_shipments').select('id, awb').eq('return_request_id', ret.id).maybeSingle();
    if (existing?.awb) {
      return json({ error: 'A return pickup has already been booked for this request' }, 409);
    }

    // ── The order it came from ──────────────────────────────────────────────
    const { data: order, error: orderErr } = await db
      .from('orders')
      .select('id, order_number, total, payment_method, created_at, guest_name, guest_phone, guest_city, guest_address, guest_pincode')
      .eq('id', ret.order_id)
      .maybeSingle<OrderRow>();
    if (orderErr || !order) return json({ error: 'Order not found' }, 404);

    // The parcel is collected from the buyer. Their address is on guest_* even
    // for a signed-in buyer (same as checkout / forward booking).
    const buyerPincode = (order.guest_pincode ?? '').trim();
    const buyerAddress = (order.guest_address ?? '').trim();
    if (!buyerPincode || !buyerAddress) {
      return json({ error: 'This order has no delivery address or pincode — a return cannot be collected.' }, 422);
    }
    // And delivered back to the shop.
    const shopPincode = (shop.pincode ?? '').trim();
    const shopAddress = (shop.address_line ?? '').trim();
    if (!shopPincode || !shopAddress) {
      return json({ error: 'Your shop address or pincode is missing — add it in Settings before booking a return.' }, 422);
    }

    const { data: items } = await db
      .from('order_items').select('title, price, qty, product_id').eq('order_id', order.id);
    if (!items?.length) return json({ error: 'This order has no items' }, 422);

    // ── Parcel metrics ──────────────────────────────────────────────────────
    // Reuse the order's own resolved weight/box — the same parcel is going back.
    const { data: metrics } = await userClient
      .rpc('order_parcel_metrics', { p_order_id: order.id })
      .maybeSingle<{ weight_kg: number; length_cm: number; breadth_cm: number; height_cm: number }>();
    const parcel = {
      weight: metrics?.weight_kg ?? 0.5,
      length: metrics?.length_cm ?? 15,
      breadth: metrics?.breadth_cm ?? 15,
      height: metrics?.height_cm ?? 10,
    };

    const token = await getToken(db);

    // Shiprocket validates state against pincode on both ends. The shop carries
    // its own state; the buyer's was never collected at checkout, so ask them.
    const buyerState = await stateForPincode(token, buyerPincode);
    if (!buyerState) {
      return json({ error: `Shiprocket does not recognise the buyer pincode ${buyerPincode}.` }, 422);
    }
    const shopState = (shop.state ?? '').trim() || (await stateForPincode(token, shopPincode)) || '';
    if (!shopState) {
      return json({ error: `Shiprocket does not recognise your shop pincode ${shopPincode}.` }, 422);
    }

    const buyerName = (order.guest_name ?? '').trim() || 'Customer';
    const [buyerFirst, ...buyerRest] = buyerName.split(/\s+/);
    const shopName = (shop.name ?? '').trim() || 'Boutique';
    const [shopFirst, ...shopRest] = shopName.split(/\s+/);

    // ── Approve the request (if the seller has not already) ─────────────────
    // Through the audited SECURITY DEFINER function so its ownership and
    // "already answered" guards run. A retry after a failed booking arrives here
    // already 'approved'/'picked_up', so only call it from 'requested'.
    if (ret.status === 'requested') {
      const { error: approveErr } = await userClient.rpc('resolve_return_request', {
        p_request_id: ret.id, p_status: 'approved', p_note: null,
      });
      if (approveErr) return json({ error: approveErr.message || 'Could not approve the return' }, 403);
    }

    // ── 1. Create the return order ──────────────────────────────────────────
    // Unique per attempt (order number + time suffix), same reasoning as the
    // forward booking: a re-book must not collide with a stale Shiprocket order.
    const srOrderId = `RET-${order.order_number}-${Date.now().toString(36).slice(-6)}`;
    const created = await srFetch<{ order_id: number; shipment_id: number }>(token, '/orders/create/return', {
      method: 'POST',
      body: {
        order_id: srOrderId,
        order_date: order.created_at.slice(0, 16).replace('T', ' '),
        channel_id: '',
        // Collected FROM the buyer.
        pickup_customer_name: buyerFirst,
        pickup_last_name: buyerRest.join(' ') || buyerFirst,
        pickup_address: buyerAddress,
        pickup_city: (order.guest_city ?? '').trim() || buyerState,
        pickup_state: buyerState,
        pickup_country: 'India',
        pickup_pincode: buyerPincode,
        pickup_email: '',
        pickup_phone: (order.guest_phone ?? '').replace(/\D/g, '').slice(-10),
        // Delivered back TO the shop.
        shipping_customer_name: shopFirst,
        shipping_last_name: shopRest.join(' ') || shopFirst,
        shipping_address: shopAddress,
        shipping_city: (shop.district ?? '').trim() || shopState,
        shipping_country: 'India',
        shipping_pincode: shopPincode,
        shipping_state: shopState,
        shipping_email: '',
        shipping_phone: String(shop.phone ?? '').replace(/\D/g, '').slice(-10),
        order_items: items.map((it) => ({
          name: it.title,
          sku: it.product_id ?? it.title.slice(0, 40),
          units: it.qty,
          selling_price: it.price,
        })),
        payment_method: 'Prepaid',
        total_discount: 0,
        sub_total: order.total,
        length: parcel.length,
        breadth: parcel.breadth,
        height: parcel.height,
        weight: parcel.weight,
      },
    });

    if (!created?.shipment_id) {
      return json({ error: 'Shiprocket accepted the return but returned no shipment id' }, 502);
    }

    // ── 2. Assign an AWB (is_return = 1) ────────────────────────────────────
    const awbRes = await srFetch<{
      response?: { data?: { awb_code?: string; courier_name?: string; freight_charges?: number } };
    }>(token, '/courier/assign/awb', {
      method: 'POST',
      body: { shipment_id: created.shipment_id, is_return: 1 },
    });

    const awb = awbRes?.response?.data?.awb_code;
    const courierName = awbRes?.response?.data?.courier_name ?? 'Shiprocket';
    const freight = awbRes?.response?.data?.freight_charges ?? null;

    if (!awb) {
      console.warn('return-pickup: no AWB assigned', { returnRequestId: ret.id, buyerPincode });
      return json({
        error: 'Shiprocket could not arrange a courier to collect the return right now. Try again shortly, or arrange the return with your own courier.',
      }, 502);
    }

    // ── 3 & 4. Label and pickup — best-effort ───────────────────────────────
    let labelUrl: string | null = null;
    try {
      const label = await srFetch<{ label_url?: string }>(token, '/courier/generate/label', {
        method: 'POST', body: { shipment_id: [created.shipment_id] },
      });
      labelUrl = label?.label_url ?? null;
    } catch (_e) { /* a missing label costs a click in their panel, nothing more */ }

    const pickupTask = srFetch(token, '/courier/generate/pickup', {
      method: 'POST', body: { shipment_id: [created.shipment_id] },
    }).catch(() => { /* best-effort; can be requested from their panel */ });
    // deno-lint-ignore no-explicit-any
    const edgeRuntime = (globalThis as any).EdgeRuntime;
    if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(pickupTask);

    // ── Record the reverse parcel ───────────────────────────────────────────
    const { error: rsErr } = await db.from('return_shipments').insert({
      return_request_id: ret.id,
      order_id: order.id,
      boutique_id: ret.boutique_id,
      provider: 'shiprocket',
      awb,
      sr_order_id: String(created.order_id ?? ''),
      sr_shipment_id: String(created.shipment_id),
      courier_name: courierName,
      label_url: labelUrl,
      freight_charge: freight,
      declared_weight_kg: parcel.weight,
      status: 'booked',
      created_by: user.id,
    });
    if (rsErr) {
      console.error('return_shipments insert failed after booking', { awb, error: rsErr.message });
      return json({
        booked: true,
        error: `The return was booked (AWB ${awb}) but could not be saved. Do NOT book again — send this AWB to support.`,
      }, 500);
    }

    // Tell the buyer the collection is arranged.
    try {
      await db.from('notifications').insert({
        profile_id: ret.buyer_id,
        type: 'Orders',
        title: 'Return pickup scheduled',
        body: `A courier (${courierName}) will collect your return for order ${order.order_number}. AWB ${awb}.`,
        order_id: order.id,
      });
    } catch (_e) { /* best-effort */ }

    return json({ ok: true, awb, courierName, labelUrl, freightCharge: freight });
  } catch (e) {
    if (e instanceof SrError) {
      console.error('return-pickup SrError', e.status, e.message, e.body);
      return json({ error: e.message }, e.status >= 500 ? 502 : e.status);
    }
    console.error('return-pickup failed', e);
    return json({ error: e instanceof Error ? e.message : 'Return booking failed' }, 500);
  }
});

/**
 * Register one boutique as a Shiprocket pickup address — SELF-SERVICE.
 *
 * The seller who owns the shop can register their OWN pickup (an admin may too),
 * so onboarding and the first courier booking can set this up without anyone in
 * the admin console (changed 2026-11-25; it was admin-only before). It stays the
 * boundary: the caller must own the boutique or be an admin, checked here, never
 * trusted from the client.
 *
 * THE LIMIT WORTH KNOWING (migration 0068): Shiprocket's panel asks a human to
 * confirm a pin on a map; their API takes no coordinates and geocodes the text
 * address instead. So this is only as good as the seller's own `address_line`
 * and `pincode`. A short or number-less address is refused here with a plain
 * message (EXPECTED_PICKUP_ADDRESS) rather than registered badly — a pickup the
 * rider cannot find fails silently at collection, days later. Refusing is safe:
 * booking falls back to DTDC / a manual docket when Shiprocket is not available.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { CORS, SrError, getToken, json, serviceClient, srFetch } from '../_shared/shiprocket.ts';

type Shop = {
  id: string;
  name: string;
  owner_id: string;
  owner_name: string | null;
  email: string | null;
  phone: string | null;
  address_line: string | null;
  district: string | null;
  state: string | null;
  pincode: string | null;
  shiprocket_pickup_location: string | null;
  shiprocket_pickup_registered_at: string | null;
};

/** Kept in step with src/lib/shiprocketAddress.ts so the seller reads the same
 *  guidance in the browser and back from the server. */
const EXPECTED_PICKUP_ADDRESS =
  'Shiprocket needs your pickup address to start with a clear door/house number and be at least 10 characters — for example “No.12, Gandhi Street, Mettupalayam”.';

/** The obvious misses, caught before we bother Shiprocket. Lenient by design. */
function addressIssue(addr: string | null): string | null {
  const a = (addr ?? '').trim();
  if (a.length < 10) return EXPECTED_PICKUP_ADDRESS;
  if (!/\d/.test(a)) return EXPECTED_PICKUP_ADDRESS;
  return null;
}

/**
 * Shiprocket's `pickup_location` is a short unique key, not a label — it is
 * matched literally on every booking. Built from the shop name so the panel
 * stays readable, suffixed with part of the boutique id so two shops called
 * "Nila Designers" cannot collide, and truncated because they reject long ones.
 */
function makeNickname(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 22)
    .replace(/-+$/, '');
  return `mm-${slug || 'shop'}-${id.replace(/-/g, '').slice(0, 6)}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const db = serviceClient();
  let boutiqueId: string | null = null;

  try {
    const body = await req.json().catch(() => ({}));
    boutiqueId = body?.boutiqueId ?? null;
    if (!boutiqueId) return json({ error: 'boutiqueId is required' }, 400);

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

    // ── Is the integration on ───────────────────────────────────────────────
    const { data: settings } = await db
      .from('platform_settings').select('shiprocket_enabled').eq('id', 1).maybeSingle();
    if (!settings?.shiprocket_enabled) {
      return json({ error: 'Shiprocket is switched off for this platform' }, 409);
    }

    // `boutiques` cannot be read with select('*') — column grants since 0021.
    const { data: shop } = await db
      .from('boutiques')
      .select('id, name, owner_id, owner_name, email, phone, address_line, district, state, pincode, shiprocket_pickup_location, shiprocket_pickup_registered_at')
      .eq('id', boutiqueId)
      .maybeSingle<Shop>();
    if (!shop) return json({ error: 'Boutique not found' }, 404);

    // ── The caller owns this shop, or is an admin ───────────────────────────
    const { data: profile } = await db
      .from('profiles').select('role').eq('id', user.id).maybeSingle();
    const isOwner = shop.owner_id === user.id;
    const isAdmin = profile?.role === 'admin';
    if (!isOwner && !isAdmin) return json({ error: 'This is not your shop' }, 403);

    // Already registered BY US — a nickname AND the stamp we write on success.
    // A bare nickname with no stamp was pasted in by hand against no real
    // Shiprocket location (and would 502 every booking), so it is re-registered
    // rather than trusted. Returned as success, not an error: the caller may
    // fire this more than once and must not open a second collection point.
    if (shop.shiprocket_pickup_location && shop.shiprocket_pickup_registered_at) {
      return json({ ok: true, alreadyRegistered: true, nickname: shop.shiprocket_pickup_location });
    }

    // ── Refuse to guess, in words the seller can act on ─────────────────────
    const phone = (shop.phone ?? '').replace(/\D/g, '').slice(-10);
    if (!/^\d{6}$/.test((shop.pincode ?? '').trim())) {
      const m = 'Add a valid 6-digit pincode to your shop profile to set up courier pickup.';
      await db.from('boutiques').update({ shiprocket_pickup_error: m }).eq('id', shop.id);
      return json({ error: m, needsAddress: true }, 422);
    }
    if (phone.length !== 10) {
      const m = 'Add a 10-digit contact phone to your shop profile so the courier can reach you.';
      await db.from('boutiques').update({ shiprocket_pickup_error: m }).eq('id', shop.id);
      return json({ error: m, needsAddress: true }, 422);
    }
    const addrProblem = addressIssue(shop.address_line);
    if (addrProblem) {
      await db.from('boutiques').update({ shiprocket_pickup_error: addrProblem }).eq('id', shop.id);
      return json({ error: addrProblem, needsAddress: true }, 422);
    }

    const nickname = makeNickname(shop.name, shop.id);
    const token = await getToken(db);

    let created: { success?: boolean; address?: { pickup_location?: string } };
    try {
      created = await srFetch<{ success?: boolean; address?: { pickup_location?: string } }>(
        token,
        '/settings/company/addpickup',
        {
          method: 'POST',
          body: {
            pickup_location: nickname,
            name: (shop.owner_name ?? shop.name).slice(0, 36),
            email: shop.email ?? '',
            phone,
            address: shop.address_line!.trim().slice(0, 120),
            address_2: '',
            city: (shop.district ?? '').trim(),
            state: (shop.state ?? '').trim(),
            country: 'India',
            pin_code: shop.pincode!.trim(),
          },
        },
      );
    } catch (e) {
      // Shiprocket's address validator is pickier than ours: it rejects a door
      // number like "2," that it cannot read, with a raw field-error blob. When
      // the complaint is about the address, swap it for the plain guidance so
      // the seller fixes the format rather than reading JSON. Anything else is
      // surfaced as-is. Either way this is a "fix your address" 422, not a 500,
      // so the booking chain treats Shiprocket as declined and falls back.
      if (e instanceof SrError) {
        const raw = JSON.stringify(e.body ?? e.message).toLowerCase();
        const message = raw.includes('address') ? EXPECTED_PICKUP_ADDRESS : e.message;
        await db.from('boutiques').update({ shiprocket_pickup_error: message }).eq('id', shop.id);
        return json({ error: message, needsAddress: raw.includes('address') }, 422);
      }
      throw e;
    }

    // Trust what comes back over what we sent: Shiprocket may normalise or
    // de-duplicate the nickname, and booking matches THEIR value literally.
    const saved = created?.address?.pickup_location ?? nickname;

    const { error: saveErr } = await db
      .from('boutiques')
      .update({
        shiprocket_pickup_location: saved,
        shiprocket_pickup_registered_at: new Date().toISOString(),
        shiprocket_pickup_error: null,
        // Self-service: a shop that just registered its own pickup is ready to
        // book on Shiprocket, so switch it on here rather than waiting for an
        // admin. The platform master switch still governs whether Shiprocket is
        // offered at all.
        shiprocket_enabled: true,
      })
      .eq('id', shop.id);

    if (saveErr) {
      console.error('pickup saved at Shiprocket but not in DB', { nickname: saved, error: saveErr.message });
      return json({
        error: `Pickup address “${saved}” was created at Shiprocket but could not be saved here. Try again in a moment.`,
      }, 500);
    }

    return json({ ok: true, nickname: saved });
  } catch (e) {
    const message = e instanceof SrError
      ? e.message
      : e instanceof Error ? e.message : 'Could not register the pickup address';
    if (boutiqueId) {
      await db.from('boutiques').update({ shiprocket_pickup_error: message }).eq('id', boutiqueId);
    }
    console.error('shiprocket-pickup failed', e);
    return json({ error: message }, e instanceof SrError && e.status < 500 ? e.status : 502);
  }
});

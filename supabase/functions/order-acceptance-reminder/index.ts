/**
 * "The seller still hasn't accepted" reminder — email sender + sweep trigger.
 *
 * WHAT IT IS
 * The email arm of the 24h order-acceptance reminder (migration 0129). The SQL
 * sweep `sweep_pending_acceptance_reminders()` does the in-app bell row and the
 * WhatsApp enqueue itself — both are things SQL can do — and CLAIMS each order
 * (stamps `acceptance_reminded_at`) so nothing sends twice. It returns the rows
 * that still need an email; this function mails them through Resend. Email is
 * the only one of the three channels SQL can't send, which is the whole reason
 * an edge function exists here (same split as daily-report).
 *
 * WHY AN EDGE FUNCTION AND NOT api/
 * api/ is at the 12-route Vercel Hobby ceiling and the one cron slot is taken by
 * the ads lifecycle sweep (see api/_email.js and daily-report). New scheduled
 * senders go here, invoked by pg_cron.
 *
 * WHO MAY CALL IT
 * pg_cron, with a bearer token in the Authorization header. The token is read
 * from Vault by require_cron_secret('acceptance_reminder_token') (0113) at call
 * time. The service-role key is also accepted, so the owner can fire it by hand
 * without minting the cron token. Anything else is 401. Deploys --no-verify-jwt:
 * the caller is a database job, not a signed-in user.
 *
 * ONCE-ONLY
 * Guaranteed in SQL, not here: the sweep stamps `acceptance_reminded_at` under
 * the row lock as it reads each order, so a retry, a manual run, or two callers
 * racing cannot re-send. This function can be called as often as you like.
 *
 * DEPLOY
 *   supabase functions deploy order-acceptance-reminder --no-verify-jwt
 *   supabase secrets set \
 *     ACCEPTANCE_REMINDER_TOKEN=<same value you put in Vault> \
 *     RESEND_API_KEY=<...> EMAIL_FROM="MangaiMart <orders@mangaimart.com>" \
 *     APP_URL=https://mangaimart.com
 *   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.)
 * Then create the Vault secret and schedule it — see migration 0129's foot.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_TOKEN = Deno.env.get('ACCEPTANCE_REMINDER_TOKEN') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';

/** Mirrors senderFrom() in api/_email.js — always a display name on the header. */
const senderFrom = (raw: string | undefined, brand = 'MangaiMart') => {
  const value = (raw ?? '').trim() || 'orders@mangaimart.com';
  return value.includes('<') ? value : `${brand} <${value}>`;
};
const EMAIL_FROM = senderFrom(Deno.env.get('EMAIL_FROM') ?? Deno.env.get('REPORT_FROM'));

/** The seller console lives under /seller; a reminder deep-links to the order. */
const rawAppUrl = (Deno.env.get('APP_URL') ?? '').trim().replace(/\/$/, '');
const APP_URL = (!rawAppUrl || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(rawAppUrl))
  ? 'https://mangaimart.com'
  : rawAppUrl;

const LOGO_URL = Deno.env.get('EMAIL_LOGO_URL') ?? 'https://mangaimart.com/mangaimart-wordmark.png';

type ReminderRow = {
  o_order_id: string;
  o_order_number: string;
  o_shop_name: string;
  o_shop_email: string;
  o_buyer_name: string;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Escape for HTML — order data is user-supplied. Mirrors esc() in api/_email.js. */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The shared email shell, trimmed to what a single-message reminder needs and
 * kept byte-for-byte in the house style of api/_email.js `layout()`: literal
 * light-theme hex (a mail client can't resolve our --ag-* tokens — CLAUDE.md
 * rule 4 exempts email), Georgia serif heading, crimson CTA, inline attributes
 * only. Reimplemented rather than imported because that module is Node and this
 * is Deno.
 */
function renderEmail(row: ReminderRow): { html: string; text: string } {
  const heading = 'An order is still waiting for you';
  const orderUrl = `${APP_URL}/seller/orders/${row.o_order_id}`;
  const intro = `Hi ${row.o_shop_name}, order ${row.o_order_number} was placed and paid for `
    + `24 hours ago and still hasn't been accepted. ${row.o_buyer_name} has already paid and is waiting to hear from you.`;
  const body = `Please open your console and <strong>accept or reject</strong> it. `
    + `Orders left unanswered hold up the buyer's money and hurt your shop's rating — if you can't fulfil it, rejecting it refunds them straight away.`;

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(heading)}</title>
<style>
  body, table, td, p, h1, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; text-size-adjust:100%; }
  @media only screen and (max-width:600px) {
    .ag-pad { padding-left:18px !important; padding-right:18px !important; }
    .ag-h1 { font-size:19px !important; line-height:1.32 !important; }
    .ag-logo { width:168px !important; }
    .ag-body p { font-size:13.5px !important; line-height:1.6 !important; }
    .ag-btn { font-size:13.5px !important; padding:12px 22px !important; }
  }
</style></head>
<body style="margin:0;padding:0;background:#FBF6F2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF6F2;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #EFDCE4;">
    <tr><td align="center" style="background:#FFF8F4;padding:22px 24px 20px;border-bottom:1px solid #F4E7ED;">
      <a href="https://mangaimart.com" style="text-decoration:none;">
        <img src="${LOGO_URL}" width="210" alt="MangaiMart" class="ag-logo" style="display:block;margin:0 auto;width:210px;max-width:72%;height:auto;border:0;outline:none;text-decoration:none;" />
      </a>
    </td></tr>
    <tr><td align="center" class="ag-pad" style="padding:26px 24px 8px;text-align:center;">
      <h1 class="ag-h1" style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:21px;line-height:1.3;color:#241019;font-weight:700;text-align:center;">${esc(heading)}</h1>
    </td></tr>
    <tr><td align="left" class="ag-pad ag-body" style="padding:10px 24px 0;text-align:left;">
      <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#4B3840;text-align:left;">${esc(intro)}</p>
    </td></tr>
    <tr><td align="left" class="ag-pad ag-body" style="padding:14px 24px 0;text-align:left;">
      <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#4B3840;text-align:left;">${body}</p>
    </td></tr>
    <tr><td align="center" class="ag-pad" style="padding:24px 24px 4px;text-align:center;">
      <a href="${esc(orderUrl)}" class="ag-btn" style="display:inline-block;background:#B02454;color:#FFFFFF;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;padding:13px 26px;border-radius:10px;">Accept or reject this order</a>
    </td></tr>
    <tr><td align="center" class="ag-pad" style="padding:24px 24px 26px;text-align:center;">
      <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11.5px;line-height:1.6;color:#836B74;text-align:center;">
        MangaiMart — ethnic wear from verified independent boutiques.<br />
        This is a transactional message about an order on your boutique, not marketing.
      </p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  const text = `${heading}\n\n${intro}\n\nOpen the order: ${orderUrl}\n\n`
    + `Accept or reject it so the buyer isn't left waiting. Rejecting refunds them straight away.\n\n`
    + `MangaiMart — a transactional message about an order on your boutique.`;

  return { html, text };
}

/** Call the service-role sweep RPC and get back the rows that need an email. */
async function runSweep(): Promise<ReminderRow[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/sweep_pending_acceptance_reminders`, {
    method: 'POST',
    // Bounded, like daily-report's rpc(): Deno fetch has no default timeout and a
    // hang would burn the whole wall clock. The sweep is a small indexed write.
    signal: AbortSignal.timeout(20_000),
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_min_age_hours: 24 }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`sweep failed (${res.status}): ${(body as { message?: string })?.message ?? 'no detail'}`);
  }
  return (body as ReminderRow[]) ?? [];
}

/**
 * Mail every returned row through Resend's batch endpoint — one message each,
 * per-recipient, like daily-report's sendAll(). The orders have already been
 * claimed in SQL, so a Resend failure here means those shops miss the EMAIL for
 * this order (they still got the in-app + WhatsApp reminder); it does not and
 * must not un-claim them.
 */
async function sendEmails(rows: ReminderRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');

  const messages = rows.map((row) => {
    const { html, text } = renderEmail(row);
    return {
      from: EMAIL_FROM,
      to: [row.o_shop_email],
      subject: `Order ${row.o_order_number} is still waiting for your reply`,
      html,
      text,
    };
  });

  const res = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    signal: AbortSignal.timeout(45_000),
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(messages),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  return messages.length;
}

async function runReminders() {
  try {
    const rows = await runSweep();
    const emailed = await sendEmails(rows);
    return { ok: true, emailed };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error('[order-acceptance-reminder]', message);
    return { ok: false, error: message };
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const authorised = bearer.length > 0 && (bearer === SERVICE_KEY || (CRON_TOKEN && bearer === CRON_TOKEN));
  if (!authorised) return json({ error: 'Unauthorized' }, 401);

  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'Supabase env missing' }, 500);

  const url = new URL(req.url);
  const body = req.method === 'POST'
    ? (await req.json().catch(() => ({}))) as Record<string, unknown>
    : {};
  // `sync` waits for the work and returns its result, for firing by hand.
  const sync = url.searchParams.get('sync') === '1' || body.sync === true;

  const work = runReminders();
  if (sync) return json(await work);

  // ANSWER FIRST, WORK AFTER — pg_net's default timeout is 5 seconds and the
  // sweep + Resend batch can take longer; a cut-off caller would otherwise kill
  // the send mid-flight (the failure daily-report documents at length). Handing
  // the promise to the runtime makes this immune to the caller's timeout. The
  // claim is already durable in SQL whatever happens next.
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt && typeof rt.waitUntil === 'function') {
    rt.waitUntil(work.catch((err) => console.error('[order-acceptance-reminder background]', err)));
    return json({ ok: true, accepted: true, note: 'sending in background' }, 202);
  }

  return json(await work);
});

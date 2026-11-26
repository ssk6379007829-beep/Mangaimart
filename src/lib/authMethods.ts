import { supabase } from '@/lib/supabase';

/**
 * Social / one-time-code auth helpers for buyers.
 *
 * Buyers sign in with Google or with email + password (the latter through
 * AuthContext's sign-in/up). Once signed in they have a real account, so their
 * profile syncs via the `profiles` table and their orders via the `buyer_id`
 * RLS policy.
 *
 * Email auth here is entirely LINK-based — there are no 6-digit codes. Signup
 * confirmation and forgot-password both send a link that lands on
 * `/auth/callback` or `/auth/reset-password`; neither needs a `{{ .Token }}`
 * email template, because Supabase's default confirm/recovery templates are
 * links out of the box.
 *
 * Config: Google needs the Google provider enabled in the Supabase dashboard
 * (Auth → Providers → Google) with this app's URL added to the allowed redirect
 * URLs. The confirm-signup and recovery redirect URLs must be allow-listed
 * (Auth → URL Configuration).
 */

/** Shown whenever the cause is ours, not something the user can act on. */
const SEND_FAILED =
  'We couldn’t send that email just now. Please try again, or contact support if it keeps failing.';

/** Human-friendly text for the raw Supabase auth errors. */
export function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  // gotrue-js has no prose to show when GoTrue returns a non-2xx with an empty
  // or unrecognised body, so it falls back to JSON.stringify — which reaches the
  // buyer as a literal "{}". Anything JSON-shaped or blank is an infrastructure
  // failure on our side, not something they typed wrong.
  const t = message.trim();
  if (!t || t === '{}' || t === '[]' || t.startsWith('{') || t.startsWith('[')) return SEND_FAILED;
  if (m.includes('provider is not enabled') || m.includes('unsupported provider')) {
    return 'That sign-in method isn’t set up yet. Try email instead.';
  }
  if (m.includes('invalid') && m.includes('token')) return 'That code is incorrect or expired. Please try again.';
  if (m.includes('otp') && m.includes('expired')) return 'That code has expired — request a new one.';
  if (m.includes('email not confirmed')) return 'Please confirm your email, then try again.';
  if (m.includes('invalid login credentials')) return 'Wrong email or password.';
  if (m.includes('email rate limit')) {
    return 'Our email service is over its sending limit right now — try again in a little while.';
  }
  // SMTP "minimum interval per user" (60s by default) surfaces as
  // "For security purposes, you can only request this after N seconds."
  // Quote the real wait back rather than a generic "wait a minute".
  const throttled = /after (\d+) seconds?/.exec(m);
  if (throttled) return `Please wait ${throttled[1]} seconds before requesting another email.`;
  if (m.includes('rate') || m.includes('too many')) return 'Too many attempts — wait a minute and retry.';
  // GoTrue reports SMTP failures as "Error sending confirmation/recovery email".
  // Left raw it reads like the buyer did something wrong, when it's our outage.
  if (m.includes('error sending') || m.includes('unexpected_failure')) return SEND_FAILED;
  return message;
}

// OAuth loses the buyer/seller intent across the Google round-trip, so we stash
// it here and read it back in the /auth/callback route.
const OAUTH_ROLE_KEY = 'agx-oauth-role';
// Same problem for the page the sign-in interrupted (`?next=/checkout`): Google
// returns to /auth/callback, so the query string of the login page is gone.
const OAUTH_NEXT_KEY = 'agx-oauth-next';

/**
 * Kick off Google OAuth for the given role. Redirects to Google and back to
 * /auth/callback, which routes buyers to their profile and sellers to their
 * console (or boutique onboarding if they don't have one yet) — or straight to
 * `next` when the sign-in was a gate on the way somewhere (e.g. checkout).
 */
export async function signInWithGoogle(role: 'buyer' | 'seller' = 'buyer', next?: string | null): Promise<void> {
  try {
    localStorage.setItem(OAUTH_ROLE_KEY, role);
    if (next) localStorage.setItem(OAUTH_NEXT_KEY, next);
    else localStorage.removeItem(OAUTH_NEXT_KEY);
  } catch {
    /* storage unavailable — callback falls back to buyer */
  }
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${window.location.origin}/auth/callback` },
  });
  if (error) throw new Error(friendlyAuthError(error.message));
}

/** The role an in-flight Google sign-in was started for (defaults to buyer). */
export function readPendingOAuthRole(): 'buyer' | 'seller' {
  try {
    return localStorage.getItem(OAUTH_ROLE_KEY) === 'seller' ? 'seller' : 'buyer';
  } catch {
    return 'buyer';
  }
}

/** The in-app path an in-flight Google sign-in should return to, if any. */
export function readPendingOAuthNext(): string | null {
  try {
    return localStorage.getItem(OAUTH_NEXT_KEY);
  } catch {
    return null;
  }
}

export function clearPendingOAuthRole(): void {
  try {
    localStorage.removeItem(OAUTH_ROLE_KEY);
    localStorage.removeItem(OAUTH_NEXT_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Re-send the signup confirmation EMAIL (a link) to an address that signed up but
 * hasn't confirmed yet. Opening the link lands on /auth/callback, which routes
 * the new seller back into onboarding. Confirmation is link-based — the project's
 * "Confirm signup" template is Supabase's default link, so no `{{ .Token }}`
 * template edit is required.
 */
export async function resendSignupConfirmation(email: string): Promise<void> {
  const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim() });
  if (error) throw new Error(friendlyAuthError(error.message));
}

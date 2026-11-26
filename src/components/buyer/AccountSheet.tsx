import { useState } from 'react';
import { css } from '@/lib/css';
import { useAuth } from '@/auth/AuthContext';
import { signInWithGoogle, friendlyAuthError } from '@/lib/authMethods';
import { ConsentCheckbox, ConsentNotice, CONSENT_REQUIRED } from '@/components/legal/Consent';
import { GoogleIcon } from '@/components/ui/GoogleIcon';

const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

/**
 * Buyer sign-in / sign-up sheet.
 *
 * The sheet is one screen at a time, the way the seller and admin logins are:
 * email + password is the only way to sign in with an address (Google is the
 * other method). A blank password used to mean "email me a code instead", which
 * put two different sign-in methods behind one ambiguous field — the primary
 * button changed meaning depending on whether the field had text in it.
 *
 * Forgot-password is `forgot → sent`: we email a secure reset LINK (the same
 * flow the admin and seller logins use) and the buyer opens it to land on
 * `/auth/reset-password`, where they choose a new password. It doubles as how a
 * buyer who joined with Google sets a password for the first time — a recovery
 * link opens a session for any existing account, with or without a password.
 * (This replaced an emailed 6-digit code that depended on the Supabase
 * "Magic Link" template carrying `{{ .Token }}`; the recovery template is a
 * link out of the box, so this flow needs no dashboard template edit.)
 *
 * On success the browser holds a Supabase session and `onDone` fires so the
 * caller can sync.
 */
export function AccountSheet({
  onDone,
  onClose,
  title,
  subtitle,
}: {
  onDone: () => void;
  onClose: () => void;
  /** Override the sign-in heading/subtext so the sheet can be reused as a
   * context-specific gate (e.g. "Sign in to chat"). Every other view keeps its
   * own copy. */
  title?: string;
  subtitle?: string;
}) {
  const { signInWithPassword, signUpWithPassword, sendPasswordReset } = useAuth();
  const [view, setView] = useState<'signin' | 'create' | 'forgot' | 'sent'>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const inputStyle = css('display:block;width:100%;margin-top:7px;border:1.5px solid var(--ag-border);background:var(--ag-bg);border-radius:14px;padding:0 15px;height:52px;font-size:15px;font-weight:600;color:var(--ag-ink);box-sizing:border-box;');
  const labelStyle = css('font-size:12.5px;font-weight:800;color:var(--ag-label);display:block;');
  const primaryStyle = (extra = '') => css(`width:100%;height:54px;margin-top:18px;border:none;border-radius:16px;background:linear-gradient(135deg,#D6336C,#B02454);color:#fff;font-weight:800;font-size:16px;cursor:pointer;box-shadow:0 14px 30px -14px rgba(214,51,108,.8);display:flex;align-items:center;justify-content:center;gap:8px;opacity:${busy ? 0.7 : 1};${extra}`);
  const linkStyle = css('font-weight:800;color:var(--ag-crimson);');
  const quietButton = css('width:100%;height:44px;margin-top:8px;border:none;background:none;color:var(--ag-muted);font-weight:700;font-size:14px;cursor:pointer;');

  /** Moving between views must not carry an error from the previous one. */
  const go = (next: typeof view) => { setError(''); setView(next); };

  const google = async () => {
    setBusy(true);
    setError('');
    try {
      await signInWithGoogle(); // redirects away on success
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Google sign-in failed');
      setBusy(false);
    }
  };

  const signIn = async () => {
    if (!emailOk(email)) return setError('Enter a valid email address.');
    if (!password) return setError('Enter your password.');
    setBusy(true);
    setError('');
    try {
      await signInWithPassword(email.trim(), password, 'buyer');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? friendlyAuthError(e.message) : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (name.trim().length < 2) return setError('Enter your name.');
    if (!emailOk(email)) return setError('Enter a valid email address.');
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (!consent) return setError(CONSENT_REQUIRED);
    setBusy(true);
    setError('');
    try {
      const { confirmationRequired } = await signUpWithPassword(email.trim(), password, { full_name: name.trim(), role: 'buyer' });
      if (confirmationRequired) { setBusy(false); return setError('Check your email to confirm, then sign in.'); }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? friendlyAuthError(e.message) : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  // Email a reset LINK. The confirmation is deliberately non-committal ("if that
  // email has an account"), so the sheet never reveals who is registered — and
  // `sendPasswordReset` (resetPasswordForEmail) likewise never errors on an
  // unknown address, so there is no enumeration oracle here either.
  const sendLink = async () => {
    if (!emailOk(email)) return setError('Enter a valid email address.');
    setBusy(true);
    setError('');
    try {
      await sendPasswordReset(email.trim(), `${window.location.origin}/auth/reset-password`);
      go('sent');
    } catch (e) {
      setError(e instanceof Error ? friendlyAuthError(e.message) : 'Could not send the reset link');
    } finally {
      setBusy(false);
    }
  };

  const HEAD: Record<typeof view, { icon: string; heading: string; sub: string }> = {
    signin: { icon: 'account_circle', heading: title ?? 'Sign in to sync', sub: subtitle ?? 'Keep your orders & details on any device.' },
    create: { icon: 'account_circle', heading: 'Create your account', sub: 'Keep your orders & details on any device.' },
    forgot: { icon: 'lock_reset', heading: 'Forgot your password?', sub: 'Enter your email and we’ll send a secure link to reset it. This is also how you set a password for the first time if you joined with Google.' },
    sent: { icon: 'mark_email_read', heading: 'Check your email', sub: `If ${email} has an account, a reset link is on its way. Open it on this device to set a new password.` },
  };
  const head = HEAD[view];

  const errorLine = error && (
    <div
      role="alert"
      style={css('display:flex;align-items:center;justify-content:center;gap:6px;color:var(--ag-danger-text);font-size:12.5px;font-weight:700;margin-top:12px;text-align:center;line-height:1.5;')}
    >
      <span aria-hidden="true" translate="no" style={css("font-family:'Material Symbols Outlined';font-size:16px;flex:none;")}>error</span>
      {error}
    </div>
  );

  return (
    <div
      onClick={onClose}
      style={css('position:fixed;inset:0;z-index:230;background:rgba(40,10,22,.5);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto;')}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={css('width:100%;max-width:440px;margin:auto;background:var(--ag-surface);border-radius:28px;padding:24px 24px 26px;box-shadow:0 30px 80px -30px rgba(107,20,54,.6);')}
      >
        <div style={css('width:56px;height:56px;border-radius:17px;background:linear-gradient(135deg,#D6336C,#B02454);display:flex;align-items:center;justify-content:center;margin:0 auto;box-shadow:0 16px 34px -16px rgba(214,51,108,.8);')}>
          <span aria-hidden="true" style={css("font-family:'Material Symbols Outlined';color:#fff;font-size:28px;")}>{head.icon}</span>
        </div>
        <div style={css("font-family:var(--ag-display);font-weight:700;font-size:24px;text-align:center;margin-top:15px;line-height:1.15;")}>{head.heading}</div>
        <div style={css('text-align:center;color:var(--ag-muted);font-size:13.5px;margin-top:8px;line-height:1.5;max-width:330px;margin-left:auto;margin-right:auto;')}>{head.sub}</div>

        {/* ─────────────── Sign in / create: email + password ─────────────── */}
        {(view === 'signin' || view === 'create') && (
          <>
            <button
              onClick={google}
              disabled={busy}
              style={css('width:100%;height:52px;margin-top:22px;border:1.5px solid var(--ag-border);background:var(--ag-surface);border-radius:14px;font-weight:800;font-size:15px;color:var(--ag-ink);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;')}
            >
              <GoogleIcon size={20} />Continue with Google
            </button>

            <div style={css('display:flex;align-items:center;gap:12px;color:var(--ag-muted-soft);font-size:12.5px;margin:16px 0;')}>
              <div style={css('flex:1;height:1px;background:var(--ag-border);')} />or<div style={css('flex:1;height:1px;background:var(--ag-border);')} />
            </div>

            <div style={css('display:flex;flex-direction:column;gap:13px;')}>
              {view === 'create' && (
                <label style={labelStyle}>Full name
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" style={inputStyle} />
                </label>
              )}
              <label style={labelStyle}>Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" style={inputStyle} />
              </label>
              <label style={labelStyle}>Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void (view === 'create' ? create() : signIn()); }}
                  placeholder="••••••••"
                  autoComplete={view === 'create' ? 'new-password' : 'current-password'}
                  style={inputStyle}
                />
                {view === 'create' && <span style={css('display:block;font-size:11.5px;font-weight:600;color:var(--ag-muted);margin-top:6px;')}>At least 8 characters.</span>}
              </label>
              {view === 'signin' && (
                <div style={css('display:flex;justify-content:flex-end;margin-top:-4px;')}>
                  <a href="#" onClick={(e) => { e.preventDefault(); go('forgot'); }} style={css('font-size:12.5px;font-weight:800;color:var(--ag-crimson);')}>Forgot password?</a>
                </div>
              )}
            </div>

            {view === 'create' && (
              <div style={css('margin-top:14px;')}>
                <ConsentCheckbox checked={consent} onChange={setConsent} />
              </div>
            )}

            {errorLine}

            <button onClick={view === 'create' ? create : signIn} disabled={busy} style={primaryStyle()}>
              {busy ? 'Please wait…' : view === 'create' ? 'Create account' : 'Sign in'}
              {!busy && <span aria-hidden="true" style={css("font-family:'Material Symbols Outlined';font-size:20px;")}>arrow_forward</span>}
            </button>

            <div style={css('text-align:center;font-size:13.5px;color:var(--ag-muted);margin-top:14px;')}>
              {view === 'signin' ? 'New to MangaiMart? ' : 'Have an account? '}
              <a href="#" onClick={(e) => { e.preventDefault(); go(view === 'signin' ? 'create' : 'signin'); }} style={linkStyle}>
                {view === 'signin' ? 'Create account' : 'Sign in'}
              </a>
            </div>

            {/* Clickwrap covering Google and returning sign-in; create mode also
                has the required tickbox. */}
            <div style={css('margin-top:14px;')}>
              <ConsentNotice />
            </div>
          </>
        )}

        {/* ─────────────── Forgot password: email → reset link ─────────────── */}
        {view === 'forgot' && (
          <>
            <div style={css('margin-top:22px;')}>
              <label style={labelStyle}>Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void sendLink(); }}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoFocus
                  style={inputStyle}
                />
              </label>
            </div>

            {errorLine}

            <button onClick={sendLink} disabled={busy} style={primaryStyle()}>
              {busy ? 'Sending…' : 'Email me a reset link'}
              {!busy && <span aria-hidden="true" style={css("font-family:'Material Symbols Outlined';font-size:20px;")}>mail</span>}
            </button>
            <button onClick={() => go('signin')} style={quietButton}>Back to sign in</button>
          </>
        )}

        {/* ─────────────── Forgot password: link sent ─────────────── */}
        {view === 'sent' && (
          <>
            <div style={css('margin-top:22px;text-align:center;color:var(--ag-label);font-size:13.5px;line-height:1.6;')}>
              Didn’t get it? Check your spam folder, or{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); go('forgot'); }} style={linkStyle}>try another email</a>.
            </div>

            <button onClick={() => go('signin')} style={primaryStyle()}>Back to sign in</button>
          </>
        )}
      </div>
    </div>
  );
}

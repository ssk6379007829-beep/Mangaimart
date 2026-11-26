import { useEffect, useRef, useState } from 'react';
import { css } from '@/lib/css';

/**
 * Shared legal-consent UI for Terms & Conditions + Privacy Policy acceptance.
 *
 * Two variants, one source of truth for the link targets:
 *  - <ConsentCheckbox> — a required, unchecked-by-default tickbox that must gate
 *    the primary action on every account/shop *creation* surface. Explicit
 *    opt-in (never pre-ticked) is what the DPDP Act 2023 expects.
 *  - <ConsentNotice> — a passive "By continuing you agree to…" clickwrap line for
 *    pure sign-in surfaces and one-tap providers (Google / email code), where a
 *    checkbox on every returning sign-in would be hostile.
 *
 * The policy pages open in a new tab so a half-filled signup/onboarding form is
 * never destroyed by navigating away.
 */

const TERMS_HREF = '/terms';
const PRIVACY_HREF = '/privacy-policy';

/** The two linked policy names, shared by both variants. Exported so callers
 * with bespoke wording (e.g. a seller agreement) reuse the same link targets. */
export function PolicyLinks({ color = 'var(--ag-crimson)' }: { color?: string }) {
  const link = css(`font-weight:800;color:${color};text-decoration:underline;`);
  return (
    <>
      <a href={TERMS_HREF} target="_blank" rel="noopener noreferrer" style={link}>Terms &amp; Conditions</a>
      {' '}and{' '}
      <a href={PRIVACY_HREF} target="_blank" rel="noopener noreferrer" style={link}>Privacy Policy</a>
    </>
  );
}

export function ConsentCheckbox({
  checked,
  onChange,
  /** Bump this (an incrementing counter) when the user tried to submit without
   *  ticking: the box shakes, rings crimson and scrolls into view. The ring
   *  stays until they tick it; the shake is a one-shot that re-fires each bump. */
  attention = 0,
  /** Overrides the default lead-in — e.g. the Seller Agreement wording. */
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  attention?: number;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLLabelElement>(null);
  const [armed, setArmed] = useState(false); // crimson ring, held until ticked
  const [shake, setShake] = useState(false); // one-shot wobble

  // A fresh attention bump: ring it, scroll it into view, restart the shake.
  // Already ticked? Nothing to nag about. attention=0 is the initial render.
  useEffect(() => {
    if (!attention || checked) return;
    setArmed(true);
    setShake(false);
    const id = requestAnimationFrame(() => setShake(true));
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return () => cancelAnimationFrame(id);
  }, [attention]); // eslint-disable-line react-hooks/exhaustive-deps

  // The moment they tick it, clear the nag.
  useEffect(() => {
    if (checked) { setArmed(false); setShake(false); }
  }, [checked]);

  return (
    <label
      ref={ref}
      className={shake ? 'agx-shake' : undefined}
      onAnimationEnd={() => setShake(false)}
      style={css(`display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:12.5px;line-height:1.55;color:var(--ag-label);font-weight:600;border-radius:12px;padding:8px 10px;margin:-8px -10px;transition:box-shadow .2s,background .2s;${armed ? 'box-shadow:0 0 0 2px var(--ag-crimson);background:var(--ag-surface-2);' : ''}`)}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={css('width:18px;height:18px;flex:none;margin-top:1px;accent-color:#D6336C;cursor:pointer;')}
      />
      <span style={css('flex:1;')}>
        {children ?? (<>I agree to the <PolicyLinks />.</>)}
      </span>
    </label>
  );
}

export function ConsentNotice({ align = 'center' }: { align?: 'center' | 'left' }) {
  return (
    <div style={css(`text-align:${align};font-size:12px;line-height:1.55;color:var(--ag-muted);font-weight:600;`)}>
      By continuing, you agree to our <PolicyLinks />.
    </div>
  );
}

/** Reusable message when a required checkbox is left unticked. */
export const CONSENT_REQUIRED = 'Please accept the Terms & Conditions and Privacy Policy to continue';

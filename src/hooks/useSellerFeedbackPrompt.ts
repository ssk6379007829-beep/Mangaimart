/**
 * Whether to nudge this seller for feedback about MangaiMart — and the two
 * actions that stop the nudge coming back.
 *
 * The rule, kept deliberately gentle:
 *
 *   • Only a seller who has actually seen the platform work — a delivered order
 *     OR a completed payout (migration 0128's `sellerFeedbackEligible`). A
 *     brand-new shop is never interrupted.
 *   • Only once. If they have ever sent feedback, we never ask again
 *     (`hasGivenSellerFeedback`, a real DB check so it holds across devices).
 *   • Dismissing sets a local cooldown so "not now" means not now — for weeks,
 *     not until the next page load. Local-only on purpose: the eventual re-ask
 *     is the whole point, and a missed cooldown just means one extra prompt, not
 *     a lost submission.
 */
import { useCallback } from 'react';
import { useMyBoutique } from '@/hooks/useMyBoutique';
import { useAsync } from '@/hooks/useAsync';
import { hasGivenSellerFeedback, sellerFeedbackEligible } from '@/data/sellerFeedback';

/** How long a "Not now" holds before we may ask again. */
const COOLDOWN_DAYS = 45;
const dismissKey = (boutiqueId: string) => `seller-feedback:dismissed:${boutiqueId}`;

function recentlyDismissed(boutiqueId: string): boolean {
  try {
    const raw = localStorage.getItem(dismissKey(boutiqueId));
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    return Date.now() - at < COOLDOWN_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

export function useSellerFeedbackPrompt() {
  const { boutique } = useMyBoutique();
  const boutiqueId = boutique?.id ?? '';

  // Re-checked only when the boutique changes, and never while the local
  // cooldown is active — no point asking the server if we already know we must
  // stay quiet. `{ live: false }`: nothing here changes except by the seller's
  // own action, which calls the returned helpers.
  const { data, reload } = useAsync(
    async () => {
      if (!boutiqueId || recentlyDismissed(boutiqueId)) return false;
      const [eligible, given] = await Promise.all([
        sellerFeedbackEligible(boutiqueId),
        hasGivenSellerFeedback(boutiqueId),
      ]);
      return eligible && !given;
    },
    [boutiqueId],
    { live: false },
  );

  const dismiss = useCallback(() => {
    if (!boutiqueId) return;
    try { localStorage.setItem(dismissKey(boutiqueId), String(Date.now())); } catch { /* private mode */ }
  }, [boutiqueId]);

  return {
    /** True when the pop-up should be offered. */
    show: data === true,
    /** Record a "not now" so it holds for the cooldown. */
    dismiss,
    /** Re-evaluate (after a submit, so it stops offering immediately). */
    reload,
  };
}

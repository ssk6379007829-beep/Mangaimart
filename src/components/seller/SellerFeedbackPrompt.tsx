/**
 * The pop-up that asks a seller how MangaiMart is treating them, once they have
 * had a delivered order or a payout land.
 *
 * Mounted app-wide from SellerLayout, so it catches a seller wherever they are
 * rather than depending on them opening Help. Restrained, like its buyer twin
 * (components/buyer/FeedbackPrompt): one ask, dismissible, and held back a beat
 * after load so it reads as a question, not an interstitial.
 *
 * All the "should we even ask?" logic lives in useSellerFeedbackPrompt; this is
 * only the timing, the never-interrupt routes, and the sheet.
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useSellerFeedbackPrompt } from '@/hooks/useSellerFeedbackPrompt';
import { SellerFeedbackSheet } from './SellerFeedbackSheet';

/**
 * Routes where a modal would land mid-task. Billing is a live walk-in invoice,
 * add/onboarding are forms in progress, chat is a conversation with a buyer, and
 * auth is self-explanatory.
 */
const NEVER_ON = [
  '/seller/billing', '/seller/add-product', '/seller/onboarding', '/seller/register',
  '/seller/chat', '/seller/messages', '/auth',
];

export function SellerFeedbackPrompt() {
  const { pathname } = useLocation();
  const { show, dismiss, reload } = useSellerFeedbackPrompt();
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSettled(true), 2500);
    return () => clearTimeout(t);
  }, []);

  const blocked = NEVER_ON.some((p) => pathname.startsWith(p));
  if (!settled || blocked || !show) return null;

  return (
    <SellerFeedbackSheet
      onClose={(submitted) => {
        // Either way we stop offering: a submit is recorded in the DB (and
        // `reload` re-checks it), a dismissal sets the local cooldown.
        dismiss();
        if (submitted) reload();
      }}
    />
  );
}

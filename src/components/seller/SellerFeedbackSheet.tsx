/**
 * "How is MangaiMart working for you?" — the seller's channel to the operator.
 *
 * The mirror of the buyer's OrderFeedbackSheet, for boutique owners. A star
 * rating, a category to route it, and a note. It goes to the admin console and
 * nowhere else — private, never quoted, nothing here touches a rating.
 *
 * Shared by two surfaces: the "Share feedback" button on the Help page, and the
 * occasional pop-up (SellerFeedbackPrompt) after a delivery or payout. Both mount
 * this; `onClose(submitted)` tells the caller whether to record it as answered.
 */
import { useState } from 'react';
import { css } from '@/lib/css';
import { useAuth } from '@/auth/AuthContext';
import { useShop } from '@/state/ShopContext';
import { useMyBoutique } from '@/hooks/useMyBoutique';
import {
  SELLER_FEEDBACK_CATEGORIES, submitSellerFeedback, type SellerFeedbackCategory,
} from '@/data/sellerFeedback';

function Stars({ value, onChange, size = 34 }: { value: number; onChange: (v: number) => void; size?: number }) {
  return (
    <div style={css('display:flex;gap:6px;')} role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          onClick={() => onChange(n)}
          style={css('border:none;background:none;padding:0;cursor:pointer;line-height:1;')}
        >
          <span
            aria-hidden="true"
            style={css(`font-family:'Material Symbols Outlined';font-size:${size}px;color:${n <= value ? '#E8A33D' : 'var(--ag-muted-soft)'};${n <= value ? "font-variation-settings:'FILL' 1;" : ''}`)}
          >
            star
          </span>
        </button>
      ))}
    </div>
  );
}

const RATING_WORD: Record<number, string> = {
  1: 'Very unhappy', 2: 'Unhappy', 3: 'It’s okay', 4: 'Good', 5: 'Love it',
};

export function SellerFeedbackSheet({ onClose }: { onClose: (submitted: boolean) => void }) {
  const { session } = useAuth();
  const { showToast } = useShop();
  const { boutique } = useMyBoutique();
  const sellerId = session?.user?.id ?? '';

  const [rating, setRating] = useState(0);
  const [category, setCategory] = useState<SellerFeedbackCategory>('experience');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const canSubmit = rating > 0 && !busy;

  const submit = async () => {
    if (!boutique) {
      showToast('We couldn’t find your boutique — please try again', 'error');
      return;
    }
    if (!sellerId) {
      showToast('Please sign in to send feedback', 'warning');
      return;
    }
    setBusy(true);
    try {
      await submitSellerFeedback({ boutiqueId: boutique.id, sellerId, rating, category, body });
      showToast('Thank you — we read every word');
      onClose(true);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not send your feedback', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={css('position:fixed;inset:0;z-index:70;background:rgba(20,8,14,.5);display:flex;align-items:flex-end;justify-content:center;')}
      onClick={() => onClose(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={css('width:100%;max-width:560px;background:var(--ag-surface);border-radius:22px 22px 0 0;padding:20px 20px 24px;box-shadow:0 -14px 44px -20px rgba(107,20,54,.6);max-height:92vh;overflow-y:auto;')}
      >
        <div style={css('display:flex;align-items:flex-start;justify-content:space-between;gap:12px;')}>
          <div>
            <div style={css("font-family:var(--ag-display);font-weight:700;font-size:22px;line-height:1.15;")}>
              How is MangaiMart working for you?
            </div>
            <div style={css('font-size:12.5px;color:var(--ag-muted);margin-top:4px;line-height:1.5;')}>
              This goes straight to our team — it’s private, and no buyer ever sees it.
            </div>
          </div>
          <button
            onClick={() => onClose(false)}
            aria-label="Close"
            style={css('width:36px;height:36px;flex:none;border-radius:11px;border:none;background:var(--ag-surface-2);cursor:pointer;display:flex;align-items:center;justify-content:center;')}
          >
            <span aria-hidden="true" style={css("font-family:'Material Symbols Outlined';font-size:20px;color:var(--ag-muted);")}>close</span>
          </button>
        </div>

        {/* ---------- Rating ---------- */}
        <div style={css('margin-top:20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;')}>
          <Stars value={rating} onChange={setRating} />
          {rating > 0 && (
            <span style={css('font-size:13px;font-weight:800;color:var(--ag-crimson);')}>{RATING_WORD[rating]}</span>
          )}
        </div>

        {/* ---------- Category ---------- */}
        <div style={css('font-size:11.5px;font-weight:800;color:var(--ag-muted);letter-spacing:.05em;margin-top:22px;')}>
          WHAT’S IT ABOUT?
        </div>
        <div style={css('display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;')}>
          {SELLER_FEEDBACK_CATEGORIES.map((c) => {
            const on = category === c.value;
            return (
              <button
                key={c.value}
                type="button"
                aria-pressed={on}
                onClick={() => setCategory(c.value)}
                style={css(`flex:none;border:1.5px solid ${on ? 'var(--ag-crimson)' : 'var(--ag-border)'};background:${on ? 'var(--ag-surface-2)' : 'var(--ag-surface)'};color:${on ? 'var(--ag-crimson)' : 'var(--ag-label)'};border-radius:999px;padding:8px 14px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;`)}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        {/* ---------- Message ---------- */}
        <div style={css('font-size:11.5px;font-weight:800;color:var(--ag-muted);letter-spacing:.05em;margin-top:22px;')}>
          TELL US MORE <span style={css('font-weight:600;text-transform:none;letter-spacing:0;color:var(--ag-muted-soft);')}>(optional)</span>
        </div>
        <textarea
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, 1000))}
          placeholder="What’s going well, and what would make selling here easier?"
          style={css('width:100%;margin-top:10px;border-radius:12px;border:1.5px solid var(--ag-border);background:var(--ag-bg);color:var(--ag-ink);padding:11px 12px;font-size:13.5px;font-family:inherit;box-sizing:border-box;resize:vertical;')}
        />

        <div style={css('display:flex;gap:10px;margin-top:20px;')}>
          <button
            onClick={() => onClose(false)}
            style={css('flex:1;height:50px;border:1.5px solid var(--ag-border);background:var(--ag-surface);color:var(--ag-label);border-radius:14px;font-weight:800;cursor:pointer;font-family:inherit;')}
          >
            Not now
          </button>
          <button
            disabled={!canSubmit}
            onClick={() => void submit()}
            style={css(`flex:1.5;height:50px;border:none;border-radius:14px;background:${canSubmit ? 'linear-gradient(135deg,#D6336C,#B02454)' : 'var(--ag-surface-2)'};color:${canSubmit ? '#fff' : 'var(--ag-muted)'};font-weight:800;cursor:${canSubmit ? 'pointer' : 'default'};font-family:inherit;`)}
          >
            {busy ? 'Sending…' : 'Send feedback'}
          </button>
        </div>
      </div>
    </div>
  );
}

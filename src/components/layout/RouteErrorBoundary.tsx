import { Component, type ErrorInfo, type ReactNode } from 'react';
import { css } from '@/lib/css';
import { isStaleChunkError, recoverFromStaleChunk } from '@/lib/appUpdate';

/**
 * Catches render/runtime errors in a routed page so one broken screen shows a
 * recoverable message instead of blanking the whole app. Without this, an
 * uncaught error unmounts the entire React tree — a white page with no clue.
 *
 * Mounted in `AdminLayout` and in `AppShell`, which is the shell both the buyer
 * storefront and the seller console render through — so all three consoles are
 * covered. It used to guard only the admin console, which left an uncaught
 * render error on the storefront white-screening the one surface that takes
 * money.
 *
 * IMPORTANT: React never clears a boundary by itself. Callers key this on the
 * current pathname so navigating away from a broken screen recovers; without
 * that key a single crash pins the error card over every subsequent route.
 *
 * STALE CHUNKS ARE NOT CRASHES. A lazy route whose code-split chunk was deleted
 * by a newer deploy throws "Failed to fetch dynamically imported module" DURING
 * RENDER, so it lands here rather than in the global listeners in
 * `lib/appUpdate` — which is why users saw a scary error card (raw message and
 * all) for what is just an out-of-date tab. We now recognise that case and heal
 * it the way the listeners would: reload once onto the fresh build. Only a
 * genuine render error still shows the diagnostic card.
 */
export class RouteErrorBoundary extends Component<
  { children: ReactNode; surface?: string },
  { error: Error | null; reloading: boolean }
> {
  state: { error: Error | null; reloading: boolean } = { error: null, reloading: false };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isStaleChunkError(error)) {
      // An out-of-date tab, not a bug. Reload onto the new build (once per
      // session); if that one reload was already spent, fall through to the
      // calm "couldn't update" card below rather than looping.
      if (recoverFromStaleChunk()) this.setState({ reloading: true });
      return;
    }
    console.error(`${this.props.surface ?? 'Page'} crashed:`, error, info);
  }

  render() {
    const { error, reloading } = this.state;
    if (!error) return this.props.children;

    const staleChunk = isStaleChunkError(error);

    // The reload has been kicked off — the page is about to swap builds. Show a
    // calm line in the meantime, never the error, so the last thing the user
    // sees before the refresh is reassuring rather than a stack of jargon.
    if (reloading) {
      return (
        <div role="status" style={css('max-width:560px;margin:60px auto;text-align:center;color:var(--ag-muted);font-size:14px;')}>
          Updating to the latest version…
        </div>
      );
    }

    // A stale chunk we could not auto-reload (the one free reload this session
    // was already used). Still not a bug the user can act on — so a plain
    // "update and reload" card, no technical dump, one obvious button.
    if (staleChunk) {
      return (
        <div style={css('max-width:460px;margin:60px auto;background:var(--ag-surface);border-radius:18px;padding:28px;text-align:center;box-shadow:0 12px 30px -24px rgba(107,20,54,.6);')}>
          <div style={css('width:52px;height:52px;margin:0 auto;border-radius:15px;background:var(--ag-surface-2);display:flex;align-items:center;justify-content:center;')}>
            <span aria-hidden="true" translate="no" style={css("font-family:'Material Symbols Outlined';font-size:26px;color:var(--ag-crimson);")}>auto_awesome</span>
          </div>
          <div style={css("font-family:var(--ag-display);font-weight:700;font-size:22px;margin-top:14px;")}>A newer version is ready</div>
          <div style={css('color:var(--ag-muted);font-size:13.5px;margin-top:6px;line-height:1.5;')}>
            This tab was running an older version of MangaiMart. Reload to get the latest — your bag and wishlist are kept.
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={css('height:44px;margin-top:18px;border-radius:12px;border:none;background:linear-gradient(135deg,#D6336C,#B02454);color:#fff;font-weight:800;font-size:13.5px;padding:0 22px;cursor:pointer;font-family:inherit;')}
          >
            Reload
          </button>
        </div>
      );
    }

    return (
      <div style={css('max-width:560px;margin:40px auto;background:var(--ag-surface);border-radius:18px;padding:28px;box-shadow:0 12px 30px -24px rgba(107,20,54,.6);')}>
        <div style={css('width:52px;height:52px;border-radius:15px;background:var(--ag-bad-bg);display:flex;align-items:center;justify-content:center;')}>
          <span aria-hidden="true" translate="no" style={css("font-family:'Material Symbols Outlined';font-size:26px;color:var(--ag-bad-text);")}>error</span>
        </div>
        <div style={css("font-family:var(--ag-display);font-weight:700;font-size:22px;margin-top:14px;")}>This page hit an error</div>
        <div style={css('color:var(--ag-muted);font-size:13.5px;margin-top:6px;line-height:1.5;')}>
          Everything else still works — the navigation below will take you anywhere else. Try again, or
          reload; if it keeps happening, send this message across:
        </div>
        <pre style={css('margin-top:12px;background:var(--ag-bg);border:1px solid var(--ag-border);border-radius:12px;padding:12px 14px;font-size:12px;color:var(--ag-crimson);white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:180px;')}>
          {error.message || String(error)}
        </pre>
        <div style={css('display:flex;gap:10px;margin-top:18px;')}>
          <button
            type="button"
            onClick={() => this.setState({ error: null, reloading: false })}
            style={css('height:44px;border-radius:12px;border:1.5px solid var(--ag-border);background:var(--ag-surface);color:var(--ag-label);font-weight:700;font-size:13.5px;padding:0 16px;cursor:pointer;font-family:inherit;')}
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={css('height:44px;border-radius:12px;border:none;background:linear-gradient(135deg,#D6336C,#B02454);color:#fff;font-weight:800;font-size:13.5px;padding:0 16px;cursor:pointer;font-family:inherit;')}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

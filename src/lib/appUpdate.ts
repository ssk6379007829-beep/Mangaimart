/**
 * Notices when the deployed site has moved on from the copy in this tab.
 *
 * Single-page apps are the one kind of site that can go stale indefinitely: a
 * phone left on the orders screen keeps running whatever bundle it downloaded
 * on Monday, and a Friday deploy never reaches it. Worse, its code-split chunks
 * are deleted from the CDN by the new deploy, so the *next* thing that user taps
 * fails to load with a blank screen.
 *
 * Vite fingerprints the entry bundle (`/assets/index-<hash>.js`), so a changed
 * filename in the freshly fetched `index.html` is a deploy, exactly and with no
 * server support. The response is never a forced reload — we surface it and let
 * the user pick the moment (see `UpdateNotice`).
 */

const ENTRY_RE = /<script[^>]+type="module"[^>]+src="([^"]+)"/i;

/** The entry bundle this tab is running, read out of its own document. */
function currentEntry(): string | null {
  if (typeof document === 'undefined') return null;
  const scripts = [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')];
  const entry = scripts.find((s) => s.getAttribute('src')?.includes('/assets/'));
  return entry?.getAttribute('src') ?? null;
}

/** The entry bundle the server is serving right now. */
async function deployedEntry(signal?: AbortSignal): Promise<string | null> {
  const res = await fetch(`/index.html?_=${Date.now()}`, {
    cache: 'no-store',
    headers: { 'cache-control': 'no-cache' },
    signal,
  });
  if (!res.ok) return null;
  const html = await res.text();
  return ENTRY_RE.exec(html)?.[1] ?? null;
}

/**
 * True when a newer build is live. Returns false — never throws — when the
 * check can't be made: offline, a captive-portal redirect, or `vite dev`, where
 * the entry is `/src/main.tsx` and there is nothing to fingerprint.
 */
export async function isUpdateAvailable(signal?: AbortSignal): Promise<boolean> {
  const mine = currentEntry();
  if (!mine) return false;
  try {
    const live = await deployedEntry(signal);
    return live != null && live !== mine;
  } catch {
    return false;
  }
}

const RELOADED_KEY = 'agx:chunk-reloaded';

/**
 * Reloads once to recover from a chunk that no longer exists on the CDN.
 *
 * After a deploy, a lazy route the user taps 404s and React renders nothing.
 * The fix is the reload they would have done themselves — so do it for them,
 * but only once per session, so a genuinely broken chunk becomes a visible
 * error instead of an infinite reload loop.
 *
 * Returns true when it actually triggered a reload, false when it declined
 * because this session already reloaded once. The caller (RouteErrorBoundary)
 * uses that to choose between a calm "updating…" placeholder and a clean
 * "couldn't update" card — neither of which is the raw error dump a stale
 * chunk used to surface.
 */
export function recoverFromStaleChunk(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (sessionStorage.getItem(RELOADED_KEY)) return false;
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  } catch {
    // Private mode with storage disabled: one reload attempt is still better
    // than a blank screen, and the failure mode is bounded by the user leaving.
  }
  window.location.reload();
  return true;
}

const STALE_CHUNK_RE = /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch/i;

/**
 * True when an error is a code-split chunk that failed to load — overwhelmingly
 * a tab running a build the latest deploy has since deleted from the CDN, not a
 * bug in the page. Centralised here so the global listeners below and the
 * render-time RouteErrorBoundary agree on what counts, and so the boundary can
 * self-heal the exact failures these listeners were meant to catch but miss
 * when React swallows the rejection into a render error instead.
 */
export function isStaleChunkError(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  return STALE_CHUNK_RE.test(message);
}

/**
 * Installs the two listeners that catch a stale-chunk failure: Vite's own
 * preload error, and the unhandled rejection React throws when `lazy()` can't
 * fetch its module.
 */
export function installStaleChunkRecovery(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    recoverFromStaleChunk();
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (isStaleChunkError(event.reason)) recoverFromStaleChunk();
  });
}

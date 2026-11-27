import { lazy, type ComponentType } from 'react';

/**
 * Helpers for lazy-loading route/component chunks so a post-deploy chunk
 * mismatch heals itself instead of crashing a console.
 *
 * THE FAILURE THIS GUARDS AGAINST
 * A dynamic import can resolve to a module whose expected export is `undefined`
 * — nearly always because a newer deploy replaced a shared chunk this tab's
 * build depended on, so the namespace comes back half-initialised. Reading the
 * named export straight off it (`m.Foo`) then throws a raw "Cannot read
 * properties of undefined (reading 'Foo')", which the error boundary cannot tell
 * apart from a genuine bug — so it shows the scary diagnostic card for what is
 * really just an out-of-date tab. Every console (buyer, seller, admin) splits
 * its pages this way, so the crash could surface anywhere.
 *
 * Throwing a "dynamically imported module" failure instead routes it into the
 * stale-chunk recovery in `lib/appUpdate`, which reloads once onto the fresh
 * build and, if that still doesn't resolve it, `RouteErrorBoundary` shows the
 * calm "a newer version is ready" card.
 */
function missingExport(name: string | number | symbol): Error {
  return new Error(`Failed to fetch dynamically imported module: export "${String(name)}" is missing`);
}

/**
 * Pick a NAMED export out of a freshly imported module, preserving its exact
 * component type (and therefore its props — `CategoryLanding` takes `kind`,
 * `MfaGate` takes `onVerified`). Use directly inside a `lazy(() => …)` for a
 * component that takes props.
 */
export function pickExport<M, K extends keyof M>(m: M, name: K): { default: M[K] } {
  const picked = m == null ? undefined : m[name];
  if (picked == null) throw missingExport(name);
  return { default: picked };
}

/**
 * `React.lazy` for a module that uses a NAMED export (the bulk of the app's
 * pages), with the stale-chunk guard above baked in. `loader` is the
 * `() => import('…')` and `name` is the export to render. Props are erased to
 * the base `ComponentType` here because these routes are rendered prop-less;
 * for a split component that takes props, use `pickExport` directly.
 */
export const lazyNamed = <M, K extends keyof M>(loader: () => Promise<M>, name: K) =>
  lazy(() =>
    loader().then((m) => {
      const picked = m == null ? undefined : m[name];
      if (picked == null) throw missingExport(name);
      return { default: picked as ComponentType };
    }),
  );

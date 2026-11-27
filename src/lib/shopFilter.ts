/**
 * One predicate for the shop grid.
 *
 * The grid (`Results`) and the filter sheet's "Show N results" button were two
 * copies of the same nine-line filter expression. Two copies is one too many:
 * the button's job is to promise exactly what the grid will show, and it can
 * only do that if it runs the same code.
 *
 * Terms are compared with `sameTerm`, not `===`. The vocabulary and the products
 * are two different people's typing — the admin approves "Kurta Set", a seller
 * lists a "kurta set" — and a filter that a tile just promised must not come
 * back empty over a capital letter. See @/lib/vocabulary for the rule and the
 * bug that produced it.
 */

import type { Filters } from '@/state/ShopContext';
import { hasTerm, termKey } from '@/lib/vocabulary';
import type { Product } from '@/data/demo';

/** The fields the header search looks through. */
const searchable = (p: Product) => [p.title, p.cat, p.occasion, p.fabric, p.color, p.boutique];

/**
 * Whether a piece belongs in the grid under these filters and this search term.
 * `query` is the raw header search box; it is trimmed and lower-cased here so
 * callers cannot forget to.
 */
export function matchesFilters(p: Product, filters: Filters, query = ''): boolean {
  const q = query.trim().toLowerCase();
  return (
    p.price <= filters.maxPrice &&
    (filters.cats.length === 0 || hasTerm(filters.cats, p.cat)) &&
    (filters.colors.length === 0 || hasTerm(filters.colors, p.color)) &&
    (filters.occasions.length === 0 || hasTerm(filters.occasions, p.occasion)) &&
    // The sizes the seller actually listed (`products.sizes`, migration 0008),
    // the same field the Inspire feed and the product page filter on — never a
    // value derived from the product id. A piece with no sizes recorded matches
    // no size filter, which is correct: we cannot claim it comes in that size.
    (filters.sizes.length === 0 || (p.sizes ?? []).some((s) => hasTerm(filters.sizes, s))) &&
    // The header search narrows the same grid rather than opening a separate
    // screen, so a term and a filter compose instead of fighting.
    (q === '' || searchable(p).some((f) => f?.toLowerCase().includes(q)))
  );
}

/** The four groups a filter panel narrows the grid by. */
export type FacetGroup = 'cats' | 'colors' | 'occasions' | 'sizes';

/** What `availableFacets` returns: the still-reachable option values per group. */
export type FacetAvailability = Record<FacetGroup, Set<string>>;

/**
 * The option values a buyer can still reach in each filter group, as `termKey`
 * sets — so a filter panel can hide the options that would only ever open an
 * empty grid, and the panel and the grid never disagree about what matches.
 *
 * "Reachable" is dynamic and cross-group. A group's set is computed against
 * every *other* active filter — price, the other groups, the search term — but
 * with its own selections cleared, so ticking one category never makes its
 * siblings vanish. Keys are `termKey`s because the options are the admin's
 * spellings and these are the sellers': an exact-string set would hide the
 * "Kurta Set" option from a catalogue full of "kurta set".
 *
 * Callers keep an already-selected option on screen themselves (`hasTerm` on the
 * group's own filter), or a selection that empties the grid could not be undone.
 */
export function availableFacets(
  products: readonly Product[],
  filters: Filters,
  query = '',
): FacetAvailability {
  const present = (except: FacetGroup) =>
    products.filter((p) => matchesFilters(p, { ...filters, [except]: [] }, query));
  return {
    cats: new Set(present('cats').map((p) => termKey(p.cat))),
    colors: new Set(present('colors').map((p) => termKey(p.color))),
    occasions: new Set(present('occasions').map((p) => termKey(p.occasion))),
    sizes: new Set(present('sizes').flatMap((p) => (p.sizes ?? []).map(termKey))),
  };
}

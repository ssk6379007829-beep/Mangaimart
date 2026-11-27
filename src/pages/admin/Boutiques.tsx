import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { css } from '@/lib/css';
import { TONES } from '@/data/demo';
import { useAsync } from '@/hooks/useAsync';
import { fetchAllBoutiquesAdmin, fetchProductCounts } from '@/data/boutiques';
import { BOUTIQUE_STATUS_LABEL, type BoutiqueStatus } from '@/data/types';
import { Skeleton } from '@/components/ui/Skeleton';
import { resolvePincode } from '@/data/pincodes';
import type { PincodeArea } from '@/lib/pincode';
import {
  locationFlags, publicDuplicates, behaviourFlags, sortFlags, type ReviewFlag,
} from '@/lib/boutiqueReview';
import { SearchInput, T } from '@/components/admin/kit';
import { useSeededSearch } from '@/hooks/useSeededSearch';
import { adminPath } from '@/lib/adminPath';
import { Tag } from '@/components/admin/BoutiqueReviewPanel';

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/**
 * Boutiques — the single screen for every shop on the platform, whatever its
 * status. This is the merge of the old "Boutiques" table and the separate
 * "Approvals" queue: having two tiles for the same object, one that could show
 * the full application and one that could not, is the confusion this replaces.
 *
 * Now there is one list with a status filter, and selecting ANY row — pending or
 * live — opens the full shop page (`src/pages/admin/BoutiqueDetail.tsx`): its
 * whole history and settings across tabs, with the application, verification call
 * and status decision on the Application tab. The pending tabs still carry the
 * stop-the-approval triage tags inline, so a queue can be worked without opening
 * each row.
 */

const GRID = 'display:grid;grid-template-columns:2fr 1.1fr 1.3fr 1fr 1fr;';
const CELL = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

type Tab = 'all' | BoutiqueStatus;

const TAB_ORDER: Tab[] = ['all', 'pending', 'changes_requested', 'draft', 'approved', 'rejected'];
const TAB_LABEL: Record<Tab, string> = {
  all: 'All',
  pending: BOUTIQUE_STATUS_LABEL.pending,
  changes_requested: BOUTIQUE_STATUS_LABEL.changes_requested,
  draft: BOUTIQUE_STATUS_LABEL.draft,
  approved: BOUTIQUE_STATUS_LABEL.approved,
  rejected: BOUTIQUE_STATUS_LABEL.rejected,
};

const STATUS_CHIP: Record<BoutiqueStatus, { bg: string; fg: string }> = {
  draft: { bg: 'var(--ag-surface-2)', fg: 'var(--ag-muted)' },
  pending: { bg: 'var(--ag-warn-bg)', fg: 'var(--ag-warn-text)' },
  changes_requested: { bg: 'var(--ag-gold-bg)', fg: 'var(--ag-gold-text)' },
  approved: { bg: 'var(--ag-good-bg)', fg: 'var(--ag-good-text)' },
  rejected: { bg: 'var(--ag-bad-bg)', fg: 'var(--ag-bad-text)' },
};

export function Boutiques() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('pending');
  const [q, setQ] = useSeededSearch();
  const { data: rows, loading, error } = useAsync(() => fetchAllBoutiquesAdmin(), []);

  const all = useMemo(() => rows ?? [], [rows]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((b) => {
      if (tab !== 'all' && b.status !== tab) return false;
      if (!needle) return true;
      return (
        b.name.toLowerCase().includes(needle) ||
        (b.city ?? '').toLowerCase().includes(needle) ||
        (b.owner_name ?? '').toLowerCase().includes(needle) ||
        (b.owner?.full_name ?? '').toLowerCase().includes(needle)
      );
    });
  }, [all, tab, q]);

  /* Row-level triage tags only matter on the tabs an admin is actually working
     through — the queues. Resolving every pincode and counting every product for
     the whole marketplace (the "All"/"Approved" tabs) would be work done for
     nothing, so the sweep is scoped to those three. */
  const triaging = tab === 'pending' || tab === 'changes_requested' || tab === 'draft';
  const [areas, setAreas] = useState<Record<string, PincodeArea | null>>({});
  const [counts, setCounts] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    if (!triaging) return;
    let cancelled = false;
    const pins = Array.from(new Set(list.map((b) => (b.pincode ?? '').trim()).filter(Boolean)));
    void Promise.all(pins.map(async (pin) => [pin, await resolvePincode(pin)] as const))
      .then((pairs) => {
        if (cancelled) return;
        setAreas((prev) => {
          const next = { ...prev };
          for (const [pin, area] of pairs) next[pin] = area;
          return next;
        });
      });
    return () => { cancelled = true; };
  }, [list, triaging]);

  useEffect(() => {
    if (!triaging) return;
    let cancelled = false;
    void fetchProductCounts(list.map((b) => b.id)).then((m) => {
      if (!cancelled) setCounts((prev) => new Map([...prev, ...m]));
    });
    return () => { cancelled = true; };
  }, [list, triaging]);

  const rowFlags = useMemo(() => {
    const out = new Map<string, ReviewFlag[]>();
    if (!triaging) return out;
    for (const b of list) {
      const flags = [
        ...locationFlags(b, areas[(b.pincode ?? '').trim()]),
        ...publicDuplicates(b, all),
        ...behaviourFlags(b, counts.has(b.id) ? counts.get(b.id)! : null),
      ].filter((f) => f.tone === 'bad' || f.tone === 'warn');
      out.set(b.id, sortFlags(flags));
    }
    return out;
  }, [list, all, areas, counts, triaging]);

  const open = (id: string) => navigate(adminPath(`boutiques/${id}`));

  return (
    <div style={css('display:flex;flex-direction:column;gap:14px;')}>
      {/* Status tabs — every state in one place, each with its live count. */}
      <div style={css('display:flex;gap:9px;flex-wrap:wrap;')}>
        {TAB_ORDER.map((key) => {
          const on = tab === key;
          const count = key === 'all' ? all.length : all.filter((b) => b.status === key).length;
          return (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={css(`padding:8px 16px;border:none;border-radius:999px;font-size:13px;font-weight:700;cursor:pointer;background:${on ? 'var(--ag-crimson)' : 'var(--ag-surface)'};color:${on ? '#fff' : 'var(--ag-label)'};font-family:inherit;`)}
            >
              {TAB_LABEL[key]} · {count}
            </button>
          );
        })}
      </div>

      <div style={css('display:flex;gap:10px;flex-wrap:wrap;align-items:center;')}>
        <SearchInput value={q} onChange={setQ} placeholder="Search boutique, owner or city…" />
        <div style={css('flex:1;')} />
        <span style={css(`font-size:12px;font-weight:600;color:${T.muted};`)}>
          {list.length} of {all.length}
        </span>
      </div>

      <div style={css('background:var(--ag-surface);border-radius:18px;overflow:hidden;box-shadow:0 12px 30px -24px rgba(107,20,54,.6);')}>
        <div className="agx-adm-tablewrap">
          <div className="agx-adm-tablegrid">
            <div style={css(`${GRID}padding:14px 20px;background:var(--ag-surface-2);font-size:12px;font-weight:800;color:var(--ag-muted);letter-spacing:.04em;`)}>
              <span>BOUTIQUE</span><span>CITY</span><span>OWNER</span><span>STATUS</span><span>SUBMITTED</span>
            </div>

            {loading && (
              <div role="status" aria-busy="true">
                <span className="agx-visually-hidden">Loading boutiques…</span>
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} style={css(`${GRID}padding:16px 20px;border-top:1px solid var(--ag-border-soft);align-items:center;`)}>
                    {Array.from({ length: 5 }, (_, j) => <Skeleton key={j} w={`${58 + ((i * 11 + j * 17) % 30)}%`} />)}
                  </div>
                ))}
              </div>
            )}

            {/* A failed query is not an empty marketplace — say which, so a
                permission error or an unapplied migration is not mistaken for
                "no boutiques yet". */}
            {!loading && error && (
              <div style={css('padding:20px;color:var(--ag-bad-text);font-size:13.5px;')}>
                Could not load boutiques — {error}
              </div>
            )}
            {!loading && !error && all.length === 0 && (
              <div style={css('padding:20px;color:var(--ag-muted);font-size:13.5px;')}>No boutiques yet.</div>
            )}
            {!loading && !error && all.length > 0 && list.length === 0 && (
              <div style={css('padding:20px;color:var(--ag-muted);font-size:13.5px;')}>No boutiques match this search or filter.</div>
            )}

            {!loading && list.map((b, i) => {
              const flags = rowFlags.get(b.id) ?? [];
              const chip = STATUS_CHIP[b.status];
              return (
                <div
                  key={b.id}
                  className="agx-adm-row"
                  data-clickable="true"
                  onClick={() => open(b.id)}
                  style={css(`${GRID}padding:14px 20px;align-items:center;border-top:1px solid var(--ag-border-soft);cursor:pointer;`)}
                >
                  <div style={css('display:flex;align-items:center;gap:10px;min-width:0;')}>
                    <div style={css(`width:36px;height:36px;flex:none;border-radius:11px;overflow:hidden;background:${TONES[b.tone ?? i % TONES.length]};display:flex;align-items:center;justify-content:center;font-weight:700;color:rgba(42,26,32,.5);`)}>
                      {b.logo_url ? <img src={b.logo_url} alt="" style={css('width:100%;height:100%;object-fit:cover;')} /> : b.name.charAt(0)}
                    </div>
                    <div style={css('min-width:0;')}>
                      <div style={css(`font-weight:700;font-size:13.5px;${CELL}`)}>{b.name}</div>
                      {/* Triage before opening: the tags that would stop an
                          approval, at most three. A row with none is not "clean",
                          it is "nothing visible from here" — the shop page shows
                          the full list including what passed. */}
                      {flags.length > 0 ? (
                        <div style={css('display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;')}>
                          {flags.slice(0, 3).map((f) => <Tag key={f.id} flag={f} compact />)}
                          {flags.length > 3 && (
                            <span style={css('font-size:10.5px;font-weight:800;color:var(--ag-muted);align-self:center;')}>+{flags.length - 3}</span>
                          )}
                        </div>
                      ) : (
                        <div style={css(`font-size:11.5px;color:var(--ag-muted);${CELL}`)}>{b.owner_name || b.owner?.full_name || '—'}</div>
                      )}
                    </div>
                  </div>
                  <span style={css(`font-size:13px;color:var(--ag-label);${CELL}`)}>{b.city || '—'}</span>
                  <span style={css(`font-size:13px;color:var(--ag-label);${CELL}`)}>{b.owner_name || b.owner?.full_name || '—'}</span>
                  <span style={css('min-width:0;')}>
                    <span style={css(`display:inline-block;max-width:100%;font-size:11px;font-weight:800;padding:4px 10px;border-radius:8px;background:${chip.bg};color:${chip.fg};${CELL}`)}>{BOUTIQUE_STATUS_LABEL[b.status]}</span>
                  </span>
                  <span style={css(`font-size:12.5px;color:var(--ag-muted);${CELL}`)}>{fmtDate(b.submitted_at)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Boutiques;

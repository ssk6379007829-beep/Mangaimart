import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { css } from '@/lib/css';
import { fmtInr } from '@/lib/tokens';
import { useShop } from '@/state/ShopContext';
import { useAuth } from '@/auth/AuthContext';
import { useAsync } from '@/hooks/useAsync';
import { isConsoleRole } from '@/lib/staffAccess';
import { adminResetMfa, enrolledUserIds } from '@/lib/mfa';
import { logAdminAction } from '@/data/activityLog';
import {
  fetchUserById, fetchUserDetail, setUserStatus, deleteUserEverywhere, restoreUser, updateUser,
  type AdminUserRow,
} from '@/data/adminUsers';
import { fetchMyBoutique } from '@/data/boutiques';
import {
  Avatar, Card, ConfirmDialog, EmptyState, Field, GhostButton, Icon, StatCard, StatusPill, T,
} from '@/components/admin/kit';
import { adminPath } from '@/lib/adminPath';
import type { Role } from '@/types/database';

/**
 * The whole account in one place — profile, what they have bought, the shop they
 * run if they are a seller, and every control the directory used to scatter
 * across row icons and pop-up dialogs. Opened from the Users list.
 *
 * The management guards are the SAME ones the list enforces, kept deliberately
 * in step: an active admin cannot be blocked or deleted, you cannot act on your
 * own account, and two-factor can only be reset for a console account that has a
 * factor to clear. These are convenience guards over a server that re-checks
 * every one; they exist so the dangerous button is not even offered.
 */

const ROLE_PILL: Record<Role, { bg: string; fg: string }> = {
  buyer: { bg: 'var(--ag-info-bg)', fg: 'var(--ag-info-text)' },
  seller: { bg: 'var(--ag-purple-bg)', fg: '#9B7FC7' },
  admin: { bg: 'var(--ag-surface-2)', fg: '#D6336C' },
  staff: { bg: 'var(--ag-good-bg)', fg: 'var(--ag-good-text)' },
};

type Dialog = 'block' | 'delete' | 'resetmfa' | null;

export function UserDetail() {
  const { id = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { showToast } = useShop();
  const { profile } = useAuth();

  const seed = (location.state as { user?: AdminUserRow } | null)?.user;
  const [refreshKey, setRefreshKey] = useState(0);
  const reload = () => setRefreshKey((k) => k + 1);

  const { data: fetched, loading, error } = useAsync(() => fetchUserById(id), [id, refreshKey]);
  const user = fetched ?? (seed?.id === id ? seed : null);
  const { data: detail } = useAsync(() => fetchUserDetail(id), [id, refreshKey]);
  const { data: mfaOn } = useAsync(() => enrolledUserIds(), [refreshKey]);
  const { data: shop } = useAsync(
    () => (user?.role === 'seller' ? fetchMyBoutique(id).catch(() => null) : Promise.resolve(null)),
    [id, user?.role, refreshKey],
  );

  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const back = () => navigate(adminPath('users'));

  const log = (action: string, meta?: Record<string, unknown>) =>
    logAdminAction({ actor_id: profile?.id, actor_name: profile?.full_name ?? 'Admin', action, entity_type: 'profile', entity_id: id, meta });

  if (loading && !user) return <div style={css(`padding:24px;color:${T.muted};font-size:14px;`)}>Loading account…</div>;
  if (error && !user) {
    return <Shell onBack={back}><div style={css('padding:20px;color:var(--ag-bad-text);font-size:13.5px;')}>Could not load this account — {error}</div></Shell>;
  }
  if (!user) {
    return <Shell onBack={back}><div style={css(`padding:20px;color:${T.muted};font-size:13.5px;`)}>That account no longer exists.</div></Shell>;
  }

  const u = user;
  const isSelf = u.id === profile?.id;
  const deleted = !!u.deleted_at;
  const showUnblock = deleted ? false : u.status === 'blocked';
  const showBlock = !deleted && u.status !== 'blocked' && u.role !== 'admin';
  const canResetMfa = !deleted && isConsoleRole(u.role) && !isSelf && !!mfaOn?.has(u.id);
  const canDelete = !deleted && !isSelf && u.role !== 'admin';

  const run = async (fn: () => Promise<{ message?: string } | void>, fallback: string, after?: 'reload' | 'back') => {
    setBusy(true);
    try {
      const res = await fn();
      showToast((res && 'message' in res && res.message) ? res.message : fallback);
      setDialog(null);
      setReason('');
      if (after === 'back') back(); else reload();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Action failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const doUnblock = () => run(async () => { const r = await setUserStatus(u.id, 'active'); await log('user.unblock', { name: u.full_name }); return r; }, 'User unblocked');
  const doBlock = () => run(async () => { const r = await setUserStatus(u.id, 'blocked', reason); await log('user.block', { name: u.full_name, reason: reason.trim() || null }); return r; }, 'User blocked');
  const doResetMfa = () => run(async () => { await adminResetMfa(u.id); }, `${u.full_name || 'That account'} can set up two-factor again`);
  const doRestore = () => run(async () => { const r = await restoreUser(u.id); await log('user.restore', { name: u.full_name }); return r; }, 'User restored');
  const doDelete = () => run(async () => { const r = await deleteUserEverywhere(u.id, reason); await log(r.mode === 'archived' ? 'user.archive' : 'user.delete', { name: u.full_name, mode: r.mode, reason: reason.trim() || null }); return r; }, 'User deleted', 'back');

  return (
    <Shell onBack={back}>
      {/* Identity header + the manage actions */}
      <div style={css(T.card + 'padding:18px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;')}>
        <Avatar name={u.full_name} tone={u.full_name.charCodeAt(0) % 8} />
        <div style={css('flex:1;min-width:0;')}>
          <div style={css("font-family:var(--ag-display);font-weight:700;font-size:23px;line-height:1.15;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{u.full_name}</div>
          <div style={css(`font-size:13px;color:${T.muted};margin-top:3px;`)}>{u.email ?? u.phone ?? '—'}</div>
        </div>
        <span style={css(`font-size:11px;font-weight:800;padding:5px 11px;border-radius:9px;background:${ROLE_PILL[u.role].bg};color:${ROLE_PILL[u.role].fg};`)}>{u.role}</span>
        <StatusPill status={deleted ? 'rejected' : u.status} label={deleted ? 'Deleted' : undefined} />
      </div>

      <div style={css('display:flex;gap:9px;flex-wrap:wrap;')}>
        {deleted ? (
          <GhostButton tone="primary" icon="restore_from_trash" onClick={() => { if (!busy) void doRestore(); }}>Restore account</GhostButton>
        ) : (
          <>
            <GhostButton icon="edit" onClick={() => setEditing((v) => !v)}>{editing ? 'Close editor' : 'Edit details'}</GhostButton>
            {showUnblock && <GhostButton icon="lock_open" onClick={() => { if (!busy) void doUnblock(); }}>Unblock</GhostButton>}
            {showBlock && <GhostButton icon="block" onClick={() => { setReason(''); setDialog('block'); }}>Block</GhostButton>}
            {canResetMfa && <GhostButton icon="lock_reset" onClick={() => setDialog('resetmfa')}>Reset 2FA</GhostButton>}
            {canDelete && <GhostButton tone="danger" icon="delete" onClick={() => { setReason(''); setDialog('delete'); }}>Delete</GhostButton>}
          </>
        )}
      </div>

      {editing && !deleted && (
        <EditCard user={u} onSaved={() => { setEditing(false); reload(); }} log={log} />
      )}

      {/* Stats */}
      <div className="agx-adm-g4">
        <StatCard label="Orders" value={String(detail?.orders.length ?? 0)} icon="receipt_long" tint="var(--ag-info-bg)" ic="var(--ag-info-text)" />
        <StatCard label="Lifetime spend" value={fmtInr(detail?.totalSpent ?? 0)} icon="payments" tint="var(--ag-surface-2)" ic="#D6336C" />
        <StatCard label="Wishlist" value={String(detail?.wishlist ?? 0)} icon="favorite" tint="var(--ag-good-bg)" ic="var(--ag-good-text)" />
        <StatCard label="Joined" value={new Date(u.created_at).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })} icon="event" tint="var(--ag-warn-bg)" ic="var(--ag-gold-text)" />
      </div>

      <div className="agx-adm-g2">
        <Card>
          <div style={css('font-weight:800;font-size:15px;margin-bottom:6px;')}>Profile</div>
          <Field label="Role" value={u.role} />
          <Field label="Status" value={<StatusPill status={deleted ? 'rejected' : u.status} label={deleted ? 'Deleted' : undefined} />} />
          <Field label="Email" value={u.email || '—'} />
          <Field label="Phone" value={u.phone || '—'} />
          <Field label="City" value={u.city || '—'} />
          <Field label="Address" value={u.address || '—'} />
          <Field label="Joined" value={new Date(u.created_at).toLocaleDateString('en-IN')} />
        </Card>

        {u.role === 'seller' && (
          <Card>
            <div style={css('font-weight:800;font-size:15px;margin-bottom:6px;')}>Their shop</div>
            {shop ? (
              <>
                <Field label="Boutique" value={shop.name} />
                <Field label="Status" value={BOUTIQUE_STATUS[shop.status] ?? shop.status} />
                <div style={css('margin-top:12px;')}>
                  <GhostButton tone="primary" icon="storefront" onClick={() => navigate(adminPath(`boutiques/${shop.id}`))}>
                    Open shop page
                  </GhostButton>
                </div>
              </>
            ) : (
              <div style={css(`font-size:13px;color:${T.muted};`)}>This seller has not set up a shop yet.</div>
            )}
          </Card>
        )}
      </div>

      {/* Order history */}
      <div>
        <div style={css('font-weight:800;font-size:15px;margin-bottom:10px;')}>Order history</div>
        {(detail?.orders.length ?? 0) === 0 ? (
          <Card><EmptyState icon="receipt_long" title="No orders" sub="This account has not placed any orders." /></Card>
        ) : (
          <div style={css('display:flex;flex-direction:column;gap:10px;')}>
            {(detail?.orders ?? []).map((o) => (
              <div key={o.id} style={css(T.card + 'padding:13px 15px;display:flex;align-items:center;gap:13px;')}>
                <Icon name="receipt_long" size={18} color="var(--ag-muted-soft)" />
                <div style={css('flex:1;min-width:0;')}>
                  <div style={css('font-weight:700;font-size:13px;')}>{o.order_number}</div>
                  <div style={css(`font-size:11.5px;color:${T.muted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`)}>{o.boutique} · {new Date(o.created_at).toLocaleDateString('en-IN')}</div>
                </div>
                <StatusPill status={o.status} />
                <span style={css('font-weight:800;font-size:13.5px;font-variant-numeric:tabular-nums;')}>{fmtInr(o.total)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Dialogs — same copy and guards as the directory */}
      <ConfirmDialog
        open={dialog === 'block'}
        title="Block this account?"
        message={`${u.full_name} will not be able to sign in. They are emailed about it${u.email ? ` at ${u.email}` : ''}, and any reason you give below is quoted to them word for word.`}
        confirmLabel="Block" danger busy={busy}
        onConfirm={() => void doBlock()} onCancel={() => { setDialog(null); setReason(''); }}
      >
        <ReasonField value={reason} onChange={setReason} placeholder="e.g. Repeated chargebacks on delivered orders" />
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'resetmfa'}
        title="Reset two-factor authentication?"
        message={`${u.full_name || 'This account'} will lose every second factor — authenticator apps and their security email alike — and must set one up again on next sign-in. Until they do, they cannot open the console. Only do this once you are certain who you are talking to.`}
        confirmLabel="Reset two-factor" danger busy={busy}
        onConfirm={() => void doResetMfa()} onCancel={() => setDialog(null)}
      />

      <ConfirmDialog
        open={dialog === 'delete'}
        title="Delete user permanently?"
        message={`${u.full_name} will be permanently deleted, including their login. If they have orders or chat history those records are kept and the account is archived instead. This can't be undone.`}
        confirmLabel="Delete" danger busy={busy}
        onConfirm={() => void doDelete()} onCancel={() => { setDialog(null); setReason(''); }}
      >
        <ReasonField value={reason} onChange={setReason} placeholder="e.g. Closed at the account holder's request" />
      </ConfirmDialog>
    </Shell>
  );
}

const BOUTIQUE_STATUS: Record<string, string> = {
  draft: 'Draft', pending: 'Pending review', changes_requested: 'Changes requested', approved: 'Approved', rejected: 'Rejected',
};

function Shell({ onBack, children }: { onBack: () => void; children: React.ReactNode }) {
  return (
    <div style={css('display:flex;flex-direction:column;gap:16px;')}>
      <button onClick={onBack} style={css(`display:inline-flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;color:${T.muted};font-weight:700;font-size:13px;font-family:inherit;padding:0;width:fit-content;`)}>
        <Icon name="arrow_back" size={18} /> All users
      </button>
      {children}
    </div>
  );
}

/** Inline edit of the directory fields, role included — the same updateUser the
 *  list calls, so the server applies the identical role-change guards. */
function EditCard({ user, onSaved, log }: { user: AdminUserRow; onSaved: () => void; log: (action: string, meta?: Record<string, unknown>) => void }) {
  const { showToast } = useShop();
  const [fullName, setFullName] = useState(user.full_name);
  const [phone, setPhone] = useState(user.phone ?? '');
  const [city, setCity] = useState(user.city ?? '');
  const [address, setAddress] = useState(user.address ?? '');
  const [role, setRole] = useState<Role>(user.role);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!fullName.trim()) { showToast('Name is required', 'warning'); return; }
    setBusy(true);
    try {
      const res = await updateUser(user.id, { fullName: fullName.trim(), phone, city, address, role });
      await log('user.update', { name: fullName.trim(), role });
      showToast(user.role === role ? `${fullName.trim()} updated` : res.message);
      onSaved();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Update failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const label = css('font-size:12px;font-weight:700;color:var(--ag-label);display:block;margin-top:12px;');
  const field = css('width:100%;margin-top:5px;border:1.5px solid var(--ag-border);background:var(--ag-surface);border-radius:11px;padding:0 12px;height:40px;font-size:13.5px;font-weight:600;color:var(--ag-ink);font-family:inherit;box-sizing:border-box;');

  return (
    <Card>
      <div style={css('font-weight:800;font-size:15px;')}>Edit details</div>
      {user.email && <div style={css(`font-size:12px;color:${T.muted};margin-top:4px;`)}>{user.email} · email is the login and can't be changed here.</div>}
      <label style={label}>Full name<input value={fullName} onChange={(e) => setFullName(e.target.value)} style={field} /></label>
      <div className="agx-adm-g2">
        <label style={label}>Phone<input value={phone} onChange={(e) => setPhone(e.target.value)} style={field} /></label>
        <label style={label}>City<input value={city} onChange={(e) => setCity(e.target.value)} style={field} /></label>
      </div>
      <label style={label}>Address<textarea value={address} onChange={(e) => setAddress(e.target.value)} style={css(field + 'height:66px;padding:9px 12px;resize:vertical;')} /></label>
      <label style={label}>Role
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} style={css(field + 'cursor:pointer;')}>
          <option value="buyer">Buyer</option>
          <option value="seller">Seller</option>
          <option value="staff">Staff — console, no money or settings</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      <div style={css('margin-top:16px;')}>
        <GhostButton tone="primary" icon="save" onClick={() => { if (!busy) void save(); }}>{busy ? 'Saving…' : 'Save changes'}</GhostButton>
      </div>
    </Card>
  );
}

function ReasonField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div style={css('margin-top:16px;text-align:left;')}>
      <label style={css('display:block;font-weight:700;font-size:12.5px;margin-bottom:6px;color:var(--ag-label);')}>
        Reason <span style={css('font-weight:600;color:var(--ag-muted);')}>(optional — the user will see this)</span>
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, 500))}
        placeholder={placeholder}
        rows={3}
        style={css('width:100%;border:1.5px solid var(--ag-border);background:var(--ag-surface);border-radius:12px;padding:10px 14px;font-size:14px;font-family:inherit;resize:vertical;line-height:1.5;color:var(--ag-ink);box-sizing:border-box;')}
      />
    </div>
  );
}

export default UserDetail;

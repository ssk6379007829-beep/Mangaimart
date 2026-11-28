import { useMemo, useState } from 'react';
import { css } from '@/lib/css';
import { useShop } from '@/state/ShopContext';
import { useAsync } from '@/hooks/useAsync';
import {
  fetchConversationsAdmin, fetchMessagesAdmin, setMessageHidden, type AdminConversation,
} from '@/data/adminChat';
import { messagePreview, parseProductCard, parseOrderCard } from '@/data/chat';
import { Avatar, Card, EmptyState, Icon, SearchInput, T } from '@/components/admin/kit';

/**
 * Read (and moderate) buyer↔seller chats. Used three ways: the console-wide
 * Messages page (no filter), a boutique's Messages tab (`boutiqueId`), and a
 * buyer's Messages tab (`buyerId`). Admin-only, full content; a message can be
 * hidden or restored (migration 0125). Everything resolves to an empty list
 * before 0125 is applied, so the page is safe to ship ahead of the migration.
 */

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

export function AdminChats({ filter }: { filter?: { boutiqueId?: string; buyerId?: string } }) {
  const boutiqueId = filter?.boutiqueId;
  const buyerId = filter?.buyerId;
  const { data, loading, error } = useAsync(() => fetchConversationsAdmin({ boutiqueId, buyerId }), [boutiqueId, buyerId]);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<AdminConversation | null>(null);

  const convos = data ?? [];
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return convos;
    return convos.filter((c) =>
      c.buyer_name.toLowerCase().includes(needle) ||
      c.boutique_name.toLowerCase().includes(needle) ||
      c.last_message.toLowerCase().includes(needle));
  }, [convos, q]);

  // The selected conversation must stay valid after a reload.
  const active = selected ? convos.find((c) => c.id === selected.id) ?? selected : null;

  return (
    <div style={css('display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;')}>
      {/* Conversation list */}
      <div style={css('flex:1 1 300px;min-width:280px;max-width:380px;display:flex;flex-direction:column;gap:10px;')}>
        <SearchInput value={q} onChange={setQ} placeholder="Search buyer, shop or message…" />
        {loading && convos.length === 0 && <div style={css(`padding:14px;color:${T.muted};font-size:13.5px;`)}>Loading chats…</div>}
        {error && <div style={css('padding:14px;color:var(--ag-bad-text);font-size:13px;')}>Could not load chats — {error}. If this persists, apply migration 0125.</div>}
        {!loading && !error && list.length === 0 && (
          <Card><EmptyState icon="forum" title="No conversations" sub="Buyer–seller chats will appear here." /></Card>
        )}
        <div style={css('display:flex;flex-direction:column;gap:8px;')}>
          {list.map((c) => {
            const on = active?.id === c.id;
            return (
              <button
                key={c.id}
                onClick={() => setSelected(c)}
                style={css(`text-align:left;border:1.5px solid ${on ? 'var(--ag-crimson)' : 'var(--ag-border-soft)'};background:${on ? 'var(--ag-surface-2)' : 'var(--ag-surface)'};border-radius:14px;padding:11px 13px;cursor:pointer;font-family:inherit;display:flex;gap:11px;align-items:center;`)}
              >
                <Avatar name={c.buyer_name} tone={c.boutique_tone} />
                <div style={css('flex:1;min-width:0;')}>
                  <div style={css('font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;')}>
                    {c.buyer_name} <span style={css(`color:${T.muted};font-weight:600;`)}>· {c.boutique_name}</span>
                  </div>
                  <div style={css(`font-size:11.5px;color:${T.muted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`)}>{c.last_message}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Thread */}
      <div style={css('flex:2 1 340px;min-width:300px;')}>
        {active ? (
          <Thread key={active.id} conversation={active} />
        ) : (
          <Card><EmptyState icon="chat" title="Select a conversation" sub="Pick a chat on the left to read it." /></Card>
        )}
      </div>
    </div>
  );
}

function Thread({ conversation }: { conversation: AdminConversation }) {
  const { showToast } = useShop();
  const [refreshKey, setRefreshKey] = useState(0);
  const { data: messages, loading } = useAsync(() => fetchMessagesAdmin(conversation.id), [conversation.id, refreshKey]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const toggleHidden = async (id: string, hidden: boolean) => {
    setBusyId(id);
    try {
      await setMessageHidden(id, hidden);
      showToast(hidden ? 'Message hidden from the chat' : 'Message restored');
      setRefreshKey((k) => k + 1);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not update', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const rows = messages ?? [];

  return (
    <div style={css(T.card + 'display:flex;flex-direction:column;max-height:70vh;')}>
      <div style={css('flex:none;padding:14px 18px;border-bottom:1px solid var(--ag-border-soft);')}>
        <div style={css('font-weight:800;font-size:14.5px;')}>{conversation.buyer_name} ↔ {conversation.boutique_name}</div>
        <div style={css(`font-size:11.5px;color:${T.muted};`)}>Started {fmtTime(conversation.created_at)}</div>
      </div>

      <div className="agx-scroll" style={css('flex:1;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:12px;')}>
        {loading && rows.length === 0 && <div style={css(`color:${T.muted};font-size:13px;`)}>Loading messages…</div>}
        {!loading && rows.length === 0 && <div style={css(`color:${T.muted};font-size:13px;`)}>No messages in this chat.</div>}
        {rows.map((m) => {
          const fromBuyer = m.sender_id === conversation.buyer_id;
          const card = parseProductCard(m.body) || parseOrderCard(m.body);
          const text = card ? messagePreview(m.body) : m.body;
          const hidden = !!m.hidden_at;
          return (
            <div key={m.id} style={css(`display:flex;flex-direction:column;align-items:${fromBuyer ? 'flex-start' : 'flex-end'};gap:3px;`)}>
              <div style={css(`font-size:10.5px;font-weight:700;color:${T.muted};`)}>
                {fromBuyer ? conversation.buyer_name : conversation.boutique_name} · {fmtTime(m.created_at)}
              </div>
              <div style={css(`max-width:78%;padding:9px 13px;border-radius:14px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;${
                hidden
                  ? 'background:var(--ag-surface-2);color:var(--ag-muted);font-style:italic;border:1px dashed var(--ag-border);'
                  : fromBuyer
                    ? 'background:var(--ag-surface-2);color:var(--ag-ink);'
                    : 'background:linear-gradient(135deg,#D6336C,#B02454);color:#fff;'
              }`)}>
                {text}
              </div>
              <button
                onClick={() => { if (busyId !== m.id) void toggleHidden(m.id, !hidden); }}
                style={css(`display:inline-flex;align-items:center;gap:4px;background:none;border:none;cursor:pointer;font:inherit;font-size:10.5px;font-weight:700;color:${hidden ? 'var(--ag-good-text)' : 'var(--ag-muted)'};padding:0;`)}
              >
                <Icon name={hidden ? 'visibility' : 'visibility_off'} size={13} />
                {hidden ? 'Restore' : 'Hide'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { css } from '@/lib/css';
import { useAuth } from '@/auth/AuthContext';
import { fetchMyBoutique } from '@/data/boutiques';
import { fetchConversationsForBuyer, fetchConversationsForBoutique } from '@/data/chat';
import { useNotifications } from '@/state/NotificationContext';

/**
 * Bell icon, shared by the buyer, seller and admin headers so the three
 * consoles read one live notification stream instead of three separate bells.
 * Tapping it opens the full inbox page directly (no dropdown). `viewAllTo` is
 * the inbox route each console already has: /notifications,
 * /seller/notifications, /admin/notifications.
 */
export function NotificationBellMenu({ viewAllTo }: { viewAllTo: string }) {
  const navigate = useNavigate();
  const { unreadCount } = useNotifications();

  return (
    <button
      onClick={() => navigate(viewAllTo)}
      aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
      title="Notifications"
      style={css('position:relative;width:44px;height:44px;flex:none;border-radius:14px;border:1px solid var(--ag-border-soft);background:var(--ag-surface);cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 22px -16px rgba(107,20,54,.7);')}
    >
      <span aria-hidden="true" style={css("font-family:'Material Symbols Outlined';font-size:23px;color:var(--ag-crimson);")}>notifications</span>
      {unreadCount > 0 && (
        <span style={css('position:absolute;top:-5px;right:-5px;min-width:19px;height:19px;padding:0 5px;border-radius:10px;background:#D6336C;color:#fff;font-size:10.5px;font-weight:800;display:flex;align-items:center;justify-content:center;border:2px solid var(--ag-bg);')}>
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  );
}

/**
 * How many conversations still hold messages the viewer hasn't read — the
 * number badged on the bottom-dock Messages tab, for buyer and seller alike.
 *
 * This counts unread *conversations*, from the same read-receipt source the
 * inbox uses (migration 0043's `*_last_read_at`, via `shapeConversations`) —
 * NOT unread 'Messages' notification rows, which is what it used to do. The two
 * disagree the moment you read a chat: opening a thread stamps the read receipt
 * (ChatView → markConversationRead) but never touches the notification row, so
 * the old badge stayed lit over a message that had plainly been seen ("I've
 * seen the message but it still shows 1"). Deriving the badge from conversations
 * means simply opening a chat clears its share, the way every other inbox on the
 * phone behaves. The notification bell keeps its own 'Messages' rows — that
 * surface is "notifications", this one is "unread chats".
 *
 * Kept live without a realtime subscription of its own:
 *  • a new incoming message arrives as a fresh unread 'Messages' notification in
 *    the shared stream (the notify_new_message trigger inserts one for the
 *    recipient on every message), so that count is a cheap "recount now" pulse;
 *  • leaving a chat route means the viewer just read it, so recount then too.
 * It deliberately does NOT refetch on every navigation — the conversations read
 * pulls each thread's messages, so it fires only on those two signals plus the
 * initial load.
 */
export function useUnreadMessageCount(): number {
  const { profile } = useAuth();
  const { items } = useNotifications();
  const { pathname } = useLocation();
  const [count, setCount] = useState(0);

  const profileId = profile?.id ?? null;
  const role = profile?.role ?? null;

  // The number of unread 'Messages' notifications only serves as a change
  // signal here: when it ticks up, a chat has a new message to recount.
  const incomingPulse = items.filter((n) => n.type === 'Messages' && !n.read).length;

  // Recount after the viewer leaves a chat thread (they've just read it and the
  // receipt is stamped), rather than on every route change.
  const prevPath = useRef(pathname);
  const [exitTick, setExitTick] = useState(0);
  useEffect(() => {
    if (prevPath.current.includes('/chat') && !pathname.includes('/chat')) {
      setExitTick((t) => t + 1);
    }
    prevPath.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (!profileId || (role !== 'buyer' && role !== 'seller')) {
      setCount(0);
      return;
    }
    let active = true;
    (async () => {
      try {
        let convos;
        if (role === 'seller') {
          const boutique = await fetchMyBoutique(profileId);
          convos = boutique ? await fetchConversationsForBoutique(boutique.id) : [];
        } else {
          convos = await fetchConversationsForBuyer(profileId);
        }
        if (active) setCount(convos.filter((c) => c.unread > 0).length);
      } catch {
        // Keep the last good count rather than flashing to 0 on a transient read error.
      }
    })();
    return () => {
      active = false;
    };
  }, [profileId, role, incomingPulse, exitTick]);

  return count;
}

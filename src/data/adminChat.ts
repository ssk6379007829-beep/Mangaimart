import { supabase } from '@/lib/supabase';
import { messagePreview } from '@/data/chat';
import type { MessageRow } from '@/data/types';

/**
 * Admin view of the buyer↔seller chats (migration 0125). Admins get a read over
 * every conversation and message through an `is_admin()` RLS policy, plus a way
 * to hide an individual message. Before 0125 is applied the read policy does not
 * exist, so these resolve to an empty list rather than erroring.
 */

export interface AdminConversation {
  id: string;
  buyer_id: string;
  boutique_id: string;
  created_at: string;
  buyer_name: string;
  boutique_name: string;
  boutique_tone: number;
  last_message: string;
  last_message_at: string | null;
}

type Filter = { boutiqueId?: string; buyerId?: string };

/** Every conversation (optionally scoped to one shop or one buyer), newest
 *  activity first, with both participants named. */
export async function fetchConversationsAdmin(filter: Filter = {}): Promise<AdminConversation[]> {
  let q = supabase
    .from('conversations')
    .select('id, buyer_id, boutique_id, created_at, buyer:profiles!conversations_buyer_id_fkey(full_name), boutique:boutiques(name, tone), messages(body, created_at)');
  if (filter.boutiqueId) q = q.eq('boutique_id', filter.boutiqueId);
  if (filter.buyerId) q = q.eq('buyer_id', filter.buyerId);

  const { data, error } = await q;
  if (error) throw error;

  type Row = {
    id: string; buyer_id: string; boutique_id: string; created_at: string;
    buyer: { full_name: string } | null;
    boutique: { name: string; tone: number } | null;
    messages: { body: string; created_at: string }[] | null;
  };

  return ((data ?? []) as unknown as Row[])
    .map((r) => {
      const ordered = [...(r.messages ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
      const last = ordered[ordered.length - 1];
      return {
        id: r.id,
        buyer_id: r.buyer_id,
        boutique_id: r.boutique_id,
        created_at: r.created_at,
        buyer_name: r.buyer?.full_name ?? 'Customer',
        boutique_name: r.boutique?.name ?? 'Boutique',
        boutique_tone: r.boutique?.tone ?? 0,
        last_message: last ? messagePreview(last.body) : 'No messages yet',
        last_message_at: last?.created_at ?? null,
      };
    })
    .sort((a, b) => (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at));
}

/** Every message in a thread, hidden ones included (greyed in the admin view). */
export async function fetchMessagesAdmin(conversationId: string): Promise<MessageRow[]> {
  const withHidden = await supabase
    .from('messages').select('id, conversation_id, sender_id, body, created_at, hidden_at')
    .eq('conversation_id', conversationId).order('created_at', { ascending: true });
  if (!withHidden.error) return (withHidden.data ?? []) as MessageRow[];
  // 42703 = undefined column: 0125 not applied yet. Retry without the flag.
  if (withHidden.error.code !== '42703') throw withHidden.error;
  const plain = await supabase
    .from('messages').select('id, conversation_id, sender_id, body, created_at')
    .eq('conversation_id', conversationId).order('created_at', { ascending: true });
  if (plain.error) throw plain.error;
  return (plain.data ?? []) as MessageRow[];
}

/** Hide or restore a single message (admin-only; migration 0125). */
export async function setMessageHidden(messageId: string, hidden: boolean): Promise<void> {
  const { error } = await supabase.rpc('admin_set_message_hidden', { p_message: messageId, p_hidden: hidden });
  if (error) throw error;
}

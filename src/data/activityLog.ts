import { supabase } from '@/lib/supabase';

export interface ActivityRow {
  id: string;
  actor_id: string | null;
  actor_name: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

/**
 * Append an admin action to the audit trail. Best-effort: a logging failure must
 * never block the action the admin actually performed, so errors are swallowed.
 */
export async function logAdminAction(input: {
  actor_id?: string | null;
  actor_name?: string;
  action: string;
  entity_type: string;
  entity_id?: string | null;
  meta?: Record<string, unknown>;
}) {
  try {
    await supabase.from('admin_activity_log').insert({
      actor_id: input.actor_id ?? null,
      actor_name: input.actor_name ?? 'Admin',
      action: input.action,
      entity_type: input.entity_type,
      entity_id: input.entity_id ?? null,
      meta: input.meta ?? {},
    });
  } catch {
    /* audit logging is best-effort */
  }
}

export async function fetchActivity(limit = 30): Promise<ActivityRow[]> {
  const { data, error } = await supabase
    .from('admin_activity_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ActivityRow[];
}

/**
 * Logged admin actions against one entity — e.g. a boutique's own page timeline.
 * Best-effort: the audit log is admin-only (migration 0086 gives staff no policy
 * on it), so a staff caller or a missing table resolves to an empty list rather
 * than breaking the page it feeds.
 */
export async function fetchActivityForEntity(entityType: string, entityId: string, limit = 30): Promise<ActivityRow[]> {
  const { data, error } = await supabase
    .from('admin_activity_log')
    .select('*')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('[activity] entity log unavailable:', error.message);
    return [];
  }
  return (data ?? []) as ActivityRow[];
}

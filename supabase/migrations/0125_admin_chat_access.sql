-- 0125: admin visibility + moderation of buyer↔seller chats.
--
-- The in-app chat (`conversations` + `messages`) is readable only by its two
-- participants. The admin console has no way to monitor it, which it needs for
-- abuse, leaked contact details and off-platform selling.
--
-- This grants ADMINS ONLY (not staff) a read over every conversation and
-- message, and a way to hide an individual message. `is_admin()` is the safe
-- helper (CLAUDE.md rule 7 — never revoked), and these policies are ADDITIVE to
-- the existing participant policies, so nothing a buyer or seller can already do
-- changes.
--
-- A hidden message stays in the table (reversible, auditable) but drops out of
-- the buyer/seller thread — `fetchMessages` filters `hidden_at is null`. The
-- admin view shows it, greyed, with who hid it.
--
-- Idempotent: `add column if not exists`, `drop policy if exists` + recreate,
-- `create or replace function`.

alter table messages add column if not exists hidden_at timestamptz;
alter table messages add column if not exists hidden_by uuid;

-- ── Admin reads ──────────────────────────────────────────────────────────────
drop policy if exists admin_read_conversations on conversations;
create policy admin_read_conversations on conversations
  for select to authenticated using (is_admin());

drop policy if exists admin_read_messages on messages;
create policy admin_read_messages on messages
  for select to authenticated using (is_admin());

-- ── Moderation ───────────────────────────────────────────────────────────────
-- Through a function rather than a broad UPDATE policy, so an admin is never
-- handed write access to a buyer's or seller's message body — only the hidden
-- flag moves, and only an admin can move it.
create or replace function admin_set_message_hidden(p_message uuid, p_hidden boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'messages: admin only';
  end if;
  update messages
     set hidden_at = case when p_hidden then now() else null end,
         hidden_by = case when p_hidden then auth.uid() else null end
   where id = p_message;
end;
$$;

revoke all on function admin_set_message_hidden(uuid, boolean) from public, anon;
grant execute on function admin_set_message_hidden(uuid, boolean) to authenticated;

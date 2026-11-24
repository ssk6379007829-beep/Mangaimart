-- Short links for the offline-sale bill PDF.
--
-- A walk-in buyer's WhatsApp bill used to carry the raw Supabase signed URL —
-- ~200 characters of opaque token. This maps a short code to that URL so the
-- message can carry mangaimart.com/r/<code> instead. middleware.js resolves the
-- code at the edge and 302-redirects to the stored signed URL (see its
-- resolveBillLink()).
--
-- The code IS the capability: anyone with it can open that one bill for as long
-- as the row lives (30 days, matching the signed URL). So the table is NOT
-- publicly readable — anon resolves a code only through resolve_bill_link(), a
-- SECURITY DEFINER function that returns the URL for an EXACT code and nothing
-- else, which makes the links unguessable and unenumerable.
--
-- Additive and idempotent. Run once in the Supabase SQL editor.

create table if not exists bill_links (
  code        text primary key,
  bucket      text not null,
  path        text not null,
  -- The full signed URL, stored so the edge redirect needs no service key — it
  -- only reads this row through the function below and forwards here.
  signed_url  text not null,
  order_id    uuid,
  boutique_id uuid,
  created_by  uuid references profiles(id) on delete set null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_bill_links_expires_at on bill_links (expires_at);

alter table bill_links enable row level security;

-- A signed-in seller creates their own links; they can read back their own.
-- No anon policy at all — resolution goes through the function below.
drop policy if exists "bill_links: owner insert" on bill_links;
drop policy if exists "bill_links: owner read" on bill_links;

create policy "bill_links: owner insert" on bill_links for insert
  to authenticated
  with check (created_by = auth.uid());

create policy "bill_links: owner read" on bill_links for select
  to authenticated
  using (created_by = auth.uid());

-- Public resolution by EXACT code only. SECURITY DEFINER so it bypasses the
-- (locked) table RLS, STABLE so PostgREST serves it over GET, and it returns the
-- signed URL only while the link is unexpired. A caller who does not know the
-- exact code gets nothing, and cannot list.
create or replace function resolve_bill_link(p_code text)
returns table (signed_url text)
language sql
stable
security definer
set search_path = public
as $$
  select bl.signed_url
  from bill_links bl
  where bl.code = p_code and bl.expires_at > now()
  limit 1;
$$;

grant execute on function resolve_bill_link(text) to anon, authenticated;

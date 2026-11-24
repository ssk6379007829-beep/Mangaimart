-- Hosting for the shareable offline-sale bill PDF.
--
-- The seller's "Share Bill on WhatsApp" flow used to render the bill to a PNG
-- and push it into the device share sheet as a photo. It now generates the bill
-- PDF in the browser, uploads it here, and sends the walk-in buyer a friendly
-- WhatsApp message with a direct download link (see src/pages/seller/Billing.tsx
-- and src/lib/privateUpload.ts). The buyer taps the link and the PDF downloads.
--
-- PRIVATE bucket, like expense-proofs (0056) and unlike product-images (0008):
-- a bill carries the buyer's name, phone number and what they bought, so it is
-- reached through a short-lived SIGNED URL — here 30 days, long enough that a
-- buyer can reopen their receipt but not a link that lives forever. The seller
-- needs SELECT as well as INSERT because createSignedUrl() is evaluated under
-- the seller's own grants.
--
-- Files are stored under the owning boutique's id, exactly like product-images:
--   offline-bills/<boutique_id>/<random>.pdf
-- so the folder-scoped owner check is the same shape as 0008.
--
-- Additive and idempotent. Run once in the Supabase SQL editor.

insert into storage.buckets (id, name, public)
values ('offline-bills', 'offline-bills', false)
on conflict (id) do update set public = false;

drop policy if exists "offline-bills: owner read"   on storage.objects;
drop policy if exists "offline-bills: owner upload" on storage.objects;
drop policy if exists "offline-bills: owner delete" on storage.objects;

-- SELECT is what createSignedUrl() checks — without it the seller can upload a
-- bill but never mint a link to it. Scoped to the owning boutique's folder.
create policy "offline-bills: owner read" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'offline-bills'
    and exists (
      select 1 from public.boutiques b
      where b.owner_id = auth.uid() and (storage.foldername(name))[1] = b.id::text
    )
  );

create policy "offline-bills: owner upload" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'offline-bills'
    and exists (
      select 1 from public.boutiques b
      where b.owner_id = auth.uid() and (storage.foldername(name))[1] = b.id::text
    )
  );

create policy "offline-bills: owner delete" on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'offline-bills'
    and exists (
      select 1 from public.boutiques b
      where b.owner_id = auth.uid() and (storage.foldername(name))[1] = b.id::text
    )
  );

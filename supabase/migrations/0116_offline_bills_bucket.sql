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
-- Files are stored under the UPLOADING SELLER'S user id:
--   offline-bills/<auth.uid()>/<random>.pdf
-- and ownership is checked from that first folder segment ALONE — no read of
-- the boutiques table. This is deliberate: 0017 found the boutiques sub-check
-- used by 0008/0016 ("exists (select 1 from boutiques b where b.owner_id =
-- auth.uid() and (storage.foldername(name))[1] = b.id::text)") evaluates false
-- in practice and rejected every upload. product-images solved that by dropping
-- to "any authenticated user", but these bills are private PII, so that would
-- let any signed-in seller list and sign another shop's bills. Checking the path
-- against auth.uid() keeps each seller isolated to their own folder with a pure
-- path + JWT test that has no table dependency to misfire.
--
-- Additive and idempotent. Run once in the Supabase SQL editor.

insert into storage.buckets (id, name, public)
values ('offline-bills', 'offline-bills', false)
on conflict (id) do update set public = false;

drop policy if exists "offline-bills: owner read"   on storage.objects;
drop policy if exists "offline-bills: owner upload" on storage.objects;
drop policy if exists "offline-bills: owner delete" on storage.objects;

-- SELECT is what createSignedUrl() checks — without it the seller can upload a
-- bill but never mint a link to it. Scoped to the seller's own id folder.
create policy "offline-bills: owner read" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'offline-bills'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "offline-bills: owner upload" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'offline-bills'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "offline-bills: owner delete" on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'offline-bills'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

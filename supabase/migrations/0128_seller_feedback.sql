-- Seller feedback about MangaiMart itself.
--
-- The buyer side of this has existed since 0071 (`platform_feedback`): a private,
-- after-delivery "how was MangaiMart?" that only the operator reads. Sellers had
-- no equivalent — the only seller-authored signal was a support ticket. This adds
-- the parallel channel: a boutique owner rates the platform, picks a category and
-- writes a note, and it lands on an admin-only console screen (/admin/seller-feedback).
--
-- Deliberately SEPARATE from `platform_feedback`: that table is keyed to a buyer
-- and an order, carries a public-quote consent flag (0084) and feeds the Home
-- page testimonials. None of that applies here. Seller feedback is never public,
-- never quoted, and is keyed to a boutique, so it gets its own table rather than
-- a nullable-buyer bolt-on that would make every existing policy and the Home
-- RPC have to reason about "which kind of row is this".
--
-- Private by design: there is no public read policy and none should be added. A
-- seller reads only their OWN rows (so the app can tell whether they have already
-- given feedback and stop nagging); the operator reads everything via is_admin().
--
-- Idempotent — safe to re-run in the Supabase SQL editor. Requires 0006
-- (is_admin, profiles) and 0021 (boutiques.owner_id).

create table if not exists seller_feedback (
  id uuid primary key default gen_random_uuid(),
  boutique_id uuid not null references boutiques(id) on delete cascade,
  -- The submitting owner. Snapshotted so an ownership transfer later never
  -- reattributes an old note; also what the seller-read policy checks.
  seller_id uuid not null references profiles(id) on delete set null,
  rating smallint not null,
  -- A coarse bucket for triage, mirrored by SELLER_FEEDBACK_CATEGORIES in
  -- src/data/sellerFeedback.ts — keep the two lists in step.
  category text not null default 'other',
  body text not null default '',
  created_at timestamptz not null default now(),

  constraint seller_feedback_rating_check check (rating between 1 and 5),
  constraint seller_feedback_category_check check (category in (
    'bug', 'feature', 'payments', 'delivery', 'experience', 'other'
  ))
);

create index if not exists idx_seller_feedback_created on seller_feedback (created_at desc);
create index if not exists idx_seller_feedback_boutique on seller_feedback (boutique_id, created_at desc);

alter table seller_feedback enable row level security;

-- The operator sees and manages everything. is_admin() is never revoked from
-- anon (see CLAUDE.md), so this is safe without a TO clause.
do $$ begin
  create policy "seller_feedback: admin all" on seller_feedback
    for all using (is_admin()) with check (is_admin());
exception when duplicate_object then null; end $$;

-- A seller may READ their own boutique's feedback. This is what lets the app
-- ask "has this seller already told us what they think?" and not nag — it is
-- not for a seller-facing list.
do $$ begin
  create policy "seller_feedback: seller read own" on seller_feedback
    for select to authenticated using (
      exists (select 1 from boutiques b where b.id = seller_feedback.boutique_id and b.owner_id = auth.uid())
    );
exception when duplicate_object then null; end $$;

-- A seller may INSERT a note for a boutique they own, authored as themselves.
-- Both halves matter: the boutique must be theirs AND seller_id must be their
-- own uid, so a note can never be filed under someone else's name.
do $$ begin
  create policy "seller_feedback: seller insert own" on seller_feedback
    for insert to authenticated with check (
      seller_id = auth.uid()
      and exists (select 1 from boutiques b where b.id = seller_feedback.boutique_id and b.owner_id = auth.uid())
    );
exception when duplicate_object then null; end $$;

-- =============================================================================
-- 007_shopfront_items_view.sql — protect the cost price (Golden Rule #4).
--
-- RLS is row-level, not column-level. The items_public_select policy (003) gave
-- anon + buyers SELECT on whole item rows, so purchase_rate (cost) leaked through
-- the REST API even though the UI never shows it. Column GRANTs can't fix this:
-- owner/staff and customers are all the single Postgres `authenticated` role, so
-- grants can't tell them apart.
--
-- Fix: route anon + buyers through a column-safe view that never selects
-- purchase_rate, and drop their direct SELECT on the base table. Owner/staff keep
-- full base-table access (their policies are unchanged) — they need the cost.
-- =============================================================================

-- View is postgres-owned (security_invoker off) so it bypasses base-table RLS;
-- the shopfront row rule (§9.1 — active + in stock) is therefore baked in here.
-- Single-shop system today; add shop scoping here if the platform goes multi-shop.
create or replace view public.shopfront_items
with (security_invoker = false) as
select
  i.id, i.shop_id, i.item_no, i.name, i.category_id,
  i.quantity, i.dealer_rate, i.rate, i.photo_url,
  i.low_stock_threshold, i.created_at
from public.items i
where i.is_active = true and i.quantity > 0;

grant select on public.shopfront_items to anon, authenticated;

-- Remove direct base-table reads for anon + buyers. They keep the table-level
-- GRANT but lose the policy, so RLS now denies them — no more cost-price leak.
-- (Owner: items_owner_select, Staff: items_staff_select remain in force.)
drop policy if exists items_public_select on public.items;

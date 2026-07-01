-- =============================================================================
-- 018_order_groups.sql — Cart / multi-item orders.
--
-- A buyer can now add several items to a cart and place them as one order. We
-- keep the proven one-row-per-item model (each row still gets its own Sale +
-- stock trigger on approval — Golden Rules #2, #5, #6 are untouched) and simply
-- TIE the rows of one cart together with a shared order_group_id.
--
--   * order_group_id is a client-generated uuid (one per checkout). NULL for the
--     legacy single-item orders that predate the cart, so every existing row
--     stays valid and reads as a group of one.
--   * Owner / buyer screens group their lists by this id; the column rides the
--     EXISTING orders RLS (no policy change) — it's just another column buyers
--     write on insert and owner/staff read.
-- =============================================================================

alter table public.orders
  add column if not exists order_group_id uuid;

comment on column public.orders.order_group_id is
  'Ties the rows of one cart checkout together. One uuid per checkout, set by the client. NULL = legacy single-item order (a group of one).';

-- Fast lookup of a cart''s sibling rows (owner approve-all, buyer order detail).
create index if not exists orders_order_group_id_idx
  on public.orders (order_group_id)
  where order_group_id is not null;

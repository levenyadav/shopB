-- =============================================================================
-- 020_item_discontinued.sql — "Discontinue product" (owner-driven, Inventory).
--
-- The owner needs to permanently retire a product line — stop offering it to
-- customers for good — WITHOUT deleting it. A hard delete is impossible anyway:
-- items are referenced by sales, purchases and the append-only ledger (Golden
-- Rules #1, #9), so history must keep pointing at the row.
--
-- `is_active` already exists, but it means "temporarily shown / hidden on the
-- shopfront" — an item you might switch back on tomorrow. "Discontinued" is a
-- distinct, stronger state: the line is retired for good. Keeping the two flags
-- separate lets the owner tell "hidden for now" apart from "gone".
--
-- Behaviour:
--   * Discontinued items are hidden from the public shopfront (baked into the
--     shopfront_items view below), regardless of is_active.
--   * They REMAIN sellable at the Counter (POS) so any leftover physical stock
--     can still be cleared — the CounterSale query filters on is_active only, so
--     no change is needed there. This is deliberate (owner chose "hide + warn if
--     stock remains", not "block every channel").
--   * The row stays in Inventory with a "Discontinued" badge so the owner can
--     watch the remaining quantity run down.
--
-- Both columns are additive with safe defaults, so existing rows stay live.
-- =============================================================================

alter table public.items
  add column if not exists discontinued    boolean not null default false,
  add column if not exists discontinued_at timestamptz;

comment on column public.items.discontinued    is 'Product line permanently retired by the owner. Hidden from the shopfront (see shopfront_items view) but still sellable at the Counter to clear leftover stock. Distinct from is_active (temporary shopfront hide).';
comment on column public.items.discontinued_at is 'When the item was discontinued. NULL while live. Set alongside discontinued=true; cleared on reactivate.';

-- Rebuild the buyer-facing view so discontinued lines never reach the shopfront,
-- ItemDetail, or a customer's order history. The column list MUST match the live
-- view's exactly (last set in 016: +moq/description/tags/images/hsn_sac) — a
-- CREATE OR REPLACE VIEW can only append columns, never drop or reorder them, so
-- shrinking the list back to 007 fails with 42P16 "cannot drop columns from view".
-- Still never selects purchase_rate (Golden Rule #4); only the WHERE grows.
create or replace view public.shopfront_items
with (security_invoker = false) as
select
  i.id, i.shop_id, i.item_no, i.name, i.category_id,
  i.quantity, i.dealer_rate, i.rate, i.photo_url,
  i.low_stock_threshold, i.created_at,
  i.moq, i.description, i.tags, i.images,
  i.hsn_sac
from public.items i
where i.is_active = true and i.quantity > 0 and i.discontinued = false;

grant select on public.shopfront_items to anon, authenticated;

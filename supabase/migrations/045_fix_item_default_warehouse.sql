-- =============================================================================
-- 045_fix_item_default_warehouse.sql — Correct items.warehouse_id from where
-- stock actually is.
--
-- Migration 044 blanket-set every existing item's default landing warehouse to
-- "Main Warehouse". Items later restocked into a different warehouse via the
-- per-line override (abf5ed2) never had this default updated, so it kept
-- showing "Main Warehouse" in Inventory's Edit form even when the product's
-- real stock had moved elsewhere. One-time fix: for every item with any
-- warehouse_stock rows, set its default to the warehouse holding the largest
-- quantity. Items with no warehouse_stock rows are left untouched.
-- =============================================================================

update public.items i
set warehouse_id = ws.warehouse_id
from (
  select distinct on (item_id) item_id, warehouse_id
  from public.warehouse_stock
  order by item_id, quantity desc, warehouse_id
) ws
where ws.item_id = i.id;

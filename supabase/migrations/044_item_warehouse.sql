-- =============================================================================
-- 044_item_warehouse.sql — Per-product warehouse assignment.
--
-- Purchase Entry (bill entry + quick restock) used to ask "which warehouse is
-- this stock-in going to" on every single purchase. That's now decided once,
-- per product, here instead: items.warehouse_id, set from Inventory / when
-- creating a new product on a bill, picked from the same warehouses list
-- Settings > Warehouses manages. Purchase Entry reads it and no longer shows
-- its own warehouse field. Golden Rules #1/#10 unchanged — this only changes
-- WHERE the warehouse choice is made, not who is allowed to move stock.
-- =============================================================================

alter table public.items add column if not exists warehouse_id uuid references public.warehouses(id);
create index if not exists idx_items_warehouse on public.items(warehouse_id);

comment on column public.items.warehouse_id is
  'Which warehouse this product stocks into by default (044) — set per product from Inventory (or when created on a Purchase Entry bill), options drawn from Settings > Warehouses. Purchase Entry and quick restock use this instead of asking per transaction. NULL resolves to "Main Warehouse" at stock-in time.';

-- Existing items default to each shop's Main Warehouse, so nothing is
-- "unassigned" the moment this ships.
update public.items i
set warehouse_id = w.id
from public.warehouses w
where w.shop_id = i.shop_id and w.name = 'Main Warehouse' and i.warehouse_id is null;

-- =============================================================================
-- 042_warehouse_stock.sql — Per-warehouse quantities (Phase 1/2 of per-location
-- stock; see 041 for context).
--
-- warehouse_stock is the future authoritative per-location count:
--   items.quantity  =  SUM(warehouse_stock.quantity) for that item
-- but that equality is NOT enforced by a trigger yet — Purchase Entry and Sale
-- still write items.quantity directly (Golden Rules #1/#2/#10 unchanged). This
-- migration only creates the table and backfills every item's current total
-- into "Main Warehouse", so the data exists ahead of the trigger rewrite that
-- will actually keep the two in sync. Do not read warehouse_stock as
-- authoritative until that follow-up migration lands.
-- =============================================================================

create table if not exists public.warehouse_stock (
  item_id      uuid not null references public.items(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  quantity     numeric(14,2) not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (item_id, warehouse_id)
);
create index if not exists idx_warehouse_stock_item on public.warehouse_stock(item_id);
create index if not exists idx_warehouse_stock_warehouse on public.warehouse_stock(warehouse_id);

alter table public.warehouse_stock enable row level security;

-- Same visibility as items itself: owner full read, staff read (no cost fields
-- live here, so staff reading it leaks nothing Golden Rule #4 protects).
create policy warehouse_stock_owner_select on public.warehouse_stock for select
  using (
    auth_role() = 'owner'
    and exists (select 1 from public.warehouses w where w.id = warehouse_id and w.shop_id = auth_shop_id())
  );
create policy warehouse_stock_staff_select on public.warehouse_stock for select
  using (
    auth_role() = 'staff'
    and exists (select 1 from public.warehouses w where w.id = warehouse_id and w.shop_id = auth_shop_id())
  );

-- Backfill: every item's current total lands in its shop's Main Warehouse.
insert into public.warehouse_stock (item_id, warehouse_id, quantity)
select i.id, w.id, i.quantity
from public.items i
join public.warehouses w on w.shop_id = i.shop_id and w.name = 'Main Warehouse'
on conflict (item_id, warehouse_id) do nothing;

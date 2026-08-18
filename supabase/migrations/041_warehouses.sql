-- =============================================================================
-- 041_warehouses.sql — Warehouse foundation (Phase 1 of per-location stock).
--
-- Today `items.quantity` is one total and `items.location` (025/etc.) is just a
-- display label — it cannot represent "500 in Warehouse A, 1000 in Warehouse B"
-- for the same item. This migration adds the `warehouses` table so a shop can
-- name its locations. It does NOT yet change how stock is tracked — that's
-- 042 (warehouse_stock, seeded from today's totals) and a later migration that
-- rewires Purchase Entry / Sale to operate per-warehouse. Until that lands,
-- items.quantity remains the sole authoritative number (Golden Rules #1/#10
-- untouched).
-- =============================================================================

create table if not exists public.warehouses (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops(id),
  name       text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (shop_id, name)
);
create index if not exists idx_warehouses_shop on public.warehouses(shop_id);

alter table public.warehouses enable row level security;

-- Same shape as suppliers/categories: owner manages; staff read (staff will
-- need to pick a warehouse when entering a purchase or ringing a counter sale).
create policy warehouses_owner_all on public.warehouses for all
  using (auth_role() = 'owner' and shop_id = auth_shop_id())
  with check (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy warehouses_staff_read on public.warehouses for select
  using (auth_role() = 'staff' and shop_id = auth_shop_id());

-- Every shop starts with one warehouse holding all its existing stock, so
-- nothing is "unplaced" once 042 backfills warehouse_stock from it.
insert into public.warehouses (shop_id, name)
select id, 'Main Warehouse' from public.shops
on conflict (shop_id, name) do nothing;

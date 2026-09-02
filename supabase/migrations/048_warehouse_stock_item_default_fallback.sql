-- =============================================================================
-- 048_warehouse_stock_item_default_fallback.sql — stop counter sales failing
-- when a product's stock lives outside "Main Warehouse".
--
-- adjust_warehouse_stock (043) resolves a NULL warehouse straight to the shop's
-- "Main Warehouse". Counter Sale never passes a warehouse (create_counter_sale
-- and on_sale_insert leave sales.warehouse_id NULL by design). 044 then moved the
-- warehouse choice to PER PRODUCT (items.warehouse_id) and 045 pointed each
-- product's default at the warehouse actually holding its stock. Result: a
-- product whose stock sits entirely in "Godown" has items.warehouse_id = Godown,
-- but a counter sale of it still tries to draw from an empty "Main Warehouse"
-- and adjust_warehouse_stock RAISES, failing the whole bill. What was a rare
-- edge case before 044/045 is now the normal case for any relocated product.
--
-- FIX. Resolve a NULL warehouse in three steps instead of one:
--     1. the explicit argument           (Purchase Entry / Sale approval)
--     2. the product's default warehouse  (items.warehouse_id — 044/045)
--     3. the shop's "Main Warehouse"      (last resort, unchanged)
-- Nothing that already passes a warehouse changes behaviour. Purchase INSERT /
-- UPDATE / DELETE and the shopfront sale path all still pass their chosen
-- warehouse explicitly, so only the no-warehouse callers (counter sale, and any
-- legacy row) start honouring the per-product default.
--
-- The `add column if not exists` below makes this migration self-sufficient even
-- if 044 has not been applied yet; it matches 044's definition exactly, so
-- running 044 afterwards is a harmless no-op for the column.
-- =============================================================================

alter table public.items
  add column if not exists warehouse_id uuid references public.warehouses(id);

create or replace function public.adjust_warehouse_stock(
  p_item_id      uuid,
  p_warehouse_id uuid,
  p_delta        numeric
) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_shop    uuid;
  v_item_wh uuid;
  v_wh      uuid;
  v_new     numeric(14,2);
  v_name    text;
  v_wh_name text;
begin
  select shop_id, name, warehouse_id
    into v_shop, v_name, v_item_wh
    from public.items where id = p_item_id;

  -- explicit arg -> product default (044/045) -> shop's Main Warehouse
  v_wh := coalesce(
    p_warehouse_id,
    v_item_wh,
    (select id from public.warehouses
      where shop_id = v_shop and name = 'Main Warehouse' limit 1)
  );
  if v_wh is null then
    raise exception 'No warehouse set up for this shop yet — run the warehouse migrations.';
  end if;

  insert into public.warehouse_stock (item_id, warehouse_id, quantity)
  values (p_item_id, v_wh, p_delta)
  on conflict (item_id, warehouse_id)
    do update set quantity = public.warehouse_stock.quantity + excluded.quantity,
                  updated_at = now()
  returning quantity into v_new;

  if v_new < 0 then
    select name into v_wh_name from public.warehouses where id = v_wh;
    raise exception 'Not enough stock of % in %: % pcs short.',
      coalesce(v_name, 'this item'), coalesce(v_wh_name, 'this warehouse'), abs(v_new);
  end if;

  return v_new;
end $$;

-- 057 — Log hand corrections to stock.
--
-- Stock moves in by Purchase Entry and out by Sale (Golden Rules #1, #2), and
-- both are recorded rows. The one other path is the owner correcting a count
-- from Inventory → Edit: it writes warehouse_stock (or items.quantity when the
-- shop has no warehouses) directly, and until now left no trace. The item
-- history screen could not show it, and a stock figure could change with no
-- explanation.
--
-- How a hand edit is told apart from a purchase/sale: every automatic stock
-- change happens INSIDE another trigger (on_purchase_*, on_sale_insert →
-- allocate_stock_out → adjust_warehouse_stock), so it reaches warehouse_stock
-- at pg_trigger_depth() >= 2. A direct client write fires these triggers at
-- depth 1. The items.quantity recompute done by the warehouse_stock sync
-- trigger is also depth >= 2, so a correction is logged once, not twice.
--
-- The log is append-only and written ONLY by these triggers (same stance as
-- the ledger, Golden Rule #9). Owner may read it; nobody may write it.

create table if not exists public.stock_adjustments (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id),
  item_id       uuid not null references public.items(id) on delete cascade,
  warehouse_id  uuid references public.warehouses(id),
  old_quantity  numeric(14,2) not null,
  new_quantity  numeric(14,2) not null,
  delta         numeric(14,2) not null,
  adjusted_by   uuid references public.profiles(id),
  created_at    timestamptz not null default now()
);
create index if not exists idx_stock_adjustments_item on public.stock_adjustments(item_id, created_at);

comment on table public.stock_adjustments is
  'Hand corrections to stock from Inventory → Edit (057). Written only by triggers on warehouse_stock / items at trigger depth 1; purchases and sales never appear here.';

alter table public.stock_adjustments enable row level security;
drop policy if exists stock_adjustments_owner_select on public.stock_adjustments;
create policy stock_adjustments_owner_select on public.stock_adjustments
  for select using (auth_role() = 'owner' and shop_id = auth_shop_id());
-- No insert/update/delete policy: clients cannot write it.

-- A correction to one warehouse's count.
create or replace function public.log_warehouse_stock_correction()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_old numeric := case when tg_op = 'UPDATE' then old.quantity else 0 end;
begin
  if pg_trigger_depth() > 1 then return null; end if;   -- purchase / sale path
  if new.quantity is not distinct from v_old then return null; end if;
  insert into public.stock_adjustments
    (shop_id, item_id, warehouse_id, old_quantity, new_quantity, delta, adjusted_by)
  select i.shop_id, new.item_id, new.warehouse_id, v_old, new.quantity,
         new.quantity - v_old, auth.uid()
    from public.items i where i.id = new.item_id;
  return null;
end $$;

drop trigger if exists trg_warehouse_stock_log on public.warehouse_stock;
create trigger trg_warehouse_stock_log
  after insert or update of quantity on public.warehouse_stock
  for each row execute function public.log_warehouse_stock_correction();

-- A correction to the item total, for a shop that keeps no per-warehouse rows.
create or replace function public.log_item_quantity_correction()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if pg_trigger_depth() > 1 then return null; end if;   -- recomputed by a trigger
  if new.quantity is not distinct from old.quantity then return null; end if;
  insert into public.stock_adjustments
    (shop_id, item_id, warehouse_id, old_quantity, new_quantity, delta, adjusted_by)
  values (new.shop_id, new.id, null, old.quantity, new.quantity,
          new.quantity - old.quantity, auth.uid());
  return null;
end $$;

drop trigger if exists trg_items_quantity_log on public.items;
create trigger trg_items_quantity_log
  after update of quantity on public.items
  for each row execute function public.log_item_quantity_correction();

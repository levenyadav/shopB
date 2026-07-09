-- =============================================================================
-- 028_item_detach_on_delete.sql — let the owner DELETE a transacted item while
-- keeping its history readable (labels preserved).
--
-- Before this, sales/purchases/orders held `item_id ... not null references
-- items(id)` with the default NO ACTION rule (001_create_tables.sql). Any line
-- with history blocked the delete with 23503, so a discontinued item could never
-- actually be removed (DeleteModal surfaced "Can't delete… stays discontinued").
--
-- New behaviour: each history row snapshots the item's item_no + name at write
-- time, the three FKs switch to ON DELETE SET NULL, and item_id becomes nullable.
-- Deleting an item now succeeds: history rows keep their snapshot labels (reports,
-- invoices, ledger descriptions stay intact) and just lose the live FK pointer.
-- The ledger references sales(id)/purchases(id), never items, so it is untouched.
-- category_id -> categories(id) is a separate FK (categories are not deleted), so
-- category labels are unaffected.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Snapshot columns (additive, nullable) — the durable report labels.
-- ---------------------------------------------------------------------------
alter table public.sales     add column if not exists item_no   text;
alter table public.sales     add column if not exists item_name text;
alter table public.purchases add column if not exists item_no   text;
alter table public.purchases add column if not exists item_name text;
alter table public.orders    add column if not exists item_no   text;
alter table public.orders    add column if not exists item_name text;

comment on column public.sales.item_name     is 'Item name snapshotted at sale time. Survives item deletion (FK item_id becomes NULL) so reports/invoices keep the product label.';
comment on column public.purchases.item_name is 'Item name snapshotted at purchase time. Survives item deletion so history keeps the product label.';
comment on column public.orders.item_name    is 'Item name snapshotted at order time. Survives item deletion so history keeps the product label.';

-- ---------------------------------------------------------------------------
-- 2. Backfill existing rows from the live item (only where not already set).
-- ---------------------------------------------------------------------------
update public.sales s
   set item_no = i.item_no, item_name = i.name
  from public.items i
 where i.id = s.item_id and s.item_name is null;

update public.purchases p
   set item_no = i.item_no, item_name = i.name
  from public.items i
 where i.id = p.item_id and p.item_name is null;

update public.orders o
   set item_no = i.item_no, item_name = i.name
  from public.items i
 where i.id = o.item_id and o.item_name is null;

-- ---------------------------------------------------------------------------
-- 3. Relax NOT NULL and re-point the FKs to ON DELETE SET NULL.
--    Constraint names follow Postgres defaults (<table>_item_id_fkey).
-- ---------------------------------------------------------------------------
alter table public.sales     alter column item_id drop not null;
alter table public.purchases alter column item_id drop not null;
alter table public.orders    alter column item_id drop not null;

alter table public.sales     drop constraint if exists sales_item_id_fkey;
alter table public.purchases drop constraint if exists purchases_item_id_fkey;
alter table public.orders    drop constraint if exists orders_item_id_fkey;

alter table public.sales
  add constraint sales_item_id_fkey
  foreign key (item_id) references public.items(id) on delete set null;
alter table public.purchases
  add constraint purchases_item_id_fkey
  foreign key (item_id) references public.items(id) on delete set null;
alter table public.orders
  add constraint orders_item_id_fkey
  foreign key (item_id) references public.items(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 4. Auto-fill the snapshot on every insert. One reusable function bound as a
--    BEFORE INSERT trigger on each table (all three now share the columns).
--    SECURITY DEFINER so it can read items regardless of the caller's RLS
--    (e.g. the create_counter_sale RPC and staff counter writes). Idempotent:
--    only fills when a live item_id is present and no snapshot was supplied.
-- ---------------------------------------------------------------------------
create or replace function public.fill_item_snapshot()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.item_id is not null and (new.item_name is null or new.item_name = '') then
    select item_no, name into new.item_no, new.item_name
      from public.items where id = new.item_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_sale_fill_snapshot     on public.sales;
drop trigger if exists trg_purchase_fill_snapshot on public.purchases;
drop trigger if exists trg_order_fill_snapshot    on public.orders;

create trigger trg_sale_fill_snapshot before insert on public.sales
  for each row execute function public.fill_item_snapshot();
create trigger trg_purchase_fill_snapshot before insert on public.purchases
  for each row execute function public.fill_item_snapshot();
create trigger trg_order_fill_snapshot before insert on public.orders
  for each row execute function public.fill_item_snapshot();

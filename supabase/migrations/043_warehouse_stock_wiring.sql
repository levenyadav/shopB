-- =============================================================================
-- 043_warehouse_stock_wiring.sql — Phase 3 of per-location stock (see 041/042).
--
-- Makes warehouse_stock the real, authoritative source of items.quantity and
-- wires warehouse selection into exactly the three places decided on:
--   * Inventory        — owner corrects stock per warehouse directly.
--   * Purchase Entry    — owner picks which warehouse new stock lands in.
--   * Sale approval      — owner picks which warehouse the sale draws from,
--                          BLOCKED if that warehouse doesn't have enough
--                          (Golden Rule: never let a warehouse go negative).
--
-- Counter Sale is explicitly OUT of scope (matches the earlier decision) — it
-- keeps writing sales.warehouse_id = NULL, which the helper below resolves to
-- the shop's "Main Warehouse". Known limitation: if new stock only ever lands
-- in a different warehouse via Purchase Entry, Main Warehouse can run dry and
-- block counter sales even though total stock elsewhere is fine. Revisit if
-- that becomes a real problem.
--
-- items.quantity = SUM(warehouse_stock.quantity) for that item, kept in sync
-- automatically by a trigger ON warehouse_stock itself — so ANY writer
-- (a purchase/sale trigger below, or the owner correcting a warehouse
-- directly from Inventory) ends up with a correct items.quantity, with no
-- duplicated recompute logic (Golden Rule #10: triggers, not app code, own it).
-- =============================================================================

alter table public.purchases add column if not exists warehouse_id uuid references public.warehouses(id);
alter table public.sales     add column if not exists warehouse_id uuid references public.warehouses(id);

comment on column public.purchases.warehouse_id is
  'Which warehouse this stock-in landed in (043). NULL on rows from before this migration, or from a path that has not been updated to set it — resolved to "Main Warehouse" by adjust_warehouse_stock().';
comment on column public.sales.warehouse_id is
  'Which warehouse this sale drew stock from (043). NULL for Counter Sale (out of scope — see migration header) and made-to-order lines, resolved to "Main Warehouse" by adjust_warehouse_stock() when it matters at all.';

-- ---------------------------------------------------------------------------
-- 1. items.quantity stays in lockstep with warehouse_stock automatically.
-- ---------------------------------------------------------------------------
create or replace function public.sync_item_quantity_from_warehouse_stock()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_item uuid := coalesce(new.item_id, old.item_id);
begin
  update public.items
     set quantity = coalesce((select sum(quantity) from public.warehouse_stock where item_id = v_item), 0)
   where id = v_item;
  return null;
end $$;

drop trigger if exists trg_warehouse_stock_sync on public.warehouse_stock;
create trigger trg_warehouse_stock_sync
  after insert or update or delete on public.warehouse_stock
  for each row execute function public.sync_item_quantity_from_warehouse_stock();

-- ---------------------------------------------------------------------------
-- 2. adjust_warehouse_stock() — the ONE place that moves stock in or out of a
-- warehouse. Every purchase/sale trigger below calls this instead of touching
-- items.quantity directly. p_delta is positive for stock in, negative for
-- stock out. Raises (blocking the whole transaction) if a warehouse would go
-- negative — this is where the "block" decision is enforced, for both
-- Purchase Entry corrections and Sale approval.
-- ---------------------------------------------------------------------------
create or replace function public.adjust_warehouse_stock(
  p_item_id      uuid,
  p_warehouse_id uuid,
  p_delta        numeric
) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_shop uuid;
  v_wh   uuid;
  v_new  numeric(14,2);
  v_name text;
  v_wh_name text;
begin
  select shop_id, name into v_shop, v_name from public.items where id = p_item_id;

  v_wh := coalesce(p_warehouse_id, (
    select id from public.warehouses where shop_id = v_shop and name = 'Main Warehouse' limit 1
  ));
  if v_wh is null then
    raise exception 'No warehouse set up for this shop yet — run the warehouse migrations.';
  end if;

  insert into public.warehouse_stock (item_id, warehouse_id, quantity)
  values (p_item_id, v_wh, p_delta)
  on conflict (item_id, warehouse_id)
    do update set quantity = public.warehouse_stock.quantity + excluded.quantity, updated_at = now()
  returning quantity into v_new;

  if v_new < 0 then
    select name into v_wh_name from public.warehouses where id = v_wh;
    raise exception 'Not enough stock of % in %: % pcs short.',
      coalesce(v_name, 'this item'), coalesce(v_wh_name, 'this warehouse'), abs(v_new);
  end if;

  return v_new;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Purchase triggers (002/033/039) — rewired onto adjust_warehouse_stock.
-- ---------------------------------------------------------------------------
create or replace function public.on_purchase_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare sup_bal numeric(14,2); item_name text;
begin
  select name into item_name from public.items where id = new.item_id;
  perform public.adjust_warehouse_stock(new.item_id, new.warehouse_id, new.quantity);

  update public.suppliers
     set balance_due = balance_due + new.total_cost
   where id = new.supplier_id
   returning balance_due into sup_bal;

  if new.purchase_group_id is null then
    insert into public.ledger (shop_id, entry_type, party_id, party_type,
                               reference_id, reference_table, debit, credit,
                               running_balance, description)
    values (new.shop_id, 'purchase', new.supplier_id, 'supplier',
            new.id, 'purchases', new.total_cost, 0,
            coalesce(sup_bal, 0), 'Purchase: ' || coalesce(item_name, 'item'));
  end if;
  return new;
end $$;

create or replace function public.on_purchase_update()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old_qty  numeric(14,2);
  v_new_qty  numeric(14,2);
  v_old_cost numeric(14,2);
  v_new_cost numeric(14,2);
begin
  if new.supplier_id is distinct from old.supplier_id then
    raise exception 'A bill cannot be moved to another supplier. Remove these lines and enter the bill under the right supplier.';
  end if;

  v_old_qty  := case when old.deleted_at is null then coalesce(old.quantity, 0)   else 0 end;
  v_new_qty  := case when new.deleted_at is null then coalesce(new.quantity, 0)   else 0 end;
  v_old_cost := case when old.deleted_at is null then coalesce(old.total_cost, 0) else 0 end;
  v_new_cost := case when new.deleted_at is null then coalesce(new.total_cost, 0) else 0 end;

  if new.item_id is distinct from old.item_id then
    if old.item_id is not null and v_old_qty <> 0 then
      perform public.adjust_warehouse_stock(old.item_id, old.warehouse_id, -v_old_qty);
    end if;
    if new.item_id is not null and v_new_qty <> 0 then
      perform public.adjust_warehouse_stock(new.item_id, new.warehouse_id, v_new_qty);
    end if;
  elsif new.item_id is not null and v_new_qty <> v_old_qty then
    perform public.adjust_warehouse_stock(new.item_id, new.warehouse_id, v_new_qty - v_old_qty);
  end if;

  if v_new_cost <> v_old_cost then
    update public.suppliers
       set balance_due = balance_due + (v_new_cost - v_old_cost)
     where id = new.supplier_id;
  end if;

  return null;
end $$;

create or replace function public.on_purchase_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.deleted_at is not null then
    return old;
  end if;

  if old.item_id is not null then
    perform public.adjust_warehouse_stock(old.item_id, old.warehouse_id, -coalesce(old.quantity, 0));
  end if;

  update public.suppliers
     set balance_due = balance_due - coalesce(old.total_cost, 0)
   where id = old.supplier_id;

  return old;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Sale trigger (002/022) — rewired onto adjust_warehouse_stock. Made-to-
-- order items still skip stock entirely, exactly as before.
-- ---------------------------------------------------------------------------
create or replace function public.on_sale_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare buyer_bal numeric(14,2) := 0; item_name text; v_mto boolean;
begin
  select name, made_to_order into item_name, v_mto from public.items where id = new.item_id;
  if not v_mto then
    perform public.adjust_warehouse_stock(new.item_id, new.warehouse_id, -new.quantity);
  end if;

  if new.payment_type = 'udhaar' then
    update public.profiles
       set balance_due = balance_due + new.amount
     where id = new.buyer_id
     returning balance_due into buyer_bal;
  else
    select balance_due into buyer_bal from public.profiles where id = new.buyer_id;
  end if;

  insert into public.ledger (shop_id, entry_type, party_id, party_type,
                             reference_id, reference_table, debit, credit,
                             running_balance, description)
  values (new.shop_id, 'sale', new.buyer_id, new.buyer_type,
          new.id, 'sales', 0, new.amount,
          coalesce(buyer_bal,0), 'Sale: ' || coalesce(item_name,'item'));

  update public.orders set status = 'approved' where id = new.order_id;

  insert into public.fulfilment (shop_id, order_id, sale_id, status)
  values (new.shop_id, new.order_id, new.id, 'pending_pack');
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 5. approve_order() — adds p_warehouse_id, checks that SPECIFIC warehouse
-- (not the item's total) has enough stock before booking the sale. Signature
-- grows by one arg at the end, so the old grant is dropped and reissued.
-- ---------------------------------------------------------------------------
drop function if exists public.approve_order(uuid, text, numeric, numeric, numeric, numeric, numeric, text);

create or replace function public.approve_order(
  p_order_id     uuid,
  p_payment_type text,
  p_cost         numeric default null,
  p_discount     numeric default 0,
  p_shipping     numeric default 0,
  p_packing      numeric default 0,
  p_other        numeric default 0,
  p_notes        text    default null,
  p_warehouse_id uuid    default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_shop      uuid;
  v_role      text;
  v_ord       public.orders%rowtype;
  v_item      public.items%rowtype;
  v_cost      numeric(14,2);
  v_profit    numeric(14,2);
  v_sale_id   uuid;
  v_discount  numeric(14,2) := round(greatest(coalesce(p_discount, 0), 0), 2);
  v_shipping  numeric(14,2) := round(greatest(coalesce(p_shipping, 0), 0), 2);
  v_packing   numeric(14,2) := round(greatest(coalesce(p_packing,  0), 0), 2);
  v_other     numeric(14,2) := round(greatest(coalesce(p_other,    0), 0), 2);
  v_net       numeric(14,2);
  v_grand     numeric(14,2);
  v_bal       numeric(14,2);
  v_item_name text;
  v_wh_qty    numeric(14,2);
  v_wh_name   text;
begin
  select shop_id, role into v_shop, v_role
    from public.profiles where id = auth.uid();
  if v_role <> 'owner' then
    raise exception 'Only the owner can approve a shopfront order';
  end if;
  if p_payment_type not in ('cash','upi','udhaar') then
    raise exception 'Invalid payment type: %', p_payment_type;
  end if;

  select * into v_ord from public.orders
    where id = p_order_id and shop_id = v_shop;
  if not found then raise exception 'Order not found in this shop'; end if;
  if v_ord.status <> 'pending' then
    raise exception 'Order is not pending (status: %)', v_ord.status;
  end if;

  select * into v_item from public.items where id = v_ord.item_id;
  if not found then raise exception 'Item not found'; end if;

  if v_item.made_to_order then
    v_cost := round(coalesce(p_cost, 0), 2);
    if v_cost <= 0 then
      raise exception 'Enter a valid cost for this made-to-order item';
    end if;
  else
    v_cost := round(coalesce(v_item.purchase_rate, 0), 2);
    if p_warehouse_id is null then
      raise exception 'Choose which warehouse this sale comes from.';
    end if;
    select quantity, name into v_wh_qty, v_wh_name
      from public.warehouse_stock join public.warehouses on warehouses.id = warehouse_stock.warehouse_id
      where item_id = v_item.id and warehouse_id = p_warehouse_id;
    if coalesce(v_wh_qty, 0) < v_ord.quantity then
      raise exception 'Not enough stock in %: % available, % ordered',
        coalesce(v_wh_name, 'that warehouse'), coalesce(v_wh_qty, 0), v_ord.quantity;
    end if;
  end if;

  if v_discount > v_ord.amount then
    raise exception 'Discount (%) cannot exceed the order amount (%)',
      v_discount, v_ord.amount;
  end if;

  v_profit := round((v_ord.rate_at_order - v_cost) * v_ord.quantity - v_discount, 2);

  insert into public.sales (shop_id, order_id, item_id, category_id, buyer_id,
                            buyer_type, quantity, rate_charged, amount,
                            purchase_rate, profit, payment_type, approved_by,
                            source, warehouse_id)
  values (v_shop, v_ord.id, v_ord.item_id, v_item.category_id, v_ord.buyer_id,
          v_ord.buyer_type, v_ord.quantity, v_ord.rate_at_order, v_ord.amount,
          v_cost, v_profit, p_payment_type, auth.uid(), 'shopfront', p_warehouse_id)
  returning id into v_sale_id;

  v_net   := round(v_shipping + v_packing + v_other - v_discount, 2);
  v_grand := round(v_ord.amount + v_net, 2);

  if v_net <> 0 then
    if p_payment_type = 'udhaar' then
      update public.profiles set balance_due = balance_due + v_net
       where id = v_ord.buyer_id
       returning balance_due into v_bal;
    else
      select balance_due into v_bal from public.profiles where id = v_ord.buyer_id;
    end if;

    v_item_name := coalesce(v_item.name, 'item');
    insert into public.ledger (shop_id, entry_type, party_id, party_type,
                               reference_id, reference_table, debit, credit,
                               running_balance, description)
    values (v_shop, 'sale', v_ord.buyer_id, v_ord.buyer_type,
            v_sale_id, 'sales',
            case when v_net < 0 then -v_net else 0 end,
            case when v_net > 0 then  v_net else 0 end,
            coalesce(v_bal, 0),
            'Bill adjustment (' || v_item_name || '): ' ||
              trim(both ', ' from concat_ws(', ',
                case when v_shipping > 0 then 'shipping ' || v_shipping else null end,
                case when v_packing  > 0 then 'packing '  || v_packing  else null end,
                case when v_other    > 0 then 'other '    || v_other    else null end,
                case when v_discount > 0 then 'less discount ' || v_discount else null end)));
  end if;

  insert into public.order_bills (shop_id, order_id, sale_id, order_group_id,
                                  subtotal, discount_amount, shipping_fee,
                                  packing_fee, other_charge, grand_total, notes)
  values (v_shop, v_ord.id, v_sale_id, v_ord.order_group_id,
          v_ord.amount, v_discount, v_shipping, v_packing, v_other,
          v_grand, p_notes);

  return v_sale_id;
end $$;

grant execute on function
  public.approve_order(uuid, text, numeric, numeric, numeric, numeric, numeric, text, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 6. warehouse_stock RLS — owner may now write directly (Inventory's
-- per-warehouse correction screen), not just read. Staff stays read-only.
-- ---------------------------------------------------------------------------
drop policy if exists warehouse_stock_owner_select on public.warehouse_stock;

create policy warehouse_stock_owner_all on public.warehouse_stock for all
  using (
    exists (select 1 from public.warehouses w where w.id = warehouse_id and w.shop_id = auth_shop_id())
    and auth_role() = 'owner'
  )
  with check (
    exists (select 1 from public.warehouses w where w.id = warehouse_id and w.shop_id = auth_shop_id())
    and auth_role() = 'owner'
  );

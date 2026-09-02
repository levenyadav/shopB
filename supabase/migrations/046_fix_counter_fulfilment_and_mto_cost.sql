-- =============================================================================
-- 046_fix_counter_fulfilment_and_mto_cost.sql — repair two regressions caused by
-- earlier full-body `create or replace function` copies that dropped changes
-- made by an intervening migration.
--
-- BUG 1 — Counter sales land in the staff pack queue.
--   014 gave on_sale_insert an `is_counter` branch: a POS/counter sale marks its
--   order 'picked_up' and writes an ALREADY-COMPLETED fulfilment row (goods are
--   handed over at the counter — nothing to pack). 022 (made-to-order) rebuilt
--   the function from the 002 base and lost that branch; 043 (warehouse wiring)
--   rebuilt it again and still didn't have it. Net effect on the live DB: every
--   counter bill inserts a `pending_pack` fulfilment row that shows up on the
--   staff "Waiting to pack" board (fulfilment_queue does not filter by source),
--   so staff must manually pack + hand-over every walk-in sale. SPEC §6.5a/§7.8
--   say counter sales skip the pack queue.
--
-- BUG 2 — Made-to-order shopfront orders can't be approved.
--   030 made approve_order take the cost from items.purchase_rate for BOTH stock
--   and made-to-order items (the owner enters it up front in Purchase Entry /
--   Inventory; the approval screen no longer asks). 038 ("restore to 023")
--   copy-pasted the older body back, reintroducing the `p_cost <= 0 -> raise
--   'Enter a valid cost for this made-to-order item'` check; 043 kept it. The
--   frontend (OrderDetail.jsx) was already on the 030 design — it never sends
--   p_cost and shows "Cost taken from the item's purchase rate" — so approving
--   any made-to-order order now fails outright with that exception.
--
-- This migration re-applies both fixes on top of the current (043) function
-- bodies. Signatures are unchanged, so grants and the frontend are unaffected.
-- Golden Rules #2/#4/#6/#9/#10 all hold: stock/ledger still move only through
-- triggers, cost stays internal, profit is still (rate - cost) x qty, the ledger
-- is still append-only and trigger-written.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. on_sale_insert — 043 body (warehouse-aware + made-to-order stock skip)
--    with the 014 counter branch restored.
-- ---------------------------------------------------------------------------
create or replace function public.on_sale_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  buyer_bal  numeric(14,2) := 0;
  item_name  text;
  v_mto      boolean;
  is_counter boolean := (new.source = 'counter');
begin
  select name, made_to_order into item_name, v_mto
    from public.items where id = new.item_id;

  -- Made-to-order carries no stock; everything else draws from its warehouse
  -- (NULL warehouse -> Main Warehouse, and a negative result raises — 043).
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
          coalesce(buyer_bal, 0),
          case when is_counter then 'Counter sale: ' else 'Sale: ' end
            || coalesce(item_name, 'item'));

  -- Counter: goods handed over now -> order 'picked_up'. Shopfront: 'approved',
  -- awaiting the pack step.
  update public.orders
     set status = case when is_counter then 'picked_up' else 'approved' end
   where id = new.order_id;

  -- Counter: fulfilment row is created already COMPLETED (skips the pack queue),
  -- stamped to the person who rang the bill. Shopfront: opens as 'pending_pack'.
  insert into public.fulfilment (shop_id, order_id, sale_id, status,
                                 packed_by, packed_at, completed_by, completed_at)
  values (new.shop_id, new.order_id, new.id,
          case when is_counter then 'picked_up'     else 'pending_pack' end,
          case when is_counter then new.approved_by else null end,
          case when is_counter then now()           else null end,
          case when is_counter then new.approved_by else null end,
          case when is_counter then now()           else null end);

  return new;
end $$;
-- trg_sale_insert (002) already binds on_sale_insert(); redefining is enough.

-- ---------------------------------------------------------------------------
-- 2. approve_order — 043 body with the made-to-order cost source restored to
--    items.purchase_rate (migration 030). Signature is byte-for-byte the 043
--    signature; p_cost is accepted for backward compatibility but IGNORED.
-- ---------------------------------------------------------------------------
create or replace function public.approve_order(
  p_order_id     uuid,
  p_payment_type text,
  p_cost         numeric default null,   -- DEPRECATED / ignored: cost comes from items.purchase_rate
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

  -- Cost comes from the item's known purchase rate for BOTH stock and
  -- made-to-order items (migration 030 — the owner enters it in Purchase Entry /
  -- Inventory, not on this screen). 038/043 had reverted this by copy-paste and
  -- demanded p_cost for made-to-order, which the frontend no longer sends.
  v_cost := round(coalesce(v_item.purchase_rate, 0), 2);

  if v_item.made_to_order then
    if v_cost <= 0 then
      raise exception 'This made-to-order item has no purchase rate set. Set its cost in Inventory / Purchase Entry, then approve.';
    end if;
  else
    if p_warehouse_id is null then
      raise exception 'Choose which warehouse this sale comes from.';
    end if;
    select quantity, name into v_wh_qty, v_wh_name
      from public.warehouse_stock
      join public.warehouses on warehouses.id = warehouse_stock.warehouse_id
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

  -- Product profit at list, less the bill discount (the discount is a margin loss).
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
-- 3. One-time cleanup: counter sales booked while the branch was missing left a
--    'pending_pack' (or 'packed') fulfilment row and an 'approved' order. Close
--    them so the staff board isn't showing walk-ins that were handed over long
--    ago. Only touches source='counter' rows that were never actually delivered.
-- ---------------------------------------------------------------------------
update public.fulfilment f
   set status       = 'picked_up',
       packed_by    = coalesce(f.packed_by, s.approved_by),
       packed_at    = coalesce(f.packed_at, s.created_at),
       completed_by = coalesce(f.completed_by, s.approved_by),
       completed_at = coalesce(f.completed_at, s.created_at)
  from public.sales s
 where s.id = f.sale_id
   and s.source = 'counter'
   and f.status in ('pending_pack', 'packed');

update public.orders o
   set status = 'picked_up'
  from public.sales s
 where s.order_id = o.id
   and s.source = 'counter'
   and o.status in ('approved', 'packed');

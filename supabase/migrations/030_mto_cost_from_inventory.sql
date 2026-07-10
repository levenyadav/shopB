-- =============================================================================
-- 030_mto_cost_from_inventory.sql — Made-to-Order cost now comes from inventory.
--
-- Previously (022/023) a made-to-order item held no cost: items.purchase_rate was
-- a 0 placeholder and the owner typed the "true cost per piece" on the approval
-- screen. That was one more thing to remember at the worst moment (the buyer is
-- waiting) and left the catalogue row showing no cost.
--
-- New rule: a made-to-order item carries a REAL purchase_rate, entered up front in
-- Purchase Entry / Inventory just like a stock item. At approval we read the cost
-- straight from items.purchase_rate for BOTH kinds — no cost prompt. The only
-- thing still special about made-to-order is that stock is never checked or
-- decremented (unchanged, handled in on_sale_insert from 022).
--
-- Golden Rules #4, #6, #9, #10 all still hold: purchase_rate stays internal-only,
-- profit is still (rate_charged − purchase_rate) × qty, the ledger is still
-- trigger-written, and the client still just calls this RPC.
--
-- p_cost is kept in the signature for backward compatibility but is now IGNORED —
-- the cost always comes from the item. Additive & idempotent (create or replace).
-- =============================================================================

create or replace function public.approve_order(
  p_order_id     uuid,
  p_payment_type text,
  p_cost         numeric default null,   -- DEPRECATED / ignored: cost comes from items.purchase_rate
  p_discount     numeric default 0,
  p_shipping     numeric default 0,
  p_packing      numeric default 0,
  p_other        numeric default 0,
  p_notes        text    default null
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
  -- made-to-order items (the owner now enters it in Purchase Entry, not here).
  -- Made-to-order simply skips the stock check; on_sale_insert (022) keeps its
  -- quantity untouched.
  v_cost := round(coalesce(v_item.purchase_rate, 0), 2);
  if v_item.made_to_order then
    if v_cost <= 0 then
      raise exception 'This made-to-order item has no purchase rate set. Set its cost in Inventory / Purchase Entry, then approve.';
    end if;
  else
    if v_item.quantity < v_ord.quantity then
      raise exception 'Not enough stock: % available, % ordered',
        v_item.quantity, v_ord.quantity;
    end if;
  end if;

  if v_discount > v_ord.amount then
    raise exception 'Discount (%) cannot exceed the order amount (%)',
      v_discount, v_ord.amount;
  end if;

  -- Product profit at list, less the bill discount (the discount is a margin loss).
  v_profit := round((v_ord.rate_at_order - v_cost) * v_ord.quantity - v_discount, 2);

  -- a. Insert the Sale GROSS. on_sale_insert (014) drops stock, books the gross
  --    product udhaar + ledger, sets the order to 'approved', opens fulfilment.
  insert into public.sales (shop_id, order_id, item_id, category_id, buyer_id,
                            buyer_type, quantity, rate_charged, amount,
                            purchase_rate, profit, payment_type, approved_by,
                            source)
  values (v_shop, v_ord.id, v_ord.item_id, v_item.category_id, v_ord.buyer_id,
          v_ord.buyer_type, v_ord.quantity, v_ord.rate_at_order, v_ord.amount,
          v_cost, v_profit, p_payment_type, auth.uid(), 'shopfront')
  returning id into v_sale_id;

  -- b. Net non-product money the buyer additionally owes for this bill.
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
            case when v_net < 0 then -v_net else 0 end,   -- net discount -> debit (less dues)
            case when v_net > 0 then  v_net else 0 end,   -- net charges  -> credit (more dues)
            coalesce(v_bal, 0),
            'Bill adjustment (' || v_item_name || '): ' ||
              trim(both ', ' from concat_ws(', ',
                case when v_shipping > 0 then 'shipping ' || v_shipping else null end,
                case when v_packing  > 0 then 'packing '  || v_packing  else null end,
                case when v_other    > 0 then 'other '    || v_other    else null end,
                case when v_discount > 0 then 'less discount ' || v_discount else null end)));
  end if;

  -- c. Persist the breakdown for the invoice.
  insert into public.order_bills (shop_id, order_id, sale_id, order_group_id,
                                  subtotal, discount_amount, shipping_fee,
                                  packing_fee, other_charge, grand_total, notes)
  values (v_shop, v_ord.id, v_sale_id, v_ord.order_group_id,
          v_ord.amount, v_discount, v_shipping, v_packing, v_other,
          v_grand, p_notes);

  return v_sale_id;
end $$;

grant execute on function
  public.approve_order(uuid, text, numeric, numeric, numeric, numeric, numeric, text)
  to authenticated;

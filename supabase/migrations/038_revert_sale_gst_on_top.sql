-- =============================================================================
-- 038_revert_sale_gst_on_top.sql — undo 037; a selling rate INCLUDES its GST.
--
-- 037 changed the shop to charge GST on top of the selling rate. The merchant
-- does not bill that way: the rate the buyer sees is the final price and the GST
-- is already inside it. 037 was applied to the live database, so reverting the
-- application code is not enough — approve_order() and create_counter_sale()
-- would keep adding tax to grand_total and to the buyer's balance. This restores
-- both to their pre-037 behaviour (023 and 014 respectively).
--
-- WHAT THE MODEL IS AGAIN. A sale amount is LOCKED and is what the buyer pays
-- (Golden Rule #5), so it is tax-INCLUSIVE. The invoice backs CGST + SGST out of
-- it for display and the grand total still equals the sale amount. Nothing is
-- ever added on top.
--
-- COLUMNS ARE KEPT, NOT DROPPED. order_bills.taxable_value / cgst_amount /
-- sgst_amount / gst_rate stay in place and simply go back to 0. Dropping them
-- would destroy the figures on any bill raised in the window while 037 was live,
-- and this is a money table — losing a row's history to tidy a schema is the
-- wrong trade. They are marked deprecated below so nobody reads them as current.
--
-- IF ANY BILL WAS RAISED WHILE 037 WAS LIVE it carries real tax in those columns
-- and an inflated grand_total, and an udhaar bill moved balance_due by that tax.
-- This migration does NOT rewrite them: the ledger is append-only (Golden Rule
-- #9) and a sale already issued to a buyer is not silently restated. The query at
-- the bottom lists any such bills so they can be corrected deliberately, by hand.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The 037 tax columns are dead weight from here on — always 0.
-- ---------------------------------------------------------------------------
comment on column public.order_bills.cgst_amount is
  'DEPRECATED (038). Selling rates are tax-INCLUSIVE again, so this is always 0. Kept only to preserve bills raised while 037 was briefly live.';
comment on column public.order_bills.sgst_amount is
  'DEPRECATED (038). Always 0 — see cgst_amount.';
comment on column public.order_bills.taxable_value is
  'DEPRECATED (038). Always 0 — the invoice backs the taxable value out of the inclusive amount instead.';
comment on column public.order_bills.gst_rate is
  'DEPRECATED (038). Always NULL — the slab comes from items.gst_rate (034) at print time.';

-- The buyer-safe view goes back to the 023 column list. Dropped and rebuilt
-- because CREATE OR REPLACE VIEW cannot remove columns; the grant is re-issued
-- because DROP takes it along.
drop view if exists public.customer_bills;
create view public.customer_bills
with (security_invoker = false) as
select
  b.order_id, b.sale_id, b.subtotal, b.discount_amount, b.shipping_fee,
  b.packing_fee, b.other_charge, b.grand_total, b.notes, b.created_at
from public.order_bills b
join public.orders o on o.id = b.order_id
where o.buyer_id = auth.uid();
grant select on public.customer_bills to authenticated;

-- ---------------------------------------------------------------------------
-- 2. approve_order() — restored to 023. Identical signature; the only change
--    from the 037 version is that no tax is computed, added to v_net, or
--    written to order_bills.
-- ---------------------------------------------------------------------------
create or replace function public.approve_order(
  p_order_id     uuid,
  p_payment_type text,
  p_cost         numeric default null,   -- per-piece cost; required for made-to-order
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

  -- Cost: made-to-order is entered at approval; a stock item uses its known cost.
  if v_item.made_to_order then
    v_cost := round(coalesce(p_cost, 0), 2);
    if v_cost <= 0 then
      raise exception 'Enter a valid cost for this made-to-order item';
    end if;
  else
    v_cost := round(coalesce(v_item.purchase_rate, 0), 2);
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

  -- b. Net non-product money the buyer additionally owes for this bill. No tax
  --    term: the GST is already inside v_ord.amount, booked with the goods.
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

  -- c. Persist the breakdown for the invoice. The 037 tax columns keep their
  --    zero defaults and are not written.
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

-- ---------------------------------------------------------------------------
-- 3. create_counter_sale() — restored to 014. A counter bill is the goods and
--    nothing else again: no order_bills row, no tax, no extra ledger entry.
--    on_sale_insert books the whole (inclusive) amount, exactly as before 037.
-- ---------------------------------------------------------------------------
create or replace function public.create_counter_sale(
  p_buyer_id     uuid,
  p_buyer_type   text,
  p_payment_type text,
  p_lines        jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_shop  uuid;
  v_role  text;
  v_bill  uuid := gen_random_uuid();
  v_line  jsonb;
  v_order uuid;
  v_qty   numeric(14,2);
  v_rate  numeric(14,2);
  v_amount numeric(14,2);
begin
  select shop_id, role into v_shop, v_role
    from public.profiles where id = auth.uid();

  if v_role not in ('owner','staff') then
    raise exception 'Only owner or staff can create a counter sale';
  end if;
  if p_payment_type not in ('cash','upi','udhaar') then
    raise exception 'Invalid payment type: %', p_payment_type;
  end if;
  if p_buyer_type not in ('customer','dealer') then
    raise exception 'Invalid buyer type: %', p_buyer_type;
  end if;
  if jsonb_array_length(coalesce(p_lines,'[]'::jsonb)) = 0 then
    raise exception 'Cannot bill an empty cart';
  end if;

  -- buyer must belong to this shop and be a customer/dealer
  perform 1 from public.profiles
    where id = p_buyer_id and shop_id = v_shop and role in ('customer','dealer');
  if not found then
    raise exception 'Buyer not found in this shop';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty    := (v_line->>'quantity')::numeric;
    v_rate   := (v_line->>'rate')::numeric;
    v_amount := round(v_qty * v_rate, 2);
    if v_qty <= 0 then raise exception 'Line quantity must be positive'; end if;

    insert into public.orders (shop_id, item_id, buyer_id, buyer_type, quantity,
                               rate_at_order, amount, status, source, bill_id)
    values (v_shop, (v_line->>'item_id')::uuid, p_buyer_id, p_buyer_type,
            v_qty, v_rate, v_amount, 'pending', 'counter', v_bill)
    returning id into v_order;

    -- purchase_rate + profit are filled by fill_counter_sale_cost (trigger);
    -- on_sale_insert then drops stock, books udhaar/ledger, flips the order to
    -- picked_up and writes a completed fulfilment row.
    insert into public.sales (shop_id, order_id, item_id, category_id, buyer_id,
                              buyer_type, quantity, rate_charged, amount,
                              purchase_rate, profit, payment_type, approved_by,
                              source, bill_id)
    values (v_shop, v_order, (v_line->>'item_id')::uuid, (v_line->>'category_id')::uuid,
            p_buyer_id, p_buyer_type, v_qty, v_rate, v_amount,
            0, 0, p_payment_type, auth.uid(), 'counter', v_bill);
  end loop;

  return v_bill;
end $$;

grant execute on function public.create_counter_sale(uuid,text,text,jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. sale_gst_rate() existed only to feed the on-top calculation. Nothing reads
--    it now; the slab is resolved at print time from items.gst_rate (034).
-- ---------------------------------------------------------------------------
drop function if exists public.sale_gst_rate(uuid, uuid);

-- ---------------------------------------------------------------------------
-- 5. Anything billed while 037 was live. Run this by hand; it should return no
--    rows. Each row it DOES return over-charged the buyer by (cgst + sgst) and,
--    if the bill was udhaar, moved balance_due by that much too.
--
--   select b.order_id, b.sale_id, b.subtotal, b.cgst_amount, b.sgst_amount,
--          b.grand_total, s.payment_type, s.buyer_id, b.created_at
--     from public.order_bills b
--     join public.sales s on s.id = b.sale_id
--    where b.cgst_amount + b.sgst_amount > 0
--    order by b.created_at;
-- ---------------------------------------------------------------------------

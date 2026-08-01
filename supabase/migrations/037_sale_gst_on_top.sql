-- =============================================================================
-- 037_sale_gst_on_top.sql — GST is charged ON TOP of the selling rate.
--
-- WHAT CHANGED AND WHY
-- Until now a selling rate was tax-INCLUSIVE: ₹18 was taken to already contain
-- the GST, so the tax was backed out of the locked amount and the buyer's total
-- never moved. The shop bills the other way round — the rate is the pre-tax
-- price and GST is added over it, exactly as a supplier's bill does (036):
--
--     goods (qty × rate)
--   − discount
--   + shipping + packing + other
--   + CGST + SGST            ← new
--   = grand_total  (what the buyer owes)
--
-- This makes the two sides of the books symmetrical: 036 already books purchase
-- tax on top of goods, and this does the same for sales.
--
-- IT ALSO FIXES PROFIT. Golden Rule #6 is profit = (rate − purchase_rate) × qty.
-- purchase_rate is the PRE-TAX goods cost (036), so while `rate` was tax-
-- inclusive, every sale counted the GST collected for the government as margin.
-- With the rate pre-tax, both sides of that subtraction are pre-tax and the
-- profit figure is honest. Profit is deliberately NOT changed to subtract tax —
-- there is no tax left in `rate` to subtract.
--
-- WHAT IS NOT TAXED. Shipping, packing and other charges stay pass-through and
-- carry no GST, which is what the invoice has always printed and what 036 does
-- for postage. A discount DOES reduce the taxable value — it is a genuine
-- reduction in the price of the goods, so tax is charged on the net.
--
-- GOLDEN RULES. #5 still holds and gets sharper: `rate_at_order` and
-- `sales.amount` remain the locked GOODS money and are untouched here — no
-- existing sale is rewritten, so past books stay exactly as they were recorded.
-- #9/#10 hold: the extra tax reaches balance_due and the ledger through the same
-- RPC that already books shipping/packing/other, never through client code.
--
-- EXISTING ROWS. order_bills rows written before this migration get 0 tax and
-- keep their stored grand_total, so an old invoice reprints exactly as issued.
-- Nothing is back-charged.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. order_bills — carry the tax the buyer was charged on this bill.
--    Amounts, not rates: a bill can mix a 12% card with an 18% box, so the pair
--    is the summed money. gst_rate holds the single slab when every line shares
--    one (the common case) and NULL when they differ — the invoice re-derives
--    the per-slab table from the lines either way.
-- ---------------------------------------------------------------------------
alter table public.order_bills
  add column if not exists cgst_amount numeric(14,2) not null default 0,
  add column if not exists sgst_amount numeric(14,2) not null default 0,
  add column if not exists taxable_value numeric(14,2) not null default 0,
  add column if not exists gst_rate numeric(5,2);

alter table public.order_bills
  drop constraint if exists order_bills_tax_nonneg;
alter table public.order_bills
  add constraint order_bills_tax_nonneg
  check (cgst_amount >= 0 and sgst_amount >= 0 and taxable_value >= 0);

comment on column public.order_bills.cgst_amount is
  'CGST charged ON TOP of the goods on this bill (037). Half of the tax; SGST is the other half. Intra-state only.';
comment on column public.order_bills.taxable_value is
  'Goods value the tax was charged on = subtotal − discount. Charges are pass-through and untaxed.';
comment on column public.order_bills.gst_rate is
  'The single GST slab when every line on this bill shares one; NULL when the bill mixes slabs.';

-- Buyer-safe view gains the tax columns so a buyer can see what they were
-- charged. Still no cost/profit anywhere in here.
create or replace view public.customer_bills
with (security_invoker = false) as
select
  b.order_id, b.sale_id, b.subtotal, b.discount_amount, b.shipping_fee,
  b.packing_fee, b.other_charge, b.taxable_value, b.cgst_amount, b.sgst_amount,
  b.gst_rate, b.grand_total, b.notes, b.created_at
from public.order_bills b
join public.orders o on o.id = b.order_id
where o.buyer_id = auth.uid();
grant select on public.customer_bills to authenticated;

-- ---------------------------------------------------------------------------
-- 2. sale_gst() — the one place that answers "what tax is charged on this?".
--    Resolves the slab the same way the frontend does (034): the product's own
--    gst_rate when it has one, else the shop default; an explicit 0 means the
--    product is exempt and stays exempt. Both RPCs below call this, so counter
--    and shopfront can never drift apart.
-- ---------------------------------------------------------------------------
create or replace function public.sale_gst_rate(p_item_id uuid, p_shop_id uuid)
returns numeric
language sql stable security definer set search_path = public as $$
  select greatest(coalesce(
    (select i.gst_rate from public.items i where i.id = p_item_id),
    (select s.gst_rate from public.shops s where s.id = p_shop_id),
    0), 0);
$$;

comment on function public.sale_gst_rate(uuid, uuid) is
  'GST slab (%) to charge on a sale of this item: the product''s own rate, else the shop default, else 0 (037).';

-- ---------------------------------------------------------------------------
-- 3. approve_order() — unchanged except that the tax now rides along with the
--    other non-product money. Signature is identical, so the frontend call site
--    does not change; the tax is computed server-side from the product's slab
--    and is not something the owner types or can fudge.
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
  v_rate_pct  numeric(5,2);
  v_taxable   numeric(14,2);
  v_tax       numeric(14,2);
  v_cgst      numeric(14,2);
  v_sgst      numeric(14,2);
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

  -- Product profit at list, less the bill discount (the discount is a margin
  -- loss). Both sides are pre-tax now, so this is the true margin.
  v_profit := round((v_ord.rate_at_order - v_cost) * v_ord.quantity - v_discount, 2);

  -- a. Insert the Sale GROSS GOODS. on_sale_insert (014) drops stock, books the
  --    goods udhaar + ledger, sets the order to 'approved', opens fulfilment.
  insert into public.sales (shop_id, order_id, item_id, category_id, buyer_id,
                            buyer_type, quantity, rate_charged, amount,
                            purchase_rate, profit, payment_type, approved_by,
                            source)
  values (v_shop, v_ord.id, v_ord.item_id, v_item.category_id, v_ord.buyer_id,
          v_ord.buyer_type, v_ord.quantity, v_ord.rate_at_order, v_ord.amount,
          v_cost, v_profit, p_payment_type, auth.uid(), 'shopfront')
  returning id into v_sale_id;

  -- b. GST on the goods net of discount. Charges are pass-through and untaxed.
  v_rate_pct := public.sale_gst_rate(v_ord.item_id, v_shop);
  v_taxable  := round(v_ord.amount - v_discount, 2);
  v_tax      := round(v_taxable * v_rate_pct / 100, 2);
  v_cgst     := round(v_tax / 2, 2);
  v_sgst     := round(v_tax - v_cgst, 2);   -- remainder, so the pair always sums

  -- c. Net non-product money the buyer additionally owes for this bill.
  v_net   := round(v_shipping + v_packing + v_other - v_discount + v_tax, 2);
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
                case when v_tax      > 0 then 'GST ' || v_tax else null end,
                case when v_shipping > 0 then 'shipping ' || v_shipping else null end,
                case when v_packing  > 0 then 'packing '  || v_packing  else null end,
                case when v_other    > 0 then 'other '    || v_other    else null end,
                case when v_discount > 0 then 'less discount ' || v_discount else null end)));
  end if;

  -- d. Persist the breakdown for the invoice.
  insert into public.order_bills (shop_id, order_id, sale_id, order_group_id,
                                  subtotal, discount_amount, shipping_fee,
                                  packing_fee, other_charge, taxable_value,
                                  cgst_amount, sgst_amount, gst_rate,
                                  grand_total, notes)
  values (v_shop, v_ord.id, v_sale_id, v_ord.order_group_id,
          v_ord.amount, v_discount, v_shipping, v_packing, v_other,
          v_taxable, v_cgst, v_sgst, nullif(v_rate_pct, 0),
          v_grand, p_notes);

  return v_sale_id;
end $$;

grant execute on function
  public.approve_order(uuid, text, numeric, numeric, numeric, numeric, numeric, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4. create_counter_sale() — a walk-in bill is taxed the same way, or the two
--    counters would disagree about the price of the same product. Each line
--    gets its own order_bills row (there are no discounts or charges at the
--    counter, so subtotal + tax is the whole bill), and the tax is booked to
--    the buyer's balance + ledger only when the bill is udhaar, mirroring how
--    on_sale_insert books the goods.
--
--    Staff may call this. The tax comes from sale_gst_rate() server-side, so a
--    staff member still never reads or influences anything cost-related.
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
  v_sale  uuid;
  v_item  uuid;
  v_qty   numeric(14,2);
  v_rate  numeric(14,2);
  v_amount numeric(14,2);
  v_rate_pct numeric(5,2);
  v_tax   numeric(14,2);
  v_cgst  numeric(14,2);
  v_sgst  numeric(14,2);
  v_bal   numeric(14,2);
  v_name  text;
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
    v_item   := (v_line->>'item_id')::uuid;
    v_amount := round(v_qty * v_rate, 2);
    if v_qty <= 0 then raise exception 'Line quantity must be positive'; end if;

    insert into public.orders (shop_id, item_id, buyer_id, buyer_type, quantity,
                               rate_at_order, amount, status, source, bill_id)
    values (v_shop, v_item, p_buyer_id, p_buyer_type,
            v_qty, v_rate, v_amount, 'pending', 'counter', v_bill)
    returning id into v_order;

    -- purchase_rate + profit are filled by fill_counter_sale_cost (trigger);
    -- on_sale_insert then drops stock, books udhaar/ledger, flips the order to
    -- picked_up and writes a completed fulfilment row.
    insert into public.sales (shop_id, order_id, item_id, category_id, buyer_id,
                              buyer_type, quantity, rate_charged, amount,
                              purchase_rate, profit, payment_type, approved_by,
                              source, bill_id)
    values (v_shop, v_order, v_item, (v_line->>'category_id')::uuid,
            p_buyer_id, p_buyer_type, v_qty, v_rate, v_amount,
            0, 0, p_payment_type, auth.uid(), 'counter', v_bill)
    returning id into v_sale;

    -- GST on top of this line (037).
    v_rate_pct := public.sale_gst_rate(v_item, v_shop);
    v_tax  := round(v_amount * v_rate_pct / 100, 2);
    v_cgst := round(v_tax / 2, 2);
    v_sgst := round(v_tax - v_cgst, 2);

    insert into public.order_bills (shop_id, order_id, sale_id, order_group_id,
                                    subtotal, discount_amount, shipping_fee,
                                    packing_fee, other_charge, taxable_value,
                                    cgst_amount, sgst_amount, gst_rate,
                                    grand_total)
    values (v_shop, v_order, v_sale, null,
            v_amount, 0, 0, 0, 0, v_amount,
            v_cgst, v_sgst, nullif(v_rate_pct, 0),
            round(v_amount + v_tax, 2));

    if v_tax > 0 then
      if p_payment_type = 'udhaar' then
        update public.profiles set balance_due = balance_due + v_tax
         where id = p_buyer_id
         returning balance_due into v_bal;
      else
        select balance_due into v_bal from public.profiles where id = p_buyer_id;
      end if;

      select name into v_name from public.items where id = v_item;
      insert into public.ledger (shop_id, entry_type, party_id, party_type,
                                 reference_id, reference_table, debit, credit,
                                 running_balance, description)
      values (v_shop, 'sale', p_buyer_id, p_buyer_type, v_sale, 'sales',
              0, v_tax, coalesce(v_bal, 0),
              'GST (' || coalesce(v_name, 'item') || '): ' || v_rate_pct || '%');
    end if;
  end loop;

  return v_bill;
end $$;

grant execute on function public.create_counter_sale(uuid,text,text,jsonb) to authenticated;

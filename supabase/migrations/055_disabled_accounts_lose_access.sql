-- 055 — A disabled account loses access immediately, not just at next login.
--
-- Settings → Staff → Disable sets profiles.is_active = false, and phone-otp
-- refuses NEW logins for it. But a session already open keeps refreshing, and
-- every RLS policy asks auth_role() / auth_shop_id(), which ignored is_active —
-- so a removed staff member kept full staff access on their phone. The three
-- RPCs that read the caller's role themselves (approve_order,
-- create_counter_sale, edit_purchase_bill) had the same gap, and two of them let
-- a caller with NO role through: `null <> 'owner'` and `null not in (...)` are
-- null, not true, so the IF never raised.
--
-- Generated from the LIVE function definitions (the repo copies have drifted
-- before), changing only: the caller lookup gains `and is_active`, and the
-- role checks treat a missing role as "not allowed".

create or replace function public.auth_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and is_active
$$;

create or replace function public.auth_shop_id()
returns uuid language sql stable security definer set search_path = public as $$
  select shop_id from public.profiles where id = auth.uid() and is_active
$$;

CREATE OR REPLACE FUNCTION public.approve_order(p_order_id uuid, p_payment_type text, p_cost numeric DEFAULT NULL::numeric, p_discount numeric DEFAULT 0, p_shipping numeric DEFAULT 0, p_packing numeric DEFAULT 0, p_other numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_warehouse_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_available numeric(14,2);
begin
  select shop_id, role into v_shop, v_role
    from public.profiles where id = auth.uid() and is_active;
  if v_role is distinct from 'owner' then
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
  -- made-to-order items (migration 030).
  v_cost := round(coalesce(v_item.purchase_rate, 0), 2);

  if v_item.made_to_order then
    if v_cost <= 0 then
      raise exception 'This made-to-order item has no purchase rate set. Set its cost in Inventory / Purchase Entry, then approve.';
    end if;
  else
    -- 050: the shop must have enough ACROSS its warehouses; which ones they come
    -- from is allocate_stock_out's job. Checked here too (not just in the
    -- trigger) so the owner gets the friendly sentence before anything is
    -- written, exactly as the old per-warehouse check did.
    select coalesce(sum(quantity), 0) into v_available
      from public.warehouse_stock
     where item_id = v_item.id and quantity > 0;
    if v_available < v_ord.quantity then
      raise exception 'Not enough stock of %: % in all warehouses together, % ordered. Add stock via Purchase Entry.',
        coalesce(v_item.name, 'this item'), v_available, v_ord.quantity;
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
end $function$;

CREATE OR REPLACE FUNCTION public.create_counter_sale(p_buyer_id uuid, p_buyer_type text, p_payment_type text, p_lines jsonb, p_discount numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_shop       uuid;
  v_role       text;
  v_bill       uuid := gen_random_uuid();
  v_line       jsonb;
  v_order      uuid;
  v_sale       uuid;
  v_qty        numeric(14,2);
  v_rate       numeric(14,2);
  v_amount     numeric(14,2);
  v_invoice_no text;
  v_discount   numeric(14,2) := round(greatest(coalesce(p_discount, 0), 0), 2);
  v_subtotal   numeric(14,2) := 0;
  v_share      numeric(14,2);
  v_given      numeric(14,2) := 0;   -- discount apportioned so far
  v_bal        numeric(14,2);
  v_orders     uuid[]          := '{}';
  v_sales      uuid[]          := '{}';
  v_amounts    numeric(14,2)[] := '{}';
  i            int;
  n            int;
begin
  select shop_id, role into v_shop, v_role
    from public.profiles where id = auth.uid() and is_active;

  if v_role is null or v_role not in ('owner','staff') then
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

  -- The discount is checked against the whole bill before anything is written,
  -- so a bad number can never leave a half-billed cart behind.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty  := (v_line->>'quantity')::numeric;
    v_rate := (v_line->>'rate')::numeric;
    if v_qty <= 0 then raise exception 'Line quantity must be positive'; end if;
    if v_rate < 0 then raise exception 'Line rate cannot be negative'; end if;
    v_subtotal := round(v_subtotal + round(v_qty * v_rate, 2), 2);
  end loop;

  if v_discount > v_subtotal then
    raise exception 'Discount (%) cannot exceed the bill subtotal (%)',
      v_discount, v_subtotal;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty    := (v_line->>'quantity')::numeric;
    v_rate   := (v_line->>'rate')::numeric;
    v_amount := round(v_qty * v_rate, 2);

    insert into public.orders (shop_id, item_id, buyer_id, buyer_type, quantity,
                               rate_at_order, amount, status, source, bill_id)
    values (v_shop, (v_line->>'item_id')::uuid, p_buyer_id, p_buyer_type,
            v_qty, v_rate, v_amount, 'pending', 'counter', v_bill)
    returning id into v_order;

    -- purchase_rate + profit are filled by fill_counter_sale_cost (trigger);
    -- on_sale_insert then drops stock, books udhaar/ledger, flips the order to
    -- approved and writes a pending_pack fulfilment row (049);
    -- create_invoice_for_sale allocates the shared invoice number on the first
    -- line of the bill.
    insert into public.sales (shop_id, order_id, item_id, category_id, buyer_id,
                              buyer_type, quantity, rate_charged, amount,
                              purchase_rate, profit, payment_type, approved_by,
                              source, bill_id)
    values (v_shop, v_order, (v_line->>'item_id')::uuid, (v_line->>'category_id')::uuid,
            p_buyer_id, p_buyer_type, v_qty, v_rate, v_amount,
            0, 0, p_payment_type, auth.uid(), 'counter', v_bill)
    returning id into v_sale;

    v_orders  := v_orders  || v_order;
    v_sales   := v_sales   || v_sale;
    v_amounts := v_amounts || v_amount;
  end loop;

  -- ---- The discount, if any -------------------------------------------------
  if v_discount > 0 then
    n := array_length(v_sales, 1);
    for i in 1 .. n loop
      -- Proportional share; the last line takes whatever rounding left over so
      -- the shares add up to v_discount exactly.
      if i = n then
        v_share := round(v_discount - v_given, 2);
      else
        v_share := round(v_discount * v_amounts[i] / v_subtotal, 2);
      end if;
      v_given := round(v_given + v_share, 2);

      -- Margin loss (#6). profit was just filled server-side by the trigger.
      update public.sales
         set profit = round(profit - v_share, 2)
       where id = v_sales[i];

      insert into public.order_bills (shop_id, order_id, sale_id, subtotal,
                                      discount_amount, grand_total)
      values (v_shop, v_orders[i], v_sales[i], v_amounts[i],
              v_share, round(v_amounts[i] - v_share, 2));
    end loop;

    -- One ledger entry for the whole bill. A discount reduces what is owed, so
    -- it is a DEBIT; on udhaar the balance moves with it.
    if p_payment_type = 'udhaar' then
      update public.profiles set balance_due = balance_due - v_discount
       where id = p_buyer_id
       returning balance_due into v_bal;
    else
      select balance_due into v_bal from public.profiles where id = p_buyer_id;
    end if;

    insert into public.ledger (shop_id, entry_type, party_id, party_type,
                               reference_id, reference_table, debit, credit,
                               running_balance, description)
    values (v_shop, 'sale', p_buyer_id, p_buyer_type,
            v_sales[1], 'sales', v_discount, 0, coalesce(v_bal, 0),
            'Counter sale discount: less ' || v_discount ||
              ' on ' || n || ' item' || case when n = 1 then '' else 's' end);
  end if;

  -- The invoice row was created within this transaction by the sale trigger.
  select invoice_no into v_invoice_no
    from public.invoices where bill_id = v_bill;

  return jsonb_build_object('bill_id', v_bill, 'invoice_no', v_invoice_no,
                            'discount', v_discount);
end $function$;

CREATE OR REPLACE FUNCTION public.edit_purchase_bill(p_bill_id uuid, p_lines jsonb, p_invoice_no text DEFAULT NULL::text, p_invoice_date date DEFAULT NULL::date, p_postage numeric DEFAULT 0, p_cgst numeric DEFAULT 0, p_sgst numeric DEFAULT 0, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_shop        uuid;
  v_role        text;
  v_bill_shop   uuid;
  v_group       uuid;
  v_supplier    uuid;
  v_old_goods   numeric(14,2);
  v_new_goods   numeric(14,2);
  v_old_charges numeric(14,2);
  v_new_charges numeric(14,2);
  v_delta       numeric(14,2);
  v_bal         numeric(14,2);
  v_first       uuid;
  v_lines       int;
  v_short       text;
  v_bad         text;
  v_invoice     text;
  v_postage     numeric(14,2) := round(coalesce(p_postage, 0), 2);
  v_cgst        numeric(14,2) := round(coalesce(p_cgst, 0), 2);
  v_sgst        numeric(14,2) := round(coalesce(p_sgst, 0), 2);
begin
  select shop_id, role into v_shop, v_role
    from public.profiles where id = auth.uid() and is_active;

  if v_role is distinct from 'owner' then
    raise exception 'Only the owner can edit a purchase bill';
  end if;

  select purchase_group_id, supplier_id, shop_id
    into v_group, v_supplier, v_bill_shop
    from public.purchases where id = p_bill_id;
  if not found then
    raise exception 'That purchase bill no longer exists';
  end if;
  if v_bill_shop is distinct from v_shop then
    raise exception 'That purchase bill belongs to another shop';
  end if;

  if jsonb_typeof(coalesce(p_lines, 'null'::jsonb)) is distinct from 'array'
     or jsonb_array_length(p_lines) = 0 then
    raise exception 'A bill must have at least one product. To take the whole bill off the books, remove its lines one at a time.';
  end if;

  if v_postage < 0 or v_cgst < 0 or v_sgst < 0 then
    raise exception 'Postage and GST cannot be negative';
  end if;

  -- A bill entered before migration 033 has no group. Give it one now so it can
  -- hold several lines and carry postage/GST like any other bill. The ledger
  -- entry it already has points at this row by id, which does not change.
  if v_group is null then
    v_group := gen_random_uuid();
    update public.purchases set purchase_group_id = v_group where id = p_bill_id;
  end if;

  -- ---- validate the submitted lines -------------------------------------
  select string_agg(msg, '; ') into v_bad from (
    select case
             when (l->>'item_id') is null then 'a line has no product'
             when coalesce((l->>'quantity')::numeric, 0) <= 0
               then 'quantity must be more than zero'
             when coalesce((l->>'purchase_rate')::numeric, -1) < 0
               then 'cost rate cannot be negative'
           end as msg
      from jsonb_array_elements(p_lines) l
  ) x where msg is not null;
  if v_bad is not null then
    raise exception 'Check the lines on this bill: %', v_bad;
  end if;

  -- One line, one row. A repeated id would make the UPDATE below ambiguous and
  -- Postgres would refuse it with a message that means nothing to the owner.
  select count(*) into v_lines from (
    select (l->>'id') as id
      from jsonb_array_elements(p_lines) l
     where (l->>'id') is not null
     group by 1 having count(*) > 1
  ) d;
  if v_lines > 0 then
    raise exception 'The same line appears twice on this bill. Reopen it and make the change again.';
  end if;

  -- Every id sent must actually be a live line of THIS bill. Anything else is a
  -- stale screen or a mistake, and silently ignoring it would lose an edit.
  select count(*) into v_lines
    from jsonb_array_elements(p_lines) l
   where (l->>'id') is not null
     and not exists (
       select 1 from public.purchases p
        where p.id = (l->>'id')::uuid
          and p.purchase_group_id = v_group
          and p.deleted_at is null);
  if v_lines > 0 then
    raise exception 'This bill changed while you were editing it. Reopen it and make the change again.';
  end if;

  -- ---- what the bill is worth right now ---------------------------------
  select coalesce(sum(total_cost), 0) into v_old_goods
    from public.purchases
   where purchase_group_id = v_group and deleted_at is null;

  select coalesce(round(postage + cgst_amount + sgst_amount, 2), 0)
    into v_old_charges
    from public.purchase_bills where purchase_group_id = v_group;
  v_old_charges := coalesce(v_old_charges, 0);

  -- ---- refuse before touching anything if stock would go short -----------
  -- Net change per product across the WHOLE edit: lines removed give stock
  -- back, lines added take it, and a changed quantity does both. Checking the
  -- net (rather than line by line) means an edit that only moves quantity
  -- between two lines of the same product is never wrongly refused.
  with want as (
    select (l->>'item_id')::uuid as item_id,
           round((l->>'quantity')::numeric, 2) as quantity
      from jsonb_array_elements(p_lines) l
  ),
  have as (
    select item_id, quantity
      from public.purchases
     where purchase_group_id = v_group and deleted_at is null
  ),
  net as (
    select item_id, sum(q) as d
      from (select item_id,  quantity as q from want
            union all
            select item_id, -quantity     from have) z
     where item_id is not null
     group by item_id
  )
  select string_agg(
           i.name || ' (short by ' || abs(i.quantity + n.d) || ' pcs)', ', ')
    into v_short
    from net n join public.items i on i.id = n.item_id
   where n.d < 0 and i.quantity + n.d < 0;
  if v_short is not null then
    raise exception
      'Not enough stock for this change: %. Those pcs have already been sold, so the bill cannot be cut that far.',
      v_short;
  end if;

  -- ---- apply -------------------------------------------------------------
  perform set_config('app.bill_edit', 'on', true);

  v_invoice := nullif(trim(coalesce(p_invoice_no, '')), '');

  -- Lines taken off the bill. Soft delete: the row stays for audit and keeps
  -- any ledger reference to it valid; the UPDATE trigger unwinds its stock and
  -- its money.
  update public.purchases p
     set deleted_at = now()
   where p.purchase_group_id = v_group
     and p.deleted_at is null
     and not exists (
       select 1 from jsonb_array_elements(p_lines) l
        where (l->>'id') is not null and (l->>'id')::uuid = p.id);

  -- Lines that stayed. invoice_no / invoice_date are carried on every line
  -- (033), so a change to the bill header rewrites all of them.
  update public.purchases p
     set quantity      = w.quantity,
         purchase_rate = w.purchase_rate,
         total_cost    = round(w.quantity * w.purchase_rate, 2),
         notes         = w.notes,
         invoice_no    = v_invoice,
         invoice_date  = p_invoice_date
    from (
      select (l->>'id')::uuid                            as id,
             round((l->>'quantity')::numeric, 2)         as quantity,
             round((l->>'purchase_rate')::numeric, 2)    as purchase_rate,
             nullif(trim(coalesce(l->>'notes', '')), '') as notes
        from jsonb_array_elements(p_lines) l
       where (l->>'id') is not null
    ) w
   where p.id = w.id;

  -- Products added to the bill. One statement, so the 033 statement trigger
  -- sees them together — and stands down anyway, because the flag is set.
  insert into public.purchases (shop_id, item_id, supplier_id, quantity,
                                purchase_rate, total_cost, entered_by, notes,
                                invoice_no, invoice_date, purchase_group_id)
  select v_shop, (l->>'item_id')::uuid, v_supplier,
         round((l->>'quantity')::numeric, 2),
         round((l->>'purchase_rate')::numeric, 2),
         round(round((l->>'quantity')::numeric, 2)
             * round((l->>'purchase_rate')::numeric, 2), 2),
         auth.uid(),
         nullif(trim(coalesce(l->>'notes', '')), ''),
         v_invoice, p_invoice_date, v_group
    from jsonb_array_elements(p_lines) l
   where (l->>'id') is null;

  -- The corrected cost becomes the product's cost. Profit on future sales uses
  -- it; sales already made keep the cost they were booked with.
  update public.items i
     set purchase_rate = w.purchase_rate
    from (
      select distinct on (item_id) item_id, purchase_rate
        from (
          select (l->>'item_id')::uuid                     as item_id,
                 round((l->>'purchase_rate')::numeric, 2)  as purchase_rate,
                 ord
            from jsonb_array_elements(p_lines) with ordinality as t(l, ord)
        ) y
       order by item_id, ord desc
    ) w
   where i.id = w.item_id
     and i.shop_id = v_shop
     and i.purchase_rate is distinct from w.purchase_rate;

  -- ---- postage / GST -----------------------------------------------------
  select coalesce(sum(total_cost), 0) into v_new_goods
    from public.purchases
   where purchase_group_id = v_group and deleted_at is null;

  v_new_charges := round(v_postage + v_cgst + v_sgst, 2);

  -- Written whenever the bill has charges OR already had a row to correct;
  -- a bill that never had any and still has none needs no row at all.
  if v_new_charges > 0 or v_old_charges > 0 then
    insert into public.purchase_bills (shop_id, supplier_id, purchase_group_id,
                                       goods_total, postage, cgst_amount,
                                       sgst_amount, grand_total, notes)
    values (v_shop, v_supplier, v_group, v_new_goods, v_postage, v_cgst, v_sgst,
            round(v_new_goods + v_new_charges, 2),
            nullif(trim(coalesce(p_notes, '')), ''))
    on conflict (purchase_group_id) do update
      set goods_total = excluded.goods_total,
          postage     = excluded.postage,
          cgst_amount = excluded.cgst_amount,
          sgst_amount = excluded.sgst_amount,
          grand_total = excluded.grand_total,
          notes       = excluded.notes;
  end if;

  -- ---- one correction entry for the whole bill ---------------------------
  select count(*) into v_lines
    from public.purchases
   where purchase_group_id = v_group and deleted_at is null;

  select id into v_first
    from public.purchases
   where purchase_group_id = v_group and deleted_at is null
   order by id limit 1;

  v_delta := round((v_new_goods + v_new_charges) - (v_old_goods + v_old_charges), 2);

  if v_delta <> 0 and v_first is not null then
    select balance_due into v_bal from public.suppliers where id = v_supplier;
    insert into public.ledger (shop_id, entry_type, party_id, party_type,
                               reference_id, reference_table, debit, credit,
                               running_balance, description)
    values (v_shop, 'purchase', v_supplier, 'supplier',
            v_first, 'purchases',
            case when v_delta > 0 then v_delta else 0 end,
            case when v_delta < 0 then -v_delta else 0 end,
            coalesce(v_bal, 0),
            'Bill corrected: '
              || case when v_invoice is null then 'bill' else 'Bill ' || v_invoice end
              || ' (' || v_lines || ' item'
              || case when v_lines = 1 then '' else 's' end || ')');
  end if;

  return jsonb_build_object(
    'purchase_group_id', v_group,
    'first_line_id',     v_first,
    'lines',             v_lines,
    'old_total',         round(v_old_goods + v_old_charges, 2),
    'new_total',         round(v_new_goods + v_new_charges, 2),
    'difference',        v_delta
  );
end $function$;

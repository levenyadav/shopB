-- =============================================================================
-- 051_counter_sale_discount.sql — a bill-level DISCOUNT on a counter (POS) sale.
--
-- BACKGROUND. 023 gave shopfront approval a flat-rupee bill discount: the
-- per-piece rate is never edited (Golden Rule #5), the discount prints as its
-- own "Less : Discount" line, and it comes straight out of the recorded profit
-- (#6). create_counter_sale never got it — a walk-in bill was "the goods and
-- nothing else", so the only way to knock money off at the counter was to edit
-- the item's rate in Inventory, which changes the price for everyone.
--
-- THE CHANGE. create_counter_sale takes p_discount (flat rupees, >= 0, never
-- more than the bill subtotal) and books it exactly the way approve_order does:
--
--   * Lines stay GROSS. orders/sales keep rate_at_order x qty, so the invoice
--     lines are unchanged and #5 holds.
--   * The discount is APPORTIONED across the bill's lines in proportion to each
--     line's amount (the last line absorbs the rounding remainder, so the shares
--     always sum to the discount to the paisa). Each line's profit is reduced by
--     its share — cost never leaves the server: the RPC is SECURITY DEFINER and
--     fill_counter_sale_cost has already filled purchase_rate/profit by then, so
--     staff still never read a cost price (#4).
--   * One order_bills row per line carries the breakdown for the invoice, with
--     subtotal = that line's amount. Written ONLY when a discount is actually
--     given, so a plain counter bill behaves byte-for-byte as before.
--   * ONE ledger entry for the whole bill (not one per line — a walk-in bill is
--     rung up as a single act, unlike a shopfront cart approved line by line).
--     It is a DEBIT: it reduces what the buyer owes. On udhaar the buyer's
--     balance_due is decremented by the same amount, so the books reflect the
--     true payable. Written inside this SECURITY DEFINER RPC, the same
--     server-side path 023's approve_order already uses — never from the client
--     (#9/#10).
--
-- Signature changes (a 5th parameter), so we DROP the old 4-arg function first.
-- Both historical return types are dropped by signature: 019 returns jsonb,
-- 038's text says uuid. p_discount carries a DEFAULT of 0, so any caller still
-- sending the old four arguments keeps working unchanged.
-- =============================================================================

drop function if exists public.create_counter_sale(uuid, text, text, jsonb);
drop function if exists public.create_counter_sale(uuid, text, text, jsonb, numeric);

create function public.create_counter_sale(
  p_buyer_id     uuid,
  p_buyer_type   text,
  p_payment_type text,
  p_lines        jsonb,
  p_discount     numeric default 0
) returns jsonb
language plpgsql security definer set search_path = public as $$
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
end $$;

grant execute on function public.create_counter_sale(uuid,text,text,jsonb,numeric)
  to authenticated;

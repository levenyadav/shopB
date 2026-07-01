-- =============================================================================
-- 019_counter_sale_invoice_no.sql — return the invoice number from a counter sale.
--
-- 016 added a gap-free per-shop invoice number, allocated by an AFTER-INSERT
-- trigger on `sales` (create_invoice_for_sale). A counter bill is invoiced ONCE
-- for its shared bill_id, inside the same transaction as create_counter_sale.
--
-- The POS client, however, only got the bill_id back and printed a truncated
-- uuid as the "Bill no". Staff cannot read the `invoices` table (owner-only RLS),
-- so they cannot look the number up afterwards. Fix: have the SECURITY DEFINER
-- RPC read the freshly-allocated number itself (it already runs privileged) and
-- return BOTH values, so the receipt can print the real INV-000x.
--
-- Return type changes uuid -> jsonb { bill_id, invoice_no }, which Postgres won't
-- do via CREATE OR REPLACE, so we DROP and recreate. Body is byte-for-byte the
-- 014 version plus the trailing lookup + jsonb return.
-- =============================================================================

drop function if exists public.create_counter_sale(uuid, text, text, jsonb);

create function public.create_counter_sale(
  p_buyer_id     uuid,
  p_buyer_type   text,
  p_payment_type text,
  p_lines        jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_shop       uuid;
  v_role       text;
  v_bill       uuid := gen_random_uuid();
  v_line       jsonb;
  v_order      uuid;
  v_qty        numeric(14,2);
  v_rate       numeric(14,2);
  v_amount     numeric(14,2);
  v_invoice_no text;
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
    -- picked_up and writes a completed fulfilment row; create_invoice_for_sale
    -- allocates the shared invoice number on the first line of the bill.
    insert into public.sales (shop_id, order_id, item_id, category_id, buyer_id,
                              buyer_type, quantity, rate_charged, amount,
                              purchase_rate, profit, payment_type, approved_by,
                              source, bill_id)
    values (v_shop, v_order, (v_line->>'item_id')::uuid, (v_line->>'category_id')::uuid,
            p_buyer_id, p_buyer_type, v_qty, v_rate, v_amount,
            0, 0, p_payment_type, auth.uid(), 'counter', v_bill);
  end loop;

  -- The invoice row was created within this transaction by the sale trigger.
  select invoice_no into v_invoice_no
    from public.invoices where bill_id = v_bill;

  return jsonb_build_object('bill_id', v_bill, 'invoice_no', v_invoice_no);
end $$;

grant execute on function public.create_counter_sale(uuid,text,text,jsonb) to authenticated;

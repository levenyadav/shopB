-- =============================================================================
-- 056_part_payment_and_bill_corrections.sql — part-paid bills, advances used at
-- billing, a receipt row for money taken at the counter, and bill corrections.
--
-- Found on SAI PAPER (2026-09-29): a ₹97,725 dealer bill had to be entered as
-- "Cash" because a bill could only be all-cash, all-UPI or all-udhaar. The
-- ₹50,000 the dealer had actually paid was never entered, and there was no way
-- to fix the bill afterwards. Five gaps, all closed here:
--
-- 1. PART PAYMENT. create_counter_sale and approve_order take p_paid_now +
--    p_paid_method. On udhaar, whatever is paid now is recorded; the rest stays
--    on account.
--
-- 2. ADVANCES. Every bill now goes on the account first (below), so an advance
--    (a negative balance) absorbs an udhaar bill by itself. The screens show
--    the advance and what is left after the bill.
--
-- 3. RECEIPTS FOR COUNTER MONEY. The standard ledger model from here on: a
--    sale raises the balance by its full amount, and money received at billing
--    is a real `payments` row (at_billing = true, linked to the bill) whose
--    trigger lowers it again. A cash bill now reads "Sale +X / Paid at billing
--    −X" in the ledger and on the statement, instead of one row that moved
--    nothing. Old rows keep their old meaning — see ledger_legacy_moves.
--
-- 4. CORRECTIONS. correct_sale_bill (owner only) can
--      'mark_unpaid' — the bill was entered as paid but the money was not
--                      received; that amount moves onto the account;
--      'discount'    — a discount agreed after billing; it is split across the
--                      bill's lines (order_bills + profit), exactly like a
--                      discount given at billing (051).
--    Both only ADD ledger rows; nothing is edited. Each correction is also kept
--    in sale_corrections with who did it and why. A return with stock going
--    back is deliberately not here: stock comes in only through Purchase Entry
--    (Golden Rule #1).
--
-- 5. DEBIT/CREDIT WORDING. The raw ledger.debit/credit columns are written
--    from the PARTY's point of view (a sale is a "credit" on the buyer), the
--    reverse of the shop's books. Rewriting history is not allowed (Golden
--    Rule #9), so the columns are documented here and ledger_entries gains
--    dr_amount / cr_amount in the normal sense. Anything that exports or reports
--    must read those two.
--
-- LEGACY ROWS. ledger_entries (052) worked out whether an old sale row moved
-- the balance by reading the sale's CURRENT payment_type. A correction changes
-- payment_type, which would silently re-price every old row. So the answer for
-- every existing sale row is frozen once into ledger_legacy_moves, and new rows
-- carry their own ledger.balance_delta. Nothing in `ledger` is updated.
--
-- Views are rebuilt from their LIVE definitions (dumped 2026-09-29), not from
-- the repo copy of 052.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Ledger columns, the legacy snapshot, and the append-only guard.
-- ---------------------------------------------------------------------------
alter table public.ledger add column if not exists balance_delta numeric(14,2);
alter table public.ledger add column if not exists kind text;

comment on column public.ledger.debit is
  'PARTY''S point of view, not the shop''s: a payment IN from a buyer, a purchase from a supplier, or a discount. For normal books read ledger_entries.cr_amount.';
comment on column public.ledger.credit is
  'PARTY''S point of view, not the shop''s: a sale to a buyer, or a payment OUT to a supplier. For normal books read ledger_entries.dr_amount.';
comment on column public.ledger.balance_delta is
  'How much this row moved balance_due (056+). NULL on older rows; see ledger_legacy_moves.';
comment on column public.ledger.kind is
  'Finer type (056+): sale, sale_discount, bill_charge, bill_unpaid, receipt_reversed, payment_in, payment_out.';

create table if not exists public.ledger_legacy_moves (
  ledger_id         uuid primary key references public.ledger(id),
  shop_id           uuid not null,
  party_id          uuid not null,
  party_type        text not null,
  moved             boolean not null,
  balance_delta     numeric(14,2) not null,
  sale_payment_type text
);

-- Frozen once: what every existing sale row did to the balance, judged by the
-- payment type it was billed with. Only rows not already frozen, so a re-run
-- never re-judges a row after a correction has changed its payment_type.
insert into public.ledger_legacy_moves
  (ledger_id, shop_id, party_id, party_type, moved, balance_delta, sale_payment_type)
select l.id, l.shop_id, l.party_id, l.party_type,
       coalesce(s.payment_type, 'udhaar') = 'udhaar',
       case when coalesce(s.payment_type, 'udhaar') = 'udhaar'
            then case when l.party_type = 'supplier' then l.debit - l.credit
                      else l.credit - l.debit end
            else 0 end,
       s.payment_type
  from public.ledger l
  left join public.sales s on s.id = l.reference_id
 where l.reference_table = 'sales'
   and l.balance_delta is null
on conflict (ledger_id) do nothing;

alter table public.ledger_legacy_moves enable row level security;
drop policy if exists legacy_moves_owner_select on public.ledger_legacy_moves;
create policy legacy_moves_owner_select on public.ledger_legacy_moves
  for select using (auth_role() = 'owner' and shop_id = auth_shop_id());
drop policy if exists legacy_moves_party_select on public.ledger_legacy_moves;
create policy legacy_moves_party_select on public.ledger_legacy_moves
  for select using (party_id = auth.uid() and party_type in ('customer','dealer'));
grant select on public.ledger_legacy_moves to authenticated;

-- Golden Rule #9, enforced instead of only promised. No function updates or
-- deletes ledger rows (checked 2026-09-29), so this breaks nothing.
create or replace function public.ledger_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'The ledger is append-only: add a correcting entry instead of changing or deleting one.';
end $$;
drop trigger if exists trg_ledger_append_only on public.ledger;
create trigger trg_ledger_append_only
  before update or delete on public.ledger
  for each row execute function public.ledger_append_only();

-- Money received at billing is a payments row flagged at_billing.
alter table public.payments add column if not exists at_billing boolean not null default false;

-- ---------------------------------------------------------------------------
-- 1. Triggers: every sale goes on the account; every payment records its move.
--    clock_timestamp() so rows written in one transaction keep their order.
-- ---------------------------------------------------------------------------
create or replace function public.on_sale_insert()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  buyer_bal  numeric(14,2) := 0;
  item_name  text;
  v_mto      boolean;
  is_counter boolean := (new.source = 'counter');
begin
  select name, made_to_order into item_name, v_mto
    from public.items where id = new.item_id;

  -- Made-to-order carries no stock; everything else is auto-split across as
  -- many warehouses as the quantity needs (050).
  if not v_mto then
    perform public.allocate_stock_out(new.id, new.item_id, new.warehouse_id, new.quantity);
  end if;

  -- 056: the bill goes on the account whatever the payment type. Money taken
  -- at billing arrives right after as a payments row (at_billing) and takes
  -- it off again, so a cash bill nets to zero with both halves visible.
  update public.profiles
     set balance_due = balance_due + new.amount
   where id = new.buyer_id
   returning balance_due into buyer_bal;

  insert into public.ledger (shop_id, entry_type, party_id, party_type,
                             reference_id, reference_table, debit, credit,
                             running_balance, description, balance_delta, kind,
                             created_at)
  values (new.shop_id, 'sale', new.buyer_id, new.buyer_type,
          new.id, 'sales', 0, new.amount,
          coalesce(buyer_bal, 0),
          case when is_counter then 'Counter sale: ' else 'Sale: ' end
            || coalesce(item_name, 'item'),
          new.amount, 'sale', clock_timestamp());

  update public.orders set status = 'approved' where id = new.order_id;

  insert into public.fulfilment (shop_id, order_id, sale_id, status)
  values (new.shop_id, new.order_id, new.id, 'pending_pack');

  return new;
end $function$;

create or replace function public.on_payment_insert()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare new_bal numeric(14,2);
begin
  if new.direction = 'in' then
    update public.profiles
       set balance_due = balance_due - new.amount
     where id = new.party_id
     returning balance_due into new_bal;

    insert into public.ledger (shop_id, entry_type, party_id, party_type,
                               reference_id, reference_table, debit, credit,
                               running_balance, description, balance_delta, kind,
                               created_at)
    values (new.shop_id, 'payment_in', new.party_id, new.party_type,
            new.id, 'payments', new.amount, 0,
            coalesce(new_bal,0),
            case when new.at_billing then 'Paid at billing: '
                 when new.linked_sale_id is not null then 'Payment received against bill: '
                 else 'Payment received: ' end || new.method,
            -new.amount, 'payment_in', clock_timestamp());
  else
    update public.suppliers
       set balance_due = balance_due - new.amount
     where id = new.party_id
     returning balance_due into new_bal;

    insert into public.ledger (shop_id, entry_type, party_id, party_type,
                               reference_id, reference_table, debit, credit,
                               running_balance, description, balance_delta, kind,
                               created_at)
    values (new.shop_id, 'payment_out', new.party_id, 'supplier',
            new.id, 'payments', 0, new.amount,
            coalesce(new_bal,0), 'Payment made: ' || new.method,
            -new.amount, 'payment_out', clock_timestamp());
  end if;
  return new;
end $function$;

-- ---------------------------------------------------------------------------
-- 2. Counter sale with part payment.
--    p_payment_type 'cash' / 'upi' — paid in full now by that method.
--    p_payment_type 'udhaar'       — p_paid_now (0..total) is paid now by
--                                    p_paid_method; the rest stays on account.
-- ---------------------------------------------------------------------------
drop function if exists public.create_counter_sale(uuid, text, text, jsonb, numeric);

create function public.create_counter_sale(
  p_buyer_id uuid, p_buyer_type text, p_payment_type text, p_lines jsonb,
  p_discount numeric default 0, p_paid_now numeric default null,
  p_paid_method text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
  v_total      numeric(14,2);
  v_received   numeric(14,2);
  v_method     text;
  v_type       text;
  v_share      numeric(14,2);
  v_given      numeric(14,2) := 0;
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

  perform 1 from public.profiles
    where id = p_buyer_id and shop_id = v_shop and role in ('customer','dealer');
  if not found then
    raise exception 'Buyer not found in this shop';
  end if;

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
  v_total := round(v_subtotal - v_discount, 2);

  -- How much is paid now, and by what.
  if p_payment_type = 'udhaar' then
    v_method := coalesce(p_paid_method, 'cash');
    if v_method not in ('cash','upi') then
      raise exception 'Paid-now method must be cash or upi, not %', v_method;
    end if;
    if coalesce(p_paid_now, 0) < 0 then
      raise exception 'Amount paid now cannot be negative';
    end if;
    if coalesce(p_paid_now, 0) > v_total then
      raise exception 'Amount paid now (%) is more than the bill (%). Record the extra as a Payment In advance.',
        p_paid_now, v_total;
    end if;
    v_received := round(coalesce(p_paid_now, 0), 2);
  else
    v_method   := p_payment_type;
    v_received := v_total;
  end if;
  -- Anything left on account makes it an udhaar bill.
  v_type := case when v_received < v_total then 'udhaar' else v_method end;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty    := (v_line->>'quantity')::numeric;
    v_rate   := (v_line->>'rate')::numeric;
    v_amount := round(v_qty * v_rate, 2);

    insert into public.orders (shop_id, item_id, buyer_id, buyer_type, quantity,
                               rate_at_order, amount, status, source, bill_id)
    values (v_shop, (v_line->>'item_id')::uuid, p_buyer_id, p_buyer_type,
            v_qty, v_rate, v_amount, 'pending', 'counter', v_bill)
    returning id into v_order;

    -- purchase_rate + profit: fill_counter_sale_cost; stock, balance, ledger,
    -- order status, pack job: on_sale_insert; invoice no: create_invoice_for_sale.
    insert into public.sales (shop_id, order_id, item_id, category_id, buyer_id,
                              buyer_type, quantity, rate_charged, amount,
                              purchase_rate, profit, payment_type, approved_by,
                              source, bill_id)
    values (v_shop, v_order, (v_line->>'item_id')::uuid, (v_line->>'category_id')::uuid,
            p_buyer_id, p_buyer_type, v_qty, v_rate, v_amount,
            0, 0, v_type, auth.uid(), 'counter', v_bill)
    returning id into v_sale;

    v_orders  := v_orders  || v_order;
    v_sales   := v_sales   || v_sale;
    v_amounts := v_amounts || v_amount;
  end loop;

  -- ---- The discount, if any (051) -----------------------------------------
  if v_discount > 0 then
    n := array_length(v_sales, 1);
    for i in 1 .. n loop
      if i = n then
        v_share := round(v_discount - v_given, 2);
      else
        v_share := round(v_discount * v_amounts[i] / v_subtotal, 2);
      end if;
      v_given := round(v_given + v_share, 2);

      update public.sales
         set profit = round(profit - v_share, 2)
       where id = v_sales[i];

      insert into public.order_bills (shop_id, order_id, sale_id, subtotal,
                                      discount_amount, grand_total)
      values (v_shop, v_orders[i], v_sales[i], v_amounts[i],
              v_share, round(v_amounts[i] - v_share, 2));
    end loop;

    -- The bill went on the account gross, so the discount always comes off it.
    update public.profiles set balance_due = balance_due - v_discount
     where id = p_buyer_id
     returning balance_due into v_bal;

    insert into public.ledger (shop_id, entry_type, party_id, party_type,
                               reference_id, reference_table, debit, credit,
                               running_balance, description, balance_delta, kind,
                               created_at)
    values (v_shop, 'sale', p_buyer_id, p_buyer_type,
            v_sales[1], 'sales', v_discount, 0, coalesce(v_bal, 0),
            'Counter sale discount: less ' || v_discount ||
              ' on ' || n || ' item' || case when n = 1 then '' else 's' end,
            -v_discount, 'sale_discount', clock_timestamp());
  end if;

  -- ---- Money taken now: a real receipt (on_payment_insert books it) --------
  if v_received > 0 then
    insert into public.payments (shop_id, direction, party_id, party_type, amount,
                                 method, linked_sale_id, recorded_by, notes, at_billing)
    values (v_shop, 'in', p_buyer_id, p_buyer_type, v_received,
            v_method, v_sales[1], auth.uid(), 'Paid at billing', true);
  end if;

  select invoice_no into v_invoice_no
    from public.invoices where bill_id = v_bill;
  select balance_due into v_bal from public.profiles where id = p_buyer_id;

  return jsonb_build_object('bill_id', v_bill, 'invoice_no', v_invoice_no,
                            'discount', v_discount, 'total', v_total,
                            'paid_now', v_received, 'on_account', v_total - v_received,
                            'payment_type', v_type, 'balance_after', v_bal);
end $function$;

grant execute on function public.create_counter_sale(uuid,text,text,jsonb,numeric,numeric,text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Shopfront approval with part payment. Same rules as the counter.
-- ---------------------------------------------------------------------------
drop function if exists public.approve_order(uuid, text, numeric, numeric, numeric, numeric, numeric, text, uuid);

create function public.approve_order(
  p_order_id uuid, p_payment_type text, p_cost numeric default null,
  p_discount numeric default 0, p_shipping numeric default 0,
  p_packing numeric default 0, p_other numeric default 0,
  p_notes text default null, p_warehouse_id uuid default null,
  p_paid_now numeric default null, p_paid_method text default null)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
  v_received  numeric(14,2);
  v_method    text;
  v_type      text;
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

  v_cost := round(coalesce(v_item.purchase_rate, 0), 2);

  if v_item.made_to_order then
    if v_cost <= 0 then
      raise exception 'This made-to-order item has no purchase rate set. Set its cost in Inventory / Purchase Entry, then approve.';
    end if;
  else
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

  v_net   := round(v_shipping + v_packing + v_other - v_discount, 2);
  v_grand := round(v_ord.amount + v_net, 2);

  if p_payment_type = 'udhaar' then
    v_method := coalesce(p_paid_method, 'cash');
    if v_method not in ('cash','upi') then
      raise exception 'Paid-now method must be cash or upi, not %', v_method;
    end if;
    if coalesce(p_paid_now, 0) < 0 then
      raise exception 'Amount paid now cannot be negative';
    end if;
    if coalesce(p_paid_now, 0) > v_grand then
      raise exception 'Amount paid now (%) is more than the bill (%). Record the extra as a Payment In advance.',
        p_paid_now, v_grand;
    end if;
    v_received := round(coalesce(p_paid_now, 0), 2);
  else
    v_method   := p_payment_type;
    v_received := v_grand;
  end if;
  v_type := case when v_received < v_grand then 'udhaar' else v_method end;

  v_profit := round((v_ord.rate_at_order - v_cost) * v_ord.quantity - v_discount, 2);

  insert into public.sales (shop_id, order_id, item_id, category_id, buyer_id,
                            buyer_type, quantity, rate_charged, amount,
                            purchase_rate, profit, payment_type, approved_by,
                            source, warehouse_id)
  values (v_shop, v_ord.id, v_ord.item_id, v_item.category_id, v_ord.buyer_id,
          v_ord.buyer_type, v_ord.quantity, v_ord.rate_at_order, v_ord.amount,
          v_cost, v_profit, v_type, auth.uid(), 'shopfront', p_warehouse_id)
  returning id into v_sale_id;

  if v_net <> 0 then
    update public.profiles set balance_due = balance_due + v_net
     where id = v_ord.buyer_id
     returning balance_due into v_bal;

    v_item_name := coalesce(v_item.name, 'item');
    insert into public.ledger (shop_id, entry_type, party_id, party_type,
                               reference_id, reference_table, debit, credit,
                               running_balance, description, balance_delta, kind,
                               created_at)
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
                case when v_discount > 0 then 'less discount ' || v_discount else null end)),
            v_net, case when v_net < 0 then 'sale_discount' else 'bill_charge' end,
            clock_timestamp());
  end if;

  insert into public.order_bills (shop_id, order_id, sale_id, order_group_id,
                                  subtotal, discount_amount, shipping_fee,
                                  packing_fee, other_charge, grand_total, notes)
  values (v_shop, v_ord.id, v_sale_id, v_ord.order_group_id,
          v_ord.amount, v_discount, v_shipping, v_packing, v_other,
          v_grand, p_notes);

  if v_received > 0 then
    insert into public.payments (shop_id, direction, party_id, party_type, amount,
                                 method, linked_sale_id, recorded_by, notes, at_billing)
    values (v_shop, 'in', v_ord.buyer_id, v_ord.buyer_type, v_received,
            v_method, v_sale_id, auth.uid(), 'Paid at billing', true);
  end if;

  return v_sale_id;
end $function$;

grant execute on function public.approve_order(uuid,text,numeric,numeric,numeric,numeric,numeric,text,uuid,numeric,text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Read layer. Dropped in reverse dependency order and rebuilt.
-- ---------------------------------------------------------------------------
drop view if exists public.party_summary;
drop view if exists public.party_open_bills;
drop view if exists public.party_bills;
drop view if exists public.ledger_entries;

create view public.ledger_entries
with (security_invoker = true) as
select
  l.id, l.shop_id, l.entry_type, l.party_id, l.party_type,
  l.reference_id, l.reference_table, l.debit, l.credit, l.running_balance,
  l.description, l.created_at,
  x.signed_amount,
  -- 056 rows say what they moved; older sale rows use the frozen answer;
  -- every other older row moved by its full signed amount.
  coalesce(l.balance_delta, lm.balance_delta, x.signed_amount) as balance_delta,
  case when l.balance_delta is not null then true
       when lm.ledger_id is not null then lm.moved
       else true end as moved_balance,
  -- The payment type the row was BILLED with (a later correction does not
  -- rewrite what happened at the counter).
  case when lm.ledger_id is not null then lm.sale_payment_type
       else s.payment_type end as sale_payment_type,
  pay.method as payment_method,
  pay.reference_no as payment_reference_no,
  coalesce(l.kind,
    case when l.entry_type = 'sale' and l.debit > 0 then 'sale_discount'
         else l.entry_type end) as kind,
  case
    when l.reference_table = 'sales'
      then coalesce(s.bill_id, o.order_group_id, s.order_id, l.reference_id)
    when l.reference_table = 'purchases'
      then coalesce(pu.purchase_group_id, l.reference_id)
    else null::uuid
  end as bill_key,
  coalesce(inv.invoice_no, pu.invoice_no, pinv.invoice_no) as invoice_no,
  pu.invoice_date as supplier_invoice_date,
  -- Normal books, from the SHOP's side (the raw columns are the party's).
  l.credit as dr_amount,
  l.debit  as cr_amount,
  -- Money settling the account: payments, and reversals of payments.
  (l.reference_table = 'payments' or coalesce(l.kind, '') = 'receipt_reversed') as is_settlement,
  case
    when l.reference_table = 'payments' and pay.linked_sale_id is not null
      then coalesce(ps.bill_id, po.order_group_id, ps.order_id, ps.id)
    when coalesce(l.kind, '') = 'receipt_reversed'
      then coalesce(s.bill_id, o.order_group_id, s.order_id, l.reference_id)
    else null::uuid
  end as settles_bill_key,
  (coalesce(pay.at_billing, false) or coalesce(l.kind, '') = 'receipt_reversed') as paid_at_billing,
  s.payment_type as current_payment_type
from public.ledger l
left join public.ledger_legacy_moves lm on lm.ledger_id = l.id
left join public.sales s on l.reference_table = 'sales' and s.id = l.reference_id
left join public.orders o on o.id = s.order_id
left join public.purchases pu on l.reference_table = 'purchases' and pu.id = l.reference_id
left join public.payments pay on l.reference_table = 'payments' and pay.id = l.reference_id
left join public.sales ps on ps.id = pay.linked_sale_id
left join public.orders po on po.id = ps.order_id
left join public.invoices inv
  on inv.sale_id = s.id or (s.bill_id is not null and inv.bill_id = s.bill_id)
left join public.invoices pinv
  on pinv.sale_id = ps.id or (ps.bill_id is not null and pinv.bill_id = ps.bill_id)
cross join lateral (
  select case when l.party_type = 'supplier' then l.debit - l.credit
              else l.credit - l.debit end as signed_amount
) x;

grant select on public.ledger_entries to authenticated;

-- One row per BILL. Settlement rows (payments, reversals) are not part of a
-- bill's value; the money linked to it is reported alongside.
create view public.party_bills
with (security_invoker = true) as
with settle as (
  select party_id, party_type, settles_bill_key as bill_key,
         sum(-balance_delta) as paid_linked,
         coalesce(sum(-balance_delta) filter (where paid_at_billing), 0) as paid_at_billing
    from public.ledger_entries
   where is_settlement and settles_bill_key is not null
   group by party_id, party_type, settles_bill_key
), bills as (
  select e.shop_id, e.party_id, e.party_type, e.bill_key,
         case when e.reference_table = 'purchases' then 'purchase' else 'sale' end as bill_kind,
         min(e.created_at) as billed_at,
         -- A 'bill_unpaid' correction only puts an old bill onto the account;
         -- it adds nothing to what the bill was worth.
         coalesce(sum(e.signed_amount) filter (where e.kind <> 'bill_unpaid'), 0) as bill_total,
         greatest(sum(e.balance_delta), 0) as credit_amount,
         count(*) filter (where e.kind not in ('bill_unpaid','sale_discount','bill_charge')) as entry_count,
         max(e.invoice_no) as invoice_no,
         max(e.supplier_invoice_date) as supplier_invoice_date,
         (array_agg(e.reference_id order by e.created_at, e.id))[1] as detail_ref,
         max(e.current_payment_type) as payment_type
    from public.ledger_entries e
   where e.bill_key is not null and not e.is_settlement
   group by e.shop_id, e.party_id, e.party_type, e.bill_key,
            case when e.reference_table = 'purchases' then 'purchase' else 'sale' end
)
select b.shop_id, b.party_id, b.party_type, b.bill_key, b.bill_kind, b.billed_at,
       b.bill_total, b.credit_amount, b.entry_count, b.invoice_no,
       b.supplier_invoice_date,
       -- Something of this bill is still on account after what was paid for it.
       (b.credit_amount - least(b.credit_amount, greatest(coalesce(st.paid_linked, 0), 0))) > 0 as on_credit,
       b.detail_ref, b.payment_type,
       coalesce(st.paid_linked, 0) as paid_linked,
       coalesce(st.paid_at_billing, 0) as paid_at_billing
  from bills b
  left join settle st
    on st.party_id = b.party_id and st.party_type = b.party_type and st.bill_key = b.bill_key;

grant select on public.party_bills to authenticated;

-- Which bills are still open. Money linked to a bill (paid at billing, or a
-- payment recorded against it) settles THAT bill first; everything else is
-- applied oldest bill first.
create view public.party_open_bills
with (security_invoker = true) as
with paid as (
  select party_id, party_type, sum(-balance_delta) as paid_total
    from public.ledger_entries
   where is_settlement
   group by party_id, party_type
), own as (
  select b.*,
         least(b.credit_amount, greatest(b.paid_linked, 0)) as own_paid
    from public.party_bills b
   where b.credit_amount > 0
), own_total as (
  select party_id, party_type, sum(own_paid) as own_paid_total
    from own group by party_id, party_type
), billed as (
  select o.*,
         o.credit_amount - o.own_paid as residual,
         sum(o.credit_amount - o.own_paid) over (
           partition by o.party_id, o.party_type
           order by o.billed_at, o.bill_key
           rows between unbounded preceding and current row) as residual_to_date
    from own o
), alloc as (
  select b.*,
         round(least(b.residual, greatest(
           b.residual_to_date
             - greatest(coalesce(p.paid_total, 0) - coalesce(ot.own_paid_total, 0), 0),
           0)), 2) as outstanding_amt
    from billed b
    left join paid p on p.party_id = b.party_id and p.party_type = b.party_type
    left join own_total ot on ot.party_id = b.party_id and ot.party_type = b.party_type
)
select a.shop_id, a.party_id, a.party_type, a.bill_key, a.bill_kind, a.billed_at,
       a.invoice_no, a.supplier_invoice_date, a.detail_ref, a.entry_count,
       a.bill_total, a.credit_amount,
       a.outstanding_amt as outstanding,
       round(a.credit_amount - a.outstanding_amt, 2) as paid_amount,
       current_date - a.billed_at::date as age_days,
       case
         when (current_date - a.billed_at::date) <= 30 then '0-30'
         when (current_date - a.billed_at::date) <= 60 then '31-60'
         when (current_date - a.billed_at::date) <= 90 then '61-90'
         else '90+'
       end as age_bucket
  from alloc a;

grant select on public.party_open_bills to authenticated;

create view public.party_summary
with (security_invoker = true) as
with parties as (
  select p.id, p.shop_id, 'profile'::text as source, p.role as party_type,
         p.full_name as name, p.phone, p.is_active, p.created_at, p.balance_due,
         p.gstin, p.address, p.state_name, p.state_code, null::text as contact_person
    from public.profiles p
   where p.role = any (array['customer','dealer'])
  union all
  select s.id, s.shop_id, 'supplier', 'supplier', s.name, s.phone, s.is_active,
         s.created_at, s.balance_due, null, s.address, null, null, s.contact_person
    from public.suppliers s
), activity as (
  select party_id, party_type,
         min(created_at) as first_txn_at,
         max(created_at) as last_txn_at,
         max(created_at) filter (where reference_table = 'payments') as last_payment_at,
         max(created_at) filter (where not is_settlement) as last_bill_at,
         sum(-balance_delta) filter (where is_settlement) as settled_total,
         sum(signed_amount) filter (where not is_settlement and kind <> 'bill_unpaid') as business_total,
         count(*) as entry_count,
         sum(balance_delta) as computed_balance
    from public.ledger_entries
   group by party_id, party_type
), bills as (
  select party_id, party_type,
         count(*) as bill_count,
         avg(bill_total) as avg_bill_value,
         max(bill_total) as largest_bill,
         -- Given on credit: what each bill put on account beyond the money
         -- taken for it at billing.
         sum(greatest(credit_amount - least(credit_amount, greatest(paid_at_billing, 0)), 0)) as credit_total
    from public.party_bills
   group by party_id, party_type
), open_bills as (
  select party_id, party_type,
         sum(outstanding) as outstanding_total,
         count(*) filter (where outstanding > 0) as open_bill_count,
         min(billed_at) filter (where outstanding > 0) as oldest_open_at,
         max(age_days) filter (where outstanding > 0) as oldest_open_days,
         sum(outstanding) filter (where age_bucket = '0-30') as due_0_30,
         sum(outstanding) filter (where age_bucket = '31-60') as due_31_60,
         sum(outstanding) filter (where age_bucket = '61-90') as due_61_90,
         sum(outstanding) filter (where age_bucket = '90+') as due_90_plus
    from public.party_open_bills
   group by party_id, party_type
), profit as (
  select buyer_id as party_id, buyer_type as party_type, sum(profit) as profit_total
    from public.sales
   group by buyer_id, buyer_type
)
select pa.id as party_id, pa.party_type, pa.shop_id, pa.name, pa.phone, pa.is_active,
       pa.created_at as party_since, pa.gstin, pa.address, pa.state_name, pa.state_code,
       pa.contact_person, pa.balance_due,
       coalesce(ac.computed_balance, 0) as computed_balance,
       round(pa.balance_due - coalesce(ac.computed_balance, 0), 2) as balance_drift,
       coalesce(ac.business_total, 0) as business_total,
       coalesce(ac.settled_total, 0) as settled_total,
       coalesce(bi.credit_total, 0) as credit_total,
       coalesce(bi.bill_count, 0) as bill_count,
       round(coalesce(bi.avg_bill_value, 0), 2) as avg_bill_value,
       coalesce(bi.largest_bill, 0) as largest_bill,
       coalesce(ac.entry_count, 0) as entry_count,
       pr.profit_total,
       ac.first_txn_at, ac.last_txn_at, ac.last_bill_at, ac.last_payment_at,
       case when ac.last_txn_at is null then null::integer
            else current_date - ac.last_txn_at::date end as days_since_last_txn,
       coalesce(ob.outstanding_total, 0) as outstanding_total,
       coalesce(ob.open_bill_count, 0) as open_bill_count,
       ob.oldest_open_at, ob.oldest_open_days,
       coalesce(ob.due_0_30, 0) as due_0_30,
       coalesce(ob.due_31_60, 0) as due_31_60,
       coalesce(ob.due_61_90, 0) as due_61_90,
       coalesce(ob.due_90_plus, 0) as due_90_plus
  from parties pa
  left join activity ac on ac.party_id = pa.id and ac.party_type = pa.party_type
  left join bills bi on bi.party_id = pa.id and bi.party_type = pa.party_type
  left join open_bills ob on ob.party_id = pa.id and ob.party_type = pa.party_type
  left join profit pr on pr.party_id = pa.id and pr.party_type = pa.party_type;

grant select on public.party_summary to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Bill corrections.
-- ---------------------------------------------------------------------------
create table if not exists public.sale_corrections (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id),
  bill_key    uuid not null,
  sale_id     uuid not null references public.sales(id),
  party_id    uuid not null,
  action      text not null check (action in ('mark_unpaid','discount')),
  amount      numeric(14,2) not null check (amount > 0),
  reason      text,
  created_by  uuid not null references public.profiles(id),
  created_at  timestamptz not null default now()
);
create index if not exists idx_sale_corrections_bill on public.sale_corrections (bill_key);
alter table public.sale_corrections enable row level security;
drop policy if exists sale_corrections_owner_select on public.sale_corrections;
create policy sale_corrections_owner_select on public.sale_corrections
  for select using (auth_role() = 'owner' and shop_id = auth_shop_id());
grant select on public.sale_corrections to authenticated;

-- The work, with the actor passed in. Not callable by app users: the
-- correct_sale_bill wrapper below checks the caller is the shop's owner.
create or replace function public._correct_sale_bill(
  p_sale_id uuid, p_action text, p_amount numeric, p_reason text, p_actor uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_sale        public.sales%rowtype;
  v_key         uuid;
  v_ids         uuid[];
  v_amts        numeric(14,2)[];
  v_orders      uuid[];
  v_goods       numeric(14,2);
  v_value       numeric(14,2);
  v_posted      numeric(14,2);
  v_unposted    numeric(14,2);
  v_billing_paid numeric(14,2);
  v_max         numeric(14,2);
  v_amt         numeric(14,2);
  v_part        numeric(14,2);
  v_share       numeric(14,2);
  v_given       numeric(14,2) := 0;
  v_bal         numeric(14,2);
  i             int;
  n             int;
begin
  if p_action not in ('mark_unpaid','discount') then
    raise exception 'Unknown correction: %', p_action;
  end if;

  select * into v_sale from public.sales where id = p_sale_id;
  if not found then raise exception 'Sale not found'; end if;

  -- The whole bill this line belongs to (same key as ledger_entries.bill_key).
  select coalesce(v_sale.bill_id, o.order_group_id, v_sale.order_id)
    into v_key from public.orders o where o.id = v_sale.order_id;
  v_key := coalesce(v_key, v_sale.order_id);

  select array_agg(s.id order by s.created_at, s.id),
         array_agg(s.amount order by s.created_at, s.id),
         array_agg(s.order_id order by s.created_at, s.id)
    into v_ids, v_amts, v_orders
    from public.sales s
    left join public.orders o on o.id = s.order_id
   where s.buyer_id = v_sale.buyer_id
     and coalesce(s.bill_id, o.order_group_id, s.order_id) = v_key;
  n := array_length(v_ids, 1);
  select sum(a) into v_goods from unnest(v_amts) a;

  -- What the bill is worth now, how much of it is on the account, and how
  -- much was recorded as paid at billing.
  select coalesce(sum(signed_amount) filter (where kind <> 'bill_unpaid'), 0),
         coalesce(sum(balance_delta), 0)
    into v_value, v_posted
    from public.ledger_entries
   where party_id = v_sale.buyer_id and bill_key = v_key and not is_settlement;
  v_unposted := round(v_value - v_posted, 2);

  select coalesce(sum(-balance_delta), 0) into v_billing_paid
    from public.ledger_entries
   where party_id = v_sale.buyer_id and settles_bill_key = v_key
     and is_settlement and paid_at_billing;

  if p_action = 'mark_unpaid' then
    v_max := round(greatest(v_unposted, 0) + greatest(v_billing_paid, 0), 2);
    if v_max <= 0 then
      raise exception 'Nothing on this bill was recorded as paid at billing, so there is nothing to move to udhaar.';
    end if;
    v_amt := round(coalesce(p_amount, v_max), 2);
    if v_amt <= 0 or v_amt > v_max then
      raise exception 'Amount not received must be between 0 and % (what was recorded as paid for this bill).', v_max;
    end if;

    -- Old bills (before 056) never reached the account: put them on it.
    v_part := least(v_amt, greatest(v_unposted, 0));
    if v_part > 0 then
      update public.profiles set balance_due = balance_due + v_part
       where id = v_sale.buyer_id returning balance_due into v_bal;
      insert into public.ledger (shop_id, entry_type, party_id, party_type,
                                 reference_id, reference_table, debit, credit,
                                 running_balance, description, balance_delta, kind,
                                 created_at)
      values (v_sale.shop_id, 'sale', v_sale.buyer_id, v_sale.buyer_type,
              v_ids[1], 'sales', 0, v_part, coalesce(v_bal, 0),
              'Correction: bill was entered as paid, money not received — moved to udhaar',
              v_part, 'bill_unpaid', clock_timestamp());
    end if;

    -- Newer bills took their money as a receipt: reverse the receipt.
    v_part := round(v_amt - v_part, 2);
    if v_part > 0 then
      update public.profiles set balance_due = balance_due + v_part
       where id = v_sale.buyer_id returning balance_due into v_bal;
      insert into public.ledger (shop_id, entry_type, party_id, party_type,
                                 reference_id, reference_table, debit, credit,
                                 running_balance, description, balance_delta, kind,
                                 created_at)
      values (v_sale.shop_id, 'sale', v_sale.buyer_id, v_sale.buyer_type,
              v_ids[1], 'sales', 0, v_part, coalesce(v_bal, 0),
              'Correction: payment at billing was not received — reversed',
              v_part, 'receipt_reversed', clock_timestamp());
    end if;

    update public.sales set payment_type = 'udhaar' where id = any(v_ids);

  else  -- discount
    v_amt := round(coalesce(p_amount, 0), 2);
    if v_amt <= 0 then raise exception 'Enter a discount greater than zero.'; end if;
    if v_amt > v_value then
      raise exception 'A discount of % is more than this bill is worth now (%).', v_amt, v_value;
    end if;

    -- Split across the lines by amount, the last line taking the rounding,
    -- exactly as a discount given at billing is (051).
    for i in 1 .. n loop
      if i = n then v_share := round(v_amt - v_given, 2);
      else v_share := round(v_amt * v_amts[i] / nullif(v_goods, 0), 2);
      end if;
      v_share := coalesce(v_share, 0);
      v_given := round(v_given + v_share, 2);

      update public.sales set profit = round(profit - v_share, 2) where id = v_ids[i];

      insert into public.order_bills (shop_id, order_id, sale_id, subtotal,
                                      discount_amount, grand_total)
      values (v_sale.shop_id, v_orders[i], v_ids[i], v_amts[i],
              v_share, round(v_amts[i] - v_share, 2))
      on conflict (order_id) do update
        set discount_amount = public.order_bills.discount_amount + excluded.discount_amount,
            grand_total     = public.order_bills.grand_total - excluded.discount_amount,
            sale_id         = coalesce(public.order_bills.sale_id, excluded.sale_id);
    end loop;

    update public.profiles set balance_due = balance_due - v_amt
     where id = v_sale.buyer_id returning balance_due into v_bal;
    insert into public.ledger (shop_id, entry_type, party_id, party_type,
                               reference_id, reference_table, debit, credit,
                               running_balance, description, balance_delta, kind,
                               created_at)
    values (v_sale.shop_id, 'sale', v_sale.buyer_id, v_sale.buyer_type,
            v_ids[1], 'sales', v_amt, 0, coalesce(v_bal, 0),
            'Discount allowed after billing: less ' || v_amt,
            -v_amt, 'sale_discount', clock_timestamp());
  end if;

  insert into public.sale_corrections (shop_id, bill_key, sale_id, party_id,
                                       action, amount, reason, created_by)
  values (v_sale.shop_id, v_key, v_ids[1], v_sale.buyer_id,
          p_action, v_amt, nullif(trim(p_reason), ''), p_actor);

  select balance_due into v_bal from public.profiles where id = v_sale.buyer_id;
  return jsonb_build_object('amount', v_amt, 'balance_after', v_bal);
end $function$;

revoke all on function public._correct_sale_bill(uuid,text,numeric,text,uuid) from public, anon, authenticated;

create or replace function public.correct_sale_bill(
  p_sale_id uuid, p_action text, p_amount numeric default null, p_reason text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_shop uuid;
begin
  select shop_id into v_shop from public.profiles
   where id = auth.uid() and role = 'owner' and is_active;
  if v_shop is null then
    raise exception 'Only the owner can correct a bill';
  end if;
  perform 1 from public.sales where id = p_sale_id and shop_id = v_shop;
  if not found then raise exception 'Sale not found in this shop'; end if;
  return public._correct_sale_bill(p_sale_id, p_action, p_amount, p_reason, auth.uid());
end $function$;

revoke all on function public.correct_sale_bill(uuid,text,numeric,text) from public, anon;
grant execute on function public.correct_sale_bill(uuid,text,numeric,text) to authenticated;

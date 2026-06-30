-- =============================================================================
-- 014_counter_sale.sql — POS / Counter Sale (walk-in billing)
--
-- Lets OWNER and STAFF bill a walk-in customer on the spot:
--   * named buyers without a login   (profiles decoupled from auth.users)
--   * multi-item bills grouped by bill_id, created ATOMICALLY via one RPC
--   * counter sales reuse the verified on_sale_insert trigger (stock/ledger/profit)
--   * counter sales skip the pack queue (goods handed over immediately)
--   * cost price + profit are filled SERVER-SIDE, so the staff client never reads
--     purchase_rate (no cost-price leak — see migration 007)
--
-- SPEC change (made in the same commit): §4.2, §16, and golden rule #3 —
-- STAFF may finalize a COUNTER sale (the act of billing at the counter IS the
-- approval). Shopfront ORDERS still require OWNER approval. Staff still cannot
-- approve shopfront orders, see Reports profit, or read the ledger.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Decouple profiles from auth.users so a buyer can exist without a login.
--    Existing rows keep id == auth uid (login users are untouched); new walk-in
--    buyers get a random id and never authenticate, so every `id = auth.uid()`
--    RLS check stays correct with NO rewrite.
-- ---------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_id_fkey;
alter table public.profiles alter column id set default gen_random_uuid();

-- owner + staff may create login-less customer/dealer buyers at the counter
create policy profiles_counter_buyer_insert on public.profiles for insert
  with check (auth_role() in ('owner','staff') and shop_id = auth_shop_id()
              and role in ('customer','dealer'));

-- staff need to search existing customers/dealers to bill them
create policy profiles_staff_select_buyers on public.profiles for select
  using (auth_role() = 'staff' and shop_id = auth_shop_id()
         and role in ('customer','dealer'));

-- ---------------------------------------------------------------------------
-- 2. Origin tag + bill grouping on orders & sales.
--    source='shopfront' (default, unchanged behaviour) | 'counter' (POS).
--    bill_id bundles every line of one counter bill for the receipt + UI.
-- ---------------------------------------------------------------------------
alter table public.orders add column if not exists source text not null default 'shopfront'
  check (source in ('shopfront','counter'));
alter table public.orders add column if not exists bill_id uuid;
alter table public.sales  add column if not exists source text not null default 'shopfront'
  check (source in ('shopfront','counter'));
alter table public.sales  add column if not exists bill_id uuid;
create index if not exists idx_orders_bill on public.orders(bill_id);
create index if not exists idx_sales_bill  on public.sales(bill_id);

-- ---------------------------------------------------------------------------
-- 3. BEFORE INSERT on sales: for COUNTER sales, fill cost price + profit from
--    the item server-side. The client sends purchase_rate=0, profit=0 and never
--    touches cost price. Shopfront approval (source='shopfront') is untouched —
--    the owner client still supplies these.
-- ---------------------------------------------------------------------------
create or replace function public.fill_counter_sale_cost()
returns trigger language plpgsql security definer set search_path = public as $$
declare cost numeric(14,2);
begin
  if new.source = 'counter' then
    select purchase_rate into cost from public.items where id = new.item_id;
    new.purchase_rate := coalesce(cost, 0);
    new.profit := (new.rate_charged - new.purchase_rate) * new.quantity;
  end if;
  return new;
end $$;

create trigger trg_sale_fill_cost before insert on public.sales
  for each row execute function public.fill_counter_sale_cost();

-- ---------------------------------------------------------------------------
-- 4. on_sale_insert: branch fulfilment + order status on source.
--    counter -> order marked 'picked_up', fulfilment created already completed
--    (skips the staff pack queue). shopfront -> unchanged ('approved' + pending_pack).
--    Stock drop, udhaar balance and the ledger entry are IDENTICAL either way.
-- ---------------------------------------------------------------------------
create or replace function public.on_sale_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare buyer_bal numeric(14,2) := 0; item_name text; is_counter boolean;
begin
  is_counter := (new.source = 'counter');

  update public.items
     set quantity = quantity - new.quantity
   where id = new.item_id
   returning name into item_name;

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
          coalesce(buyer_bal,0),
          case when is_counter then 'Counter sale: ' else 'Sale: ' end
            || coalesce(item_name,'item'));

  update public.orders
     set status = case when is_counter then 'picked_up' else 'approved' end
   where id = new.order_id;

  insert into public.fulfilment (shop_id, order_id, sale_id, status,
                                 packed_by, packed_at, completed_by, completed_at)
  values (new.shop_id, new.order_id, new.id,
          case when is_counter then 'picked_up' else 'pending_pack' end,
          case when is_counter then new.approved_by else null end,
          case when is_counter then now()           else null end,
          case when is_counter then new.approved_by else null end,
          case when is_counter then now()           else null end);
  return new;
end $$;
-- trigger trg_sale_insert already binds on_sale_insert() (002); redefining the
-- function is enough.

-- ---------------------------------------------------------------------------
-- 5. Atomic multi-item counter bill. One transaction => a half-rung bill can
--    never be left behind (golden rules: money is never partially written).
--    SECURITY DEFINER so it writes orders/sales regardless of the caller's RLS,
--    but it re-checks role, shop and buyer itself. No staff INSERT policies on
--    orders/sales are needed — this RPC is the only counter write path, and the
--    receipt is rendered client-side from the cart, so no extra SELECT grants.
--
--    p_lines: jsonb array of { item_id, category_id, quantity, rate }
--    returns: the bill_id shared by every line.
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

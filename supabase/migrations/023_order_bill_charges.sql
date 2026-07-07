-- =============================================================================
-- 023_order_bill_charges.sql — Finalize-bill charges at approval (client feat).
--
-- At approval the owner may now turn a raw order into a FINAL BILL by adding,
-- ON TOP of the product lines the buyer already saw:
--   * a bill-level DISCOUNT   (a real margin loss — reduces profit)
--   * SHIPPING / PACKING / OTHER charges (pass-through — zero profit)
-- Tax stays as today: GST is tax-INCLUSIVE (009), so nothing is added on top;
-- the invoice just prints the breakup. Per the agreed decisions:
--   - "Charges only": per-line rate_charged is NEVER edited (Golden Rule #5 is
--     untouched — the buyer's per-piece price is preserved verbatim).
--   - Discount reduces the sale's recorded profit (honest #6) but NOT rate/amount,
--     so invoice lines stay clean (gross rate x qty) and the discount prints as
--     its own line.
--   - Shipping/packing/other are pass-through: they raise the buyer's payable but
--     carry no profit.
--
-- Money correctness (Golden Rules #9/#10): the product line is booked GROSS by the
-- existing, verified on_sale_insert trigger (udhaar + append-only ledger). The
-- net non-product money (shipping+packing+other - discount) is then booked as ONE
-- additional ledger entry + balance move, so the buyer's balance_due and the books
-- reflect the TRUE grand total. Everything happens in ONE RPC transaction, so a
-- half-finalized bill can never be left behind.
--
-- This migration adds:
--   1. order_bills   — the per-order bill breakdown (subtotal/discount/charges/
--                      grand_total), shown on the invoice. Owner-managed; buyers
--                      read their own through customer_bills (buyer-safe view).
--   2. charge_rules  — Settings engine: auto-suggest shipping/packing by buyer
--                      type and order value / quantity. Owner-only.
--   3. approve_order() RPC — the single shopfront-approval write path.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. order_bills — one row per approved order, holding the editable/presentational
--    charge breakdown. The immutable Sale still owns qty/rate/amount/profit
--    (#5/#6). grand_total is what the buyer actually owes for this order.
-- ---------------------------------------------------------------------------
create table if not exists public.order_bills (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops(id),
  order_id        uuid not null unique references public.orders(id) on delete cascade,
  sale_id         uuid references public.sales(id) on delete cascade,
  order_group_id  uuid,                                   -- cart grouping (018); null = single
  subtotal        numeric(14,2) not null default 0,       -- product amount before adjustments
  discount_amount numeric(14,2) not null default 0,       -- >= 0; margin loss
  shipping_fee    numeric(14,2) not null default 0,       -- >= 0; pass-through
  packing_fee     numeric(14,2) not null default 0,       -- >= 0; pass-through
  other_charge    numeric(14,2) not null default 0,       -- >= 0; pass-through
  grand_total     numeric(14,2) not null default 0,       -- subtotal - discount + shipping + packing + other
  notes           text,
  created_at      timestamptz not null default now(),
  check (discount_amount >= 0 and shipping_fee >= 0
         and packing_fee >= 0 and other_charge >= 0)
);
create index if not exists idx_order_bills_shop  on public.order_bills(shop_id);
create index if not exists idx_order_bills_group on public.order_bills(order_group_id)
  where order_group_id is not null;

alter table public.order_bills enable row level security;
-- Owner manages every bill in their shop. Buyers never read this table directly.
create policy order_bills_owner_all on public.order_bills for all
  using (auth_role() = 'owner' and shop_id = auth_shop_id())
  with check (auth_role() = 'owner' and shop_id = auth_shop_id());

-- Buyer-safe view: a buyer sees the charge breakdown of THEIR OWN orders only
-- (no cost/profit here — order_bills carries none). postgres-owned so it bypasses
-- base-table RLS; scoping is baked in via the join to the buyer's own order.
create or replace view public.customer_bills
with (security_invoker = false) as
select
  b.order_id, b.sale_id, b.subtotal, b.discount_amount, b.shipping_fee,
  b.packing_fee, b.other_charge, b.grand_total, b.notes, b.created_at
from public.order_bills b
join public.orders o on o.id = b.order_id
where o.buyer_id = auth.uid();
grant select on public.customer_bills to authenticated;

-- ---------------------------------------------------------------------------
-- 2. charge_rules — owner-configured auto-suggestions for shipping/packing.
--    The approval screen reads these and pre-fills the fee; the owner can always
--    override. A rule fires when the order matches its buyer type AND its
--    value/quantity condition; the highest applicable fee per charge type wins.
-- ---------------------------------------------------------------------------
create table if not exists public.charge_rules (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id),
  charge_type  text not null check (charge_type in ('shipping','packing')),
  applies_to   text not null default 'all'
               check (applies_to in ('all','customer','dealer')),
  basis        text not null check (basis in ('order_value','quantity')),
  operator     text not null check (operator in ('lt','lte','gte','gt','between')),
  threshold    numeric(14,2) not null default 0,
  threshold_hi numeric(14,2),                              -- only for 'between'
  fee          numeric(14,2) not null default 0,           -- flat amount, or % if is_percent
  is_percent   boolean not null default false,             -- fee is % of order value
  is_active    boolean not null default true,
  label        text,                                       -- e.g. "Free shipping over 2000"
  created_at   timestamptz not null default now(),
  check (fee >= 0),
  check (operator <> 'between' or threshold_hi is not null)
);
create index if not exists idx_charge_rules_shop on public.charge_rules(shop_id);

alter table public.charge_rules enable row level security;
create policy charge_rules_owner_all on public.charge_rules for all
  using (auth_role() = 'owner' and shop_id = auth_shop_id())
  with check (auth_role() = 'owner' and shop_id = auth_shop_id());

-- ---------------------------------------------------------------------------
-- 3. approve_order() — the single shopfront approval write path.
--    Mirrors create_counter_sale (014): SECURITY DEFINER, re-checks role/shop,
--    and does everything in one transaction. Steps:
--      a. Insert the Sale GROSS (amount = qty x rate_charged, unchanged), but
--         with profit reduced by the discount (honest #6). on_sale_insert then
--         drops stock, books the GROSS product udhaar + ledger, flips the order
--         to 'approved' and opens the fulfilment job — all as today.
--      b. Book the net non-product money (shipping+packing+other - discount) as
--         ONE extra ledger entry (+ balance move when udhaar), so balance_due and
--         the books equal the true grand total.
--      c. Record the breakdown in order_bills for the invoice.
--    Returns the new sale id.
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

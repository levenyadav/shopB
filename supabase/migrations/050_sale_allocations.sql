-- =============================================================================
-- 050_sale_allocations.sql — one sale may draw from several warehouses.
--
-- THE BUG. Stock is per warehouse (042 warehouse_stock) but every gate reasons
-- about the TOTAL (items.quantity, kept in sync by 043's trigger), while every
-- deduction hits exactly ONE warehouse (sales.warehouse_id -> 048's
-- adjust_warehouse_stock). With A=100 and B=150:
--   * the buyer is shown 250 and 047's order gate accepts an order for 250;
--   * approve_order then refuses it — no single warehouse holds 250 — and
--     OrderDetail disables the Approve button. The order can never be filled
--     even though the shop physically has the goods. A dead end (SPEC §3), and
--     the owner's only escape was hand-editing warehouse_stock in Inventory,
--     which fakes a stock move with no record of it.
--   * a Counter Sale of 250 is worse: CounterSale caps the line at the 250
--     total, then create_counter_sale -> on_sale_insert -> adjust_warehouse_stock
--     falls back to the item's default warehouse (048) and raises mid-bill,
--     killing the whole walk-in bill with a raw error staff cannot act on.
--
-- THE FIX. `sales.warehouse_id` being a single column is the root cause, so a
-- sale now records an allocation PER warehouse (sale_allocations) and the split
-- is computed server-side, automatically — nobody is asked to solve it:
--     250 needed  ->  100 from A + 150 from B
-- allocate_stock_out() fills from the preferred warehouse first (the owner's
-- pick on the approval screen, if any), then the product's default warehouse
-- (044/045), then the fullest warehouse, until the quantity is covered. It
-- calls adjust_warehouse_stock once per warehouse, so each location keeps its
-- own never-go-negative guard (043) and Golden Rules #1/#2/#10 are untouched:
-- stock still moves only through triggers, and the client still just inserts.
--
-- Both sale paths get this from ONE place: the split happens inside
-- on_sale_insert, which shopfront approval and create_counter_sale both go
-- through. create_counter_sale itself is NOT modified.
--
-- approve_order keeps its exact signature; p_warehouse_id stops being a
-- requirement and becomes a PREFERENCE ("start from this one"). The stock check
-- moves from "does this warehouse have enough" to "does the shop have enough",
-- which is the same question 047 already answers when the order is placed.
--
-- Staff finally get told where to pick: fulfilment_queue gains the per-warehouse
-- lines, so the pack card can read "Pick 100 from Warehouse A, 150 from B".
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. sale_allocations — which warehouses a sale actually drew from.
--    Append-only in practice: written by the trigger below, never by the app.
-- ---------------------------------------------------------------------------
create table if not exists public.sale_allocations (
  sale_id      uuid not null references public.sales(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id),
  quantity     numeric(14,2) not null check (quantity > 0),
  created_at   timestamptz not null default now(),
  primary key (sale_id, warehouse_id)
);
create index if not exists idx_sale_allocations_sale      on public.sale_allocations(sale_id);
create index if not exists idx_sale_allocations_warehouse on public.sale_allocations(warehouse_id);

comment on table public.sale_allocations is
  'Per-warehouse breakdown of one sale (050). Written only by allocate_stock_out() inside the sale trigger — never by client code. The authoritative record of where the goods left from; sales.warehouse_id is only the warehouse the owner preferred at approval.';

comment on column public.sales.warehouse_id is
  'Preferred warehouse for this sale (043, redefined by 050) — a starting hint for the auto-split, NOT where the stock actually came from. NULL for counter sales and made-to-order. The real, possibly multi-warehouse breakdown lives in sale_allocations.';

alter table public.sale_allocations enable row level security;

-- Same shape as warehouse_stock (042/043): owner reads everything in the shop,
-- staff read too — no cost or profit lives here, so Golden Rule #4 is safe.
-- Nobody gets INSERT/UPDATE/DELETE: the SECURITY DEFINER trigger writes it.
drop policy if exists sale_allocations_owner_select on public.sale_allocations;
drop policy if exists sale_allocations_staff_select on public.sale_allocations;

create policy sale_allocations_owner_select on public.sale_allocations for select
  using (
    auth_role() = 'owner'
    and exists (select 1 from public.warehouses w
                 where w.id = warehouse_id and w.shop_id = auth_shop_id())
  );
create policy sale_allocations_staff_select on public.sale_allocations for select
  using (
    auth_role() = 'staff'
    and exists (select 1 from public.warehouses w
                 where w.id = warehouse_id and w.shop_id = auth_shop_id())
  );

-- ---------------------------------------------------------------------------
-- 2. allocate_stock_out() — the auto-split. Takes the whole quantity out of as
--    many warehouses as it needs, recording each slice.
--
--    Fill order (auto only — there is deliberately no manual override):
--      1. the preferred warehouse    (owner's pick on the approval screen)
--      2. the product's default      (items.warehouse_id — 044/045)
--      3. fullest warehouse first     (keeps small pockets of stock intact,
--                                      so one warehouse is emptied last)
--    Ties break on warehouse name so the result is deterministic.
--
--    Raises ONE clear, shop-language error if the shop as a whole is short —
--    the same sentence for both sale paths, and it names the shortfall so the
--    owner knows what to do next (SPEC §3: errors say how to fix it).
-- ---------------------------------------------------------------------------
create or replace function public.allocate_stock_out(
  p_sale_id             uuid,
  p_item_id             uuid,
  p_preferred_warehouse uuid,
  p_quantity            numeric
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_remaining numeric(14,2) := round(coalesce(p_quantity, 0), 2);
  v_available numeric(14,2);
  v_item_wh   uuid;
  v_item_name text;
  v_take      numeric(14,2);
  v_row       record;
begin
  if v_remaining <= 0 then
    raise exception 'Sale quantity must be more than zero.';
  end if;

  select name, warehouse_id into v_item_name, v_item_wh
    from public.items where id = p_item_id;

  select coalesce(sum(quantity), 0) into v_available
    from public.warehouse_stock
   where item_id = p_item_id and quantity > 0;

  if v_available < v_remaining then
    raise exception 'Not enough stock of %: % in all warehouses together, % needed. Add stock via Purchase Entry.',
      coalesce(v_item_name, 'this item'), v_available, v_remaining;
  end if;

  for v_row in
    select warehouse_id, quantity
      from public.warehouse_stock
     where item_id = p_item_id and quantity > 0
     order by coalesce(warehouse_id = p_preferred_warehouse, false) desc,
              coalesce(warehouse_id = v_item_wh, false) desc,
              quantity desc,
              warehouse_id
  loop
    exit when v_remaining <= 0;
    v_take := least(v_remaining, v_row.quantity);

    -- One call per warehouse: each keeps its own negative guard (043/048).
    perform public.adjust_warehouse_stock(p_item_id, v_row.warehouse_id, -v_take);

    insert into public.sale_allocations (sale_id, warehouse_id, quantity)
    values (p_sale_id, v_row.warehouse_id, v_take)
    on conflict (sale_id, warehouse_id)
      do update set quantity = public.sale_allocations.quantity + excluded.quantity;

    v_remaining := v_remaining - v_take;
  end loop;

  -- Unreachable unless warehouse_stock moved under us mid-transaction; belt and
  -- braces so a sale can never be booked with stock left unallocated.
  if v_remaining > 0 then
    raise exception 'Could not allocate % of % from any warehouse.',
      v_remaining, coalesce(v_item_name, 'this item');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. on_sale_insert — 049's body with the single-warehouse deduction replaced
--    by the auto-split. Everything else (udhaar, ledger, order status, the
--    pack queue for BOTH sources) is byte-for-byte 049.
--
--    This is the one place both paths share, so the shopfront approval and
--    create_counter_sale (untouched) now both split automatically.
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

  -- Made-to-order carries no stock; everything else is auto-split across as
  -- many warehouses as the quantity needs (050). new.warehouse_id is only a
  -- preference now — NULL (counter sale) simply means "no preference".
  if not v_mto then
    perform public.allocate_stock_out(new.id, new.item_id, new.warehouse_id, new.quantity);
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

  update public.orders set status = 'approved' where id = new.order_id;

  insert into public.fulfilment (shop_id, order_id, sale_id, status)
  values (new.shop_id, new.order_id, new.id, 'pending_pack');

  return new;
end $$;
-- trg_sale_insert (002) already binds on_sale_insert(); redefining is enough.

-- ---------------------------------------------------------------------------
-- 4. approve_order — 046's body, with the per-warehouse gate replaced by a
--    shop-wide one. Signature unchanged (no drop/regrant needed), and
--    p_warehouse_id is now optional: it steers the split, it no longer limits
--    it. Old callers that pass a warehouse keep working unchanged; that
--    warehouse is simply filled from first.
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
  p_warehouse_id uuid    default null    -- PREFERRED warehouse only (050)
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
  v_available numeric(14,2);
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
end $$;

grant execute on function
  public.approve_order(uuid, text, numeric, numeric, numeric, numeric, numeric, text, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 5. fulfilment_queue — tell staff WHERE to pick from. 008's view exposed only
--    items.location (a display label); a split job was impossible to pack
--    correctly because nothing said the goods sit in two places.
--
--    `allocations` is a jsonb array [{warehouse, quantity}, ...], warehouse
--    name included so the board needs no extra query and no read on
--    warehouses. The view stays postgres-owned (security_invoker = false) with
--    the role gate in the WHERE clause, exactly as 008 built it — so staff can
--    see the pick lines without any new base-table grant. Empty array for
--    made-to-order and for sales booked before this migration.
-- ---------------------------------------------------------------------------
create or replace view public.fulfilment_queue
with (security_invoker = false) as
select
  f.id, f.shop_id, f.order_id, f.sale_id, f.status,
  f.packed_at, f.completed_at, f.delivery_note, f.created_at,
  o.quantity, o.rate_at_order, o.amount, o.notes, o.buyer_type,
  o.created_at as ordered_at,
  i.name as item_name, i.item_no, i.location, i.photo_url,
  b.full_name as buyer_name, b.phone as buyer_phone,
  s.payment_type,
  coalesce(a.allocations, '[]'::jsonb) as allocations
from public.fulfilment f
join public.orders   o on o.id = f.order_id
join public.items    i on i.id = o.item_id
join public.profiles b on b.id = o.buyer_id
left join public.sales s on s.id = f.sale_id
left join lateral (
  select jsonb_agg(jsonb_build_object('warehouse', w.name, 'quantity', sa.quantity)
                   order by sa.quantity desc, w.name) as allocations
    from public.sale_allocations sa
    join public.warehouses w on w.id = sa.warehouse_id
   where sa.sale_id = f.sale_id
) a on true
where public.auth_role() in ('owner','staff')
  and f.shop_id = public.auth_shop_id();

grant select on public.fulfilment_queue to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Backfill. Sales that recorded a warehouse drew it all from that one, so
--    their allocation is known exactly. Counter and legacy sales
--    (warehouse_id IS NULL) had their warehouse resolved inside the trigger and
--    never written down — we do NOT invent one for them; their pack cards fall
--    back to items.location as before.
-- ---------------------------------------------------------------------------
insert into public.sale_allocations (sale_id, warehouse_id, quantity, created_at)
select s.id, s.warehouse_id, s.quantity, s.created_at
  from public.sales s
  join public.items i on i.id = s.item_id
 where s.warehouse_id is not null
   and coalesce(i.made_to_order, false) = false
   and s.quantity > 0
on conflict (sale_id, warehouse_id) do nothing;

-- =============================================================================
-- 027_staff_screens.sql — staff Inventory & Stock Inquiry + "Packed by" name
--
-- SPEC §9.1/§10.3: staff need to SEE inventory and stock levels (to organise
-- racks and flag reorders) but must NEVER see cost economics (purchase_rate /
-- profit). RLS is row-level, not column-level, so a plain select on items would
-- still expose purchase_rate. Follow the same column-safe, postgres-owned view
-- pattern as shopfront_items / fulfilment_queue (008): expose ONLY the
-- packing-relevant fields and never purchase_rate or profit.
--
-- Also stamp WHO packed each order so owner + buyer can see it (SPEC §6.6).
-- =============================================================================

-- --- Column-safe staff item view (no purchase_rate / profit) -----------------
-- postgres-owned (security_invoker = false) so it bypasses base-table RLS; the
-- role gate lives in the WHERE clause — only owner/staff of the shop get rows.
create or replace view public.staff_items
with (security_invoker = false) as
select
  i.id, i.shop_id, i.item_no, i.name, i.category_id,
  c.name as category_name,
  i.location, i.quantity, i.low_stock_threshold,
  i.dealer_rate, i.rate, i.photo_url, i.created_at
from public.items i
left join public.categories c on c.id = i.category_id
where public.auth_role() in ('owner', 'staff')
  and i.shop_id = public.auth_shop_id()
  and i.is_active = true;

grant select on public.staff_items to authenticated;

-- --- "Packed by" name on the order (SPEC §6.6) -------------------------------
alter table public.orders add column if not exists packed_by_name text;

-- Recreate the fulfilment status trigger (latest def: 008) to ALSO stamp the
-- packer's name. fulfilment.packed_by is set by staff when they mark a job
-- packed (006 RLS); resolve it to a display name once, on the order.
create or replace function public.on_fulfilment_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'packed' then
      new.packed_at := now();
      update public.orders
         set status = 'packed',
             packed_by_name = (select full_name from public.profiles where id = new.packed_by)
       where id = new.order_id;
    elsif new.status = 'delivered' then
      new.completed_at := now();
      update public.orders set status = 'delivered' where id = new.order_id;
    elsif new.status = 'picked_up' then
      new.completed_at := now();
      update public.orders set status = 'picked_up' where id = new.order_id;
    end if;
  end if;
  return new;
end $$;

-- Surface the packer's name on the live board too. NOTE: create-or-replace can
-- only APPEND columns to an existing view, so packed_by_name goes last.
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
  pk.full_name as packed_by_name
from public.fulfilment f
join public.orders   o on o.id = f.order_id
join public.items    i on i.id = o.item_id
join public.profiles b on b.id = o.buyer_id
left join public.sales    s  on s.id  = f.sale_id
left join public.profiles pk on pk.id = f.packed_by
where public.auth_role() in ('owner', 'staff')
  and f.shop_id = public.auth_shop_id();

grant select on public.fulfilment_queue to authenticated;

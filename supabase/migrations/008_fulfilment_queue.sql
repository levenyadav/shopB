-- =============================================================================
-- 008_fulfilment_queue.sql — safe packing queue + live board (SPEC §6.6, §13.1)
--
-- The Fulfilment screen must show each job's buyer name (§6.6) and the supply
-- slip needs the payment type (§13.1). But staff have NO select on profiles or
-- sales (003 RLS) — only owner does. Rather than widen those policies (which
-- would also expose balance_due / sale economics), apply the same fix as
-- shopfront_items: a column-safe view that exposes ONLY packing-relevant fields
-- and never purchase_rate, profit or balance_due.
--
-- The view is postgres-owned (security_invoker = false) so it bypasses base-table
-- RLS — therefore the role gate is baked into the WHERE clause: only owner/staff
-- of the shop get rows; customers/dealers get none. auth_role()/auth_shop_id()
-- are the SECURITY DEFINER helpers from 003.
-- =============================================================================

create or replace view public.fulfilment_queue
with (security_invoker = false) as
select
  f.id, f.shop_id, f.order_id, f.sale_id, f.status,
  f.packed_at, f.completed_at, f.delivery_note, f.created_at,
  o.quantity, o.rate_at_order, o.amount, o.notes, o.buyer_type,
  o.created_at as ordered_at,
  i.name as item_name, i.item_no, i.location, i.photo_url,
  b.full_name as buyer_name, b.phone as buyer_phone,
  s.payment_type
from public.fulfilment f
join public.orders   o on o.id = f.order_id
join public.items    i on i.id = o.item_id
join public.profiles b on b.id = o.buyer_id
left join public.sales s on s.id = f.sale_id
where public.auth_role() in ('owner','staff')
  and f.shop_id = public.auth_shop_id();

grant select on public.fulfilment_queue to authenticated;

-- Live packing board: an approval inserts a fulfilment row; status changes as
-- staff pack/deliver. Realtime still honours RLS on the base table, so each role
-- only receives rows for its own shop (fulfilment_owner_all / _staff_select).
alter publication supabase_realtime add table public.fulfilment;

-- ---------------------------------------------------------------------------
-- Refine §8.6: also flip the ORDER to 'packed' when its fulfilment is packed.
-- 002's version only stamped packed_at, so orders.status 'packed' was never
-- reachable — the OrderManagement "Packed" filter matched nothing and the buyer
-- tracker never lit the "Packed" step until delivery. Mirror the delivered /
-- picked_up branches, which already update the order.
-- ---------------------------------------------------------------------------
create or replace function public.on_fulfilment_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'packed' then
      new.packed_at := now();
      update public.orders set status = 'packed' where id = new.order_id;
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

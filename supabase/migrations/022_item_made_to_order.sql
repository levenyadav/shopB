-- =============================================================================
-- 022_item_made_to_order.sql — "Made to Order" items (on-demand / booking).
--
-- Some products are not held as stock: the owner lists them, and only sources or
-- makes them AFTER a buyer books an order. A card/box shop takes many such custom
-- and bulk orders. These items must:
--   * stay on the shopfront even at quantity 0 (there is no stock to run down);
--   * accept ANY order quantity a customer/dealer asks for (not capped by stock);
--   * NOT move items.quantity when the sale is booked (nothing to count).
--
-- Everything else is unchanged: a made-to-order purchase is still a normal
-- shopfront order that the owner approves/rejects, which still creates a Sale via
-- the existing trigger, still logs profit, udhaar and the ledger, and still opens
-- a fulfilment job (Golden Rules #2, #3, #6, #9, #10 all hold).
--
-- Cost is entered by the owner AT APPROVAL (they know the true cost by then), so
-- items.purchase_rate is only a placeholder for these rows — the real cost lands
-- on the sale via the approval screen.
--
-- Additive with a safe default, so every existing row stays a normal stock item.
-- =============================================================================

alter table public.items
  add column if not exists made_to_order boolean not null default false;

comment on column public.items.made_to_order is
  'Made-to-Order (on-demand): sourced/made only after a buyer books. Always shown on the shopfront (even at quantity 0), orderable in any quantity, and its stock is NOT decremented when a sale is booked (see on_sale_insert). Cost is set by the owner at approval.';

-- ---------------------------------------------------------------------------
-- Rebuild the buyer-facing view so made-to-order items reach the shopfront even
-- with quantity 0. Column list MUST match the live view exactly and may only
-- APPEND (42P16 otherwise) — last set in 020: +discontinued gate, columns from
-- 016. We append made_to_order and widen the stock gate. purchase_rate is still
-- never selected (Golden Rule #4).
-- ---------------------------------------------------------------------------
create or replace view public.shopfront_items
with (security_invoker = false) as
select
  i.id, i.shop_id, i.item_no, i.name, i.category_id,
  i.quantity, i.dealer_rate, i.rate, i.photo_url,
  i.low_stock_threshold, i.created_at,
  i.moq, i.description, i.tags, i.images,
  i.hsn_sac,
  i.made_to_order
from public.items i
where i.is_active = true
  and i.discontinued = false
  and (i.quantity > 0 or i.made_to_order = true);

grant select on public.shopfront_items to anon, authenticated;

-- ---------------------------------------------------------------------------
-- §8.2 sale trigger — skip the stock decrement for made-to-order items. One
-- statement handles both kinds: normal items still drop stock exactly as before;
-- made-to-order items keep quantity untouched. Covers shopfront AND counter sales
-- (both insert into sales), so a made-to-order line never drives stock negative.
-- The rest of the function (udhaar, ledger, order status, fulfilment) is unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.on_sale_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare buyer_bal numeric(14,2) := 0; item_name text;
begin
  update public.items
     set quantity = case when made_to_order then quantity else quantity - new.quantity end
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
          coalesce(buyer_bal,0), 'Sale: ' || coalesce(item_name,'item'));

  update public.orders set status = 'approved' where id = new.order_id;

  insert into public.fulfilment (shop_id, order_id, sale_id, status)
  values (new.shop_id, new.order_id, new.id, 'pending_pack');
  return new;
end $$;

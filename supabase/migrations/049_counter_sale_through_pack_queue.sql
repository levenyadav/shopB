-- =============================================================================
-- 049_counter_sale_through_pack_queue.sql — counter sales now flow like shopfront
-- orders: approve → pack → hand over.
--
-- BACKGROUND. Since 014 a counter (POS) bill was "complete on creation": the
-- goods were assumed handed over at the counter, so on_sale_insert marked the
-- order 'picked_up' and wrote an already-completed fulfilment row (046 restored
-- that branch after 022/043 lost it). The shop now wants counter bills to be
-- packed and handed over through the same Fulfilment board as shopfront orders
-- — e.g. the buyer pays now and collects (or has delivered) a packed order
-- later.
--
-- THE CHANGE. on_sale_insert's counter branch is aligned with the shopfront
-- branch for the two fields that differed:
--   * orders.status      : 'approved'      (was 'picked_up')
--   * fulfilment.status   : 'pending_pack'  (was 'picked_up', pre-stamped done)
-- Everything else is untouched and still identical for both sources — stock
-- drop, udhaar balance, the append-only ledger entry (its wording still says
-- "Counter sale: …" vs "Sale: …"). Staff still finalize a walk-in bill without
-- the owner: create_counter_sale is unchanged, the act of ringing it up is
-- still the approval. Only the packing step is added.
--
-- NOT BACKFILLED. Counter fulfilment rows already 'picked_up' were genuinely
-- handed over under the old rule — they stay done. This only affects counter
-- bills rung up from here on.
--
-- Golden Rules: #2 stock still moves only through this trigger; #3 counter is
-- still staff-finalizable (this narrows the "skip the pack queue" carve-out,
-- nothing else); #4/#6 cost/profit untouched; #9/#10 ledger still trigger-only.
-- =============================================================================

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

  -- Made-to-order carries no stock; everything else draws from its warehouse
  -- (NULL warehouse -> Main Warehouse, and a negative result raises — 043).
  if not v_mto then
    perform public.adjust_warehouse_stock(new.item_id, new.warehouse_id, -new.quantity);
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

  -- Both sources now: sale recorded -> order 'approved', awaiting the pack step.
  update public.orders set status = 'approved' where id = new.order_id;

  -- Both sources now: fulfilment opens as 'pending_pack' on the staff board.
  insert into public.fulfilment (shop_id, order_id, sale_id, status)
  values (new.shop_id, new.order_id, new.id, 'pending_pack');

  return new;
end $$;
-- trg_sale_insert (002) already binds on_sale_insert(); redefining is enough.

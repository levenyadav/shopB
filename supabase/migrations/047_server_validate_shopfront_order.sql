-- =============================================================================
-- 047_server_validate_shopfront_order.sql — trust boundary for buyer orders.
--
-- THE HOLE. Cart.checkout (frontend) inserts `orders` rows with rate_at_order,
-- amount and buyer_type all computed in the browser. The RLS policy
-- orders_buyer_insert only checks buyer_id = auth.uid(), role and shop_id — it
-- never re-derives the money. approve_order() then books the sale straight from
-- v_ord.rate_at_order / v_ord.amount. So a hand-crafted POST can place an order
-- at rate_at_order = 1, and one-tap approval turns it into a real sale + ledger
-- entry at that price. buyer_type is likewise unchecked against the buyer's
-- actual profile role (a customer could claim dealer pricing).
--
-- THE FIX. A BEFORE INSERT trigger on `orders` that, for buyer-placed shopfront
-- orders, ignores the client's money fields and recomputes them from the live
-- item and the buyer's real role:
--   * buyer_type  := the buyer's profiles.role  (customer | dealer)
--   * rate_at_order := item.dealer_rate for dealers, else item.rate  (SPEC §12.2)
--   * amount        := round(quantity * rate_at_order, 2)
--   * quantity must be > 0 and a whole multiple of items.moq (015)
--   * normal items must have the stock; made-to-order accepts any quantity
--   * shop_id := the item's shop
-- Rate is still "locked at order time" (SPEC §12.2) — order time is this insert,
-- so using the current price here is exactly right; a stale browser tab can no
-- longer under- or over-price an order.
--
-- Counter orders (source='counter') are written by create_counter_sale, a
-- SECURITY DEFINER RPC that re-checks role/shop/buyer itself and where the owner
-- may deliberately override a line price (SPEC §6.5a). Those are left untouched.
--
-- Golden Rules unchanged: #4 (purchase_rate never read here), #5 (rate locked at
-- order time — now enforced, not trusted), #10 (the client still just inserts).
-- =============================================================================

create or replace function public.normalize_shopfront_order()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_item public.items%rowtype;
  v_role text;
  v_rate numeric(14,2);
  v_moq  numeric(14,2);
begin
  -- Only buyer-placed shopfront orders pass through here. Counter orders come
  -- from create_counter_sale (trusted) and carry source='counter'.
  if new.source is distinct from 'shopfront' then
    return new;
  end if;

  if new.item_id is null then
    raise exception 'Order must name an item.';
  end if;
  select * into v_item from public.items where id = new.item_id;
  if not found then
    raise exception 'That item no longer exists.';
  end if;
  if not v_item.is_active then
    raise exception 'That item is not available right now.';
  end if;

  -- Buyer type is whatever the buyer's profile says — never the client's word.
  select role into v_role from public.profiles where id = new.buyer_id;
  if v_role is null or v_role not in ('customer','dealer') then
    raise exception 'Only a customer or dealer can place an order.';
  end if;
  new.buyer_type := v_role;

  -- Current tier price, locked now (SPEC §12.2).
  v_rate := case when v_role = 'dealer'
                 then coalesce(v_item.dealer_rate, v_item.rate)
                 else v_item.rate end;
  if v_rate is null or v_rate <= 0 then
    raise exception 'That item has no price set. Ask the shop.';
  end if;

  -- Quantity: positive whole multiple of the item's MOQ (migration 015).
  v_moq := greatest(coalesce(v_item.moq, 1), 1);
  if new.quantity is null or new.quantity <= 0 then
    raise exception 'Enter how many you want.';
  end if;
  if mod(new.quantity, v_moq) <> 0 then
    raise exception 'This item is sold in packs of %. Order a multiple of that.', v_moq;
  end if;

  -- Stock gate for normal items; made-to-order is produced on demand.
  if not v_item.made_to_order and coalesce(v_item.quantity, 0) < new.quantity then
    raise exception 'Only % left in stock.', coalesce(v_item.quantity, 0);
  end if;

  new.shop_id       := v_item.shop_id;
  new.rate_at_order := v_rate;
  new.amount        := round(new.quantity * v_rate, 2);
  return new;
end $$;

drop trigger if exists trg_order_normalize on public.orders;
create trigger trg_order_normalize
  before insert on public.orders
  for each row execute function public.normalize_shopfront_order();

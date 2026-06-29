-- =============================================================================
-- 002_create_triggers.sql — automation (SPEC §8)
-- All trigger functions are SECURITY DEFINER so they can mutate stock/balances
-- and write the append-only ledger regardless of the caller's RLS.
-- running_balance is set to the party's balance_due AFTER the event.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- updated_at touch helper
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger trg_profiles_touch  before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger trg_suppliers_touch before update on public.suppliers
  for each row execute function public.touch_updated_at();
create trigger trg_items_touch     before update on public.items
  for each row execute function public.touch_updated_at();
create trigger trg_orders_touch    before update on public.orders
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Auto item_no:  SHOP-0001, SHOP-0002, ... per shop (replaces edge fn §14.2)
-- ---------------------------------------------------------------------------
create or replace function public.set_item_no()
returns trigger language plpgsql security definer set search_path = public as $$
declare nextn int;
begin
  if new.item_no is null or new.item_no = '' then
    select coalesce(max((regexp_replace(item_no,'\D','','g'))::int), 0) + 1
      into nextn
      from public.items
      where shop_id = new.shop_id and item_no ~ '^SHOP-\d+$';
    new.item_no := 'SHOP-' || lpad(nextn::text, 4, '0');
  end if;
  return new;
end $$;

create trigger trg_items_set_no before insert on public.items
  for each row execute function public.set_item_no();

-- ---------------------------------------------------------------------------
-- §8.1  After INSERT on purchases
-- ---------------------------------------------------------------------------
create or replace function public.on_purchase_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare sup_bal numeric(14,2); item_name text;
begin
  update public.items
     set quantity = quantity + new.quantity
   where id = new.item_id
   returning name into item_name;

  update public.suppliers
     set balance_due = balance_due + new.total_cost
   where id = new.supplier_id
   returning balance_due into sup_bal;

  insert into public.ledger (shop_id, entry_type, party_id, party_type,
                             reference_id, reference_table, debit, credit,
                             running_balance, description)
  values (new.shop_id, 'purchase', new.supplier_id, 'supplier',
          new.id, 'purchases', new.total_cost, 0,
          sup_bal, 'Purchase: ' || coalesce(item_name,'item'));
  return new;
end $$;

create trigger trg_purchase_insert after insert on public.purchases
  for each row execute function public.on_purchase_insert();

-- ---------------------------------------------------------------------------
-- §8.2  After INSERT on sales
-- ---------------------------------------------------------------------------
create or replace function public.on_sale_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare buyer_bal numeric(14,2) := 0; item_name text;
begin
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
          coalesce(buyer_bal,0), 'Sale: ' || coalesce(item_name,'item'));

  update public.orders set status = 'approved' where id = new.order_id;

  insert into public.fulfilment (shop_id, order_id, sale_id, status)
  values (new.shop_id, new.order_id, new.id, 'pending_pack');
  return new;
end $$;

create trigger trg_sale_insert after insert on public.sales
  for each row execute function public.on_sale_insert();

-- ---------------------------------------------------------------------------
-- §8.3 / §8.4  After INSERT on payments
-- ---------------------------------------------------------------------------
create or replace function public.on_payment_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare new_bal numeric(14,2);
begin
  if new.direction = 'in' then
    update public.profiles
       set balance_due = balance_due - new.amount
     where id = new.party_id
     returning balance_due into new_bal;

    insert into public.ledger (shop_id, entry_type, party_id, party_type,
                               reference_id, reference_table, debit, credit,
                               running_balance, description)
    values (new.shop_id, 'payment_in', new.party_id, new.party_type,
            new.id, 'payments', new.amount, 0,
            coalesce(new_bal,0), 'Payment received: ' || new.method);
  else
    update public.suppliers
       set balance_due = balance_due - new.amount
     where id = new.party_id
     returning balance_due into new_bal;

    insert into public.ledger (shop_id, entry_type, party_id, party_type,
                               reference_id, reference_table, debit, credit,
                               running_balance, description)
    values (new.shop_id, 'payment_out', new.party_id, 'supplier',
            new.id, 'payments', 0, new.amount,
            coalesce(new_bal,0), 'Payment made: ' || new.method);
  end if;
  return new;
end $$;

create trigger trg_payment_insert after insert on public.payments
  for each row execute function public.on_payment_insert();

-- ---------------------------------------------------------------------------
-- §8.6  After UPDATE on fulfilment (status changes -> timestamps + order status)
-- ---------------------------------------------------------------------------
create or replace function public.on_fulfilment_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'packed' then
      new.packed_at := now();
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

create trigger trg_fulfilment_status before update on public.fulfilment
  for each row execute function public.on_fulfilment_status();

-- ---------------------------------------------------------------------------
-- Auth: auto-create a profile when a new auth user signs up.
-- role + full_name read from signup metadata; shop defaults to the single shop.
-- Owner/staff are promoted manually (we never let signup self-assign 'owner').
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare default_shop uuid; want_role text;
begin
  select id into default_shop from public.shops order by created_at limit 1;

  want_role := coalesce(new.raw_user_meta_data->>'role', 'customer');
  if want_role not in ('customer','dealer') then
    want_role := 'customer';   -- signup may only self-assign customer/dealer
  end if;

  insert into public.profiles (id, shop_id, full_name, phone, role)
  values (new.id, default_shop,
          coalesce(new.raw_user_meta_data->>'full_name', ''),
          new.phone, want_role);
  return new;
end $$;

create trigger trg_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

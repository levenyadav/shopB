-- =============================================================================
-- 004_seed_data.sql — starter business data (idempotent: only seeds if empty).
-- No profiles/orders/sales here — those arrive once the owner signs up via Auth
-- (a profile is auto-created by handle_new_user, then promoted to 'owner').
-- item_no is left blank so the set_item_no trigger assigns SHOP-0001, 0002, ...
-- =============================================================================

do $$
declare
  v_shop uuid;
  c_cards uuid; c_boxes uuid; c_paper uuid; c_decor uuid;
  s_sigra uuid; s_kcm uuid;
begin
  if exists (select 1 from public.shops) then
    raise notice 'shops already present — skipping seed';
    return;
  end if;

  insert into public.shops (name, address, phone)
  values ('Shree Card & Gift House', 'Main Bazaar, Varanasi', '+91 90000 00000')
  returning id into v_shop;

  insert into public.categories (shop_id, name, type) values
    (v_shop, 'Greeting Cards', 'finished_good') returning id into c_cards;
  insert into public.categories (shop_id, name, type) values
    (v_shop, 'Gift Boxes', 'finished_good') returning id into c_boxes;
  insert into public.categories (shop_id, name, type) values
    (v_shop, 'Paper & Raw Material', 'raw_material') returning id into c_paper;
  insert into public.categories (shop_id, name, type) values
    (v_shop, 'Decor (Resale)', 'resale') returning id into c_decor;

  insert into public.suppliers (shop_id, name, contact_person, phone) values
    (v_shop, 'Sigra Traders', 'Ramesh', '+91 90111 11111') returning id into s_sigra;
  insert into public.suppliers (shop_id, name, contact_person, phone) values
    (v_shop, 'KCM Distributors', 'Anil', '+91 90222 22222') returning id into s_kcm;

  insert into public.items
    (shop_id, item_no, name, supplier_id, category_id, location,
     quantity, purchase_rate, dealer_rate, rate, low_stock_threshold)
  values
    (v_shop, '', 'Wedding Card - Royal Red', s_sigra, c_cards, 'R1-A',
     120, 18, 25, 35, 30),
    (v_shop, '', 'Birthday Card - Balloons', s_sigra, c_cards, 'R1-B',
     8, 6, 10, 15, 20),
    (v_shop, '', 'Gift Box - Medium Kraft', s_kcm, c_boxes, 'R2-A',
     60, 22, 30, 45, 15),
    (v_shop, '', 'Gift Box - Large Premium', s_kcm, c_boxes, 'R2-B',
     0, 40, 55, 80, 10),
    (v_shop, '', 'Art Paper Sheet A3', s_sigra, c_paper, 'R3-A',
     500, 2, 3, 5, 100),
    (v_shop, '', 'Decorative Ribbon Roll', s_kcm, c_decor, 'R4-A',
     35, 12, 18, 28, 25);

  raise notice 'Seed complete for shop %', v_shop;
end $$;

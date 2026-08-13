-- Functional test for migration 039 (edit_purchase_bill).
--
-- Run it against a SCRATCH database only — it wipes every table it touches.
-- Never point it at the live shop.
--
--   createdb shopb_migtest
--   psql -d shopb_migtest -f <stub auth schema: auth.users + auth.uid()>
--   for f in supabase/migrations/0*.sql; do psql -d shopb_migtest -f "$f"; done
--   psql -d shopb_migtest -f supabase/tests_039_edit_purchase_bill.sql
--
-- Covers: entering a bill is unchanged; an edit that would take stock negative
-- is refused and changes nothing; staff cannot edit; a real edit (modify, cut,
-- add a product, change postage/GST) lands the right stock, balance, catalogue
-- cost and exactly ONE ledger correction; removing a line credits it back; a
-- legacy ungrouped bill can be edited; an empty bill is refused.
\set ON_ERROR_STOP on

-- ── helpers ────────────────────────────────────────────────────────────────
create or replace function pg_temp.assert_eq(label text, got numeric, want numeric)
returns void language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL %: got %, want %', label, got, want;
  end if;
  raise notice 'ok  % = %', label, got;
end $$;

create or replace function pg_temp.assert_txt(label text, got text, want text)
returns void language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL %: got %, want %', label, got, want;
  end if;
  raise notice 'ok  % = %', label, got;
end $$;

-- ── setup ──────────────────────────────────────────────────────────────────
-- Teardown must not fire the guards (a leftover bill from the previous run has
-- "sold" stock behind it, and the delete trigger rightly refuses).
set session_replication_role = replica;
delete from public.ledger;
delete from public.purchase_bills;
delete from public.purchases;
delete from public.items;
delete from public.suppliers;
delete from public.categories;
delete from public.profiles;
delete from auth.users;
delete from public.shops;
set session_replication_role = origin;

insert into public.shops (id, name) values ('11111111-1111-1111-1111-111111111111', 'Test Shop');
insert into auth.users (id) values ('22222222-2222-2222-2222-222222222222'),
                                   ('22222222-2222-2222-2222-222222222223');
-- handle_new_user() already made a customer profile for each auth user.
insert into public.profiles (id, shop_id, full_name, role) values
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Owner', 'owner'),
  ('22222222-2222-2222-2222-222222222223', '11111111-1111-1111-1111-111111111111', 'Staff', 'staff')
on conflict (id) do update set shop_id = excluded.shop_id,
                               full_name = excluded.full_name,
                               role = excluded.role;
insert into public.categories (id, shop_id, name) values
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Cards');
insert into public.suppliers (id, shop_id, name) values
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'Sharma Traders');

insert into public.items (id, shop_id, item_no, name, supplier_id, category_id,
                          quantity, purchase_rate, dealer_rate, rate) values
  ('55555555-5555-5555-5555-555555555551', '11111111-1111-1111-1111-111111111111', 'SHOP-0001', 'Item A', '44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 0, 10, 15, 20),
  ('55555555-5555-5555-5555-555555555552', '11111111-1111-1111-1111-111111111111', 'SHOP-0002', 'Item B', '44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 0, 20, 30, 40),
  ('55555555-5555-5555-5555-555555555553', '11111111-1111-1111-1111-111111111111', 'SHOP-0003', 'Item C', '44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 0, 30, 45, 60);

set app.test_uid = '22222222-2222-2222-2222-222222222222';

-- ── enter a bill the normal way (two lines in ONE statement, then charges) ──
insert into public.purchases (shop_id, item_id, supplier_id, quantity, purchase_rate,
                              total_cost, entered_by, invoice_no, invoice_date, purchase_group_id)
values
  ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555551', '44444444-4444-4444-4444-444444444444', 100, 10, 1000, '22222222-2222-2222-2222-222222222222', 'INV-204', '2026-08-01', '66666666-6666-6666-6666-666666666666'),
  ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555552', '44444444-4444-4444-4444-444444444444', 50, 20, 1000, '22222222-2222-2222-2222-222222222222', 'INV-204', '2026-08-01', '66666666-6666-6666-6666-666666666666');

insert into public.purchase_bills (shop_id, supplier_id, purchase_group_id, goods_total,
                                   postage, cgst_amount, sgst_amount, grand_total)
values ('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444',
        '66666666-6666-6666-6666-666666666666', 2000, 100, 50, 50, 2200);

do $$ begin
  perform pg_temp.assert_eq('stock A after entry', (select quantity from public.items where item_no='SHOP-0001'), 100);
  perform pg_temp.assert_eq('stock B after entry', (select quantity from public.items where item_no='SHOP-0002'), 50);
  perform pg_temp.assert_eq('supplier balance after entry', (select balance_due from public.suppliers), 2200);
  perform pg_temp.assert_eq('ledger rows after entry', (select count(*) from public.ledger), 2);
end $$;

-- Simulate goods already sold: 60 of A, 10 of B.
update public.items set quantity = quantity - 60 where item_no = 'SHOP-0001';
update public.items set quantity = quantity - 10 where item_no = 'SHOP-0002';

-- ── TEST 1: an edit that would take stock negative must be refused ─────────
do $$
declare v_a uuid; v_msg text; v_ok boolean := false;
begin
  select id into v_a from public.purchases where item_id = '55555555-5555-5555-5555-555555555551';
  begin
    perform public.edit_purchase_bill(
      v_a,
      jsonb_build_array(jsonb_build_object('id', v_a, 'item_id', '55555555-5555-5555-5555-555555555551',
                                           'quantity', 80, 'purchase_rate', 12)),
      'INV-204', '2026-08-01'::date, 100, 50, 50, null);
  exception when others then
    v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok then raise exception 'FAIL: removing Item B should have been refused'; end if;
  raise notice 'ok  refused: %', v_msg;
end $$;

do $$ begin
  perform pg_temp.assert_eq('supplier balance unchanged after refusal', (select balance_due from public.suppliers), 2200);
  perform pg_temp.assert_eq('stock A unchanged after refusal', (select quantity from public.items where item_no='SHOP-0001'), 40);
end $$;

-- ── TEST 2: staff may not edit ────────────────────────────────────────────
set app.test_uid = '22222222-2222-2222-2222-222222222223';
do $$
declare v_a uuid; v_ok boolean := false;
begin
  select id into v_a from public.purchases where item_id = '55555555-5555-5555-5555-555555555551';
  begin
    perform public.edit_purchase_bill(v_a, jsonb_build_array(
      jsonb_build_object('id', v_a, 'item_id', '55555555-5555-5555-5555-555555555551',
                         'quantity', 80, 'purchase_rate', 12)), 'INV-204', null, 0, 0, 0, null);
  exception when others then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL: staff must not be able to edit a bill'; end if;
  raise notice 'ok  staff refused';
end $$;
set app.test_uid = '22222222-2222-2222-2222-222222222222';

-- A note already on the bill must survive a correction: the screen that edits a
-- bill has no bill-note field, so it sends none.
update public.purchase_bills set notes = 'paper bill in the red file';

-- ── TEST 3: a real edit — modify, reduce, add a product, change charges ───
do $$
declare v_a uuid; v_b uuid; v_res jsonb;
begin
  select id into v_a from public.purchases where item_id = '55555555-5555-5555-5555-555555555551';
  select id into v_b from public.purchases where item_id = '55555555-5555-5555-5555-555555555552';

  v_res := public.edit_purchase_bill(
    v_a,
    jsonb_build_array(
      jsonb_build_object('id', v_a, 'item_id', '55555555-5555-5555-5555-555555555551', 'quantity', 80, 'purchase_rate', 12),
      jsonb_build_object('id', v_b, 'item_id', '55555555-5555-5555-5555-555555555552', 'quantity', 40, 'purchase_rate', 20),
      jsonb_build_object('item_id', '55555555-5555-5555-5555-555555555553', 'quantity', 25, 'purchase_rate', 30, 'notes', 'missed off the bill')
    ),
    'INV-204A', '2026-08-02'::date, 150, 60, 60, 'corrected against the paper bill');

  raise notice 'edit result: %', v_res;
  perform pg_temp.assert_eq('reported old total', (v_res->>'old_total')::numeric, 2200);
  perform pg_temp.assert_eq('reported new total', (v_res->>'new_total')::numeric, 2780);
  perform pg_temp.assert_eq('reported difference', (v_res->>'difference')::numeric, 580);
  perform pg_temp.assert_eq('reported live lines', (v_res->>'lines')::numeric, 3);
end $$;

do $$ begin
  -- stock: A 40-20=20, B 40-10=30, C 0+25=25
  perform pg_temp.assert_eq('stock A after edit', (select quantity from public.items where item_no='SHOP-0001'), 20);
  perform pg_temp.assert_eq('stock B after edit', (select quantity from public.items where item_no='SHOP-0002'), 30);
  perform pg_temp.assert_eq('stock C after edit', (select quantity from public.items where item_no='SHOP-0003'), 25);
  -- money: goods 960+800+750 = 2510, charges 270 => 2780
  perform pg_temp.assert_eq('supplier balance after edit', (select balance_due from public.suppliers), 2780);
  perform pg_temp.assert_eq('goods on bill after edit',
    (select sum(total_cost) from public.purchases where purchase_group_id='66666666-6666-6666-6666-666666666666' and deleted_at is null), 2510);
  -- catalogue cost follows the corrected rate
  perform pg_temp.assert_eq('cost rate A updated', (select purchase_rate from public.items where item_no='SHOP-0001'), 12);
  perform pg_temp.assert_eq('cost rate B untouched', (select purchase_rate from public.items where item_no='SHOP-0002'), 20);
  -- ledger: original 2 + exactly ONE correction
  perform pg_temp.assert_eq('ledger rows after edit', (select count(*) from public.ledger), 3);
  perform pg_temp.assert_eq('correction debit', (select debit from public.ledger order by created_at desc, id limit 1), 580);
  perform pg_temp.assert_eq('correction credit', (select credit from public.ledger order by created_at desc, id limit 1), 0);
  perform pg_temp.assert_eq('correction running balance', (select running_balance from public.ledger order by created_at desc, id limit 1), 2780);
  perform pg_temp.assert_txt('correction description',
    (select description from public.ledger order by created_at desc, id limit 1), 'Bill corrected: Bill INV-204A (3 items)');
  -- header rewritten on every line
  perform pg_temp.assert_eq('invoice_no on all live lines',
    (select count(*) from public.purchases where purchase_group_id='66666666-6666-6666-6666-666666666666'
       and deleted_at is null and invoice_no='INV-204A' and invoice_date='2026-08-02'), 3);
  -- charges row corrected in place, not duplicated
  perform pg_temp.assert_eq('charges rows', (select count(*) from public.purchase_bills), 1);
  perform pg_temp.assert_eq('charges grand total', (select grand_total from public.purchase_bills), 2780);
  perform pg_temp.assert_txt('bill note replaced when one is passed',
    (select notes from public.purchase_bills), 'corrected against the paper bill');
end $$;

-- ── TEST 4: remove a line (soft delete), money and stock unwind ───────────
do $$
declare v_a uuid; v_b uuid; v_res jsonb;
begin
  select id into v_a from public.purchases where item_id = '55555555-5555-5555-5555-555555555551' and deleted_at is null;
  select id into v_b from public.purchases where item_id = '55555555-5555-5555-5555-555555555552' and deleted_at is null;
  v_res := public.edit_purchase_bill(
    v_a,
    jsonb_build_array(
      jsonb_build_object('id', v_a, 'item_id', '55555555-5555-5555-5555-555555555551', 'quantity', 80, 'purchase_rate', 12),
      jsonb_build_object('id', v_b, 'item_id', '55555555-5555-5555-5555-555555555552', 'quantity', 40, 'purchase_rate', 20)
    ),
    'INV-204A', '2026-08-02'::date, 150, 60, 60, null);
  raise notice 'removal result: %', v_res;
  perform pg_temp.assert_eq('difference on removal', (v_res->>'difference')::numeric, -750);
end $$;

do $$ begin
  perform pg_temp.assert_eq('stock C after removal', (select quantity from public.items where item_no='SHOP-0003'), 0);
  perform pg_temp.assert_eq('supplier balance after removal', (select balance_due from public.suppliers), 2030);
  perform pg_temp.assert_eq('removed line kept for audit',
    (select count(*) from public.purchases where item_id='55555555-5555-5555-5555-555555555553' and deleted_at is not null), 1);
  perform pg_temp.assert_eq('correction is a credit', (select credit from public.ledger order by created_at desc, id limit 1), 750);
  perform pg_temp.assert_eq('correction debit is zero', (select debit from public.ledger order by created_at desc, id limit 1), 0);
  perform pg_temp.assert_eq('ledger rows after removal', (select count(*) from public.ledger), 4);
  -- The screen that corrects a bill has no bill-note field and sends none; that
  -- must not wipe the note the bill already carries.
  perform pg_temp.assert_txt('bill note survives an edit that passes none',
    (select notes from public.purchase_bills), 'corrected against the paper bill');
end $$;

-- ── TEST 5: a legacy ungrouped bill can be edited ─────────────────────────
do $$
declare v_id uuid; v_res jsonb;
begin
  insert into public.purchases (shop_id, item_id, supplier_id, quantity, purchase_rate,
                                total_cost, entered_by)
  values ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555553',
          '44444444-4444-4444-4444-444444444444', 10, 30, 300, '22222222-2222-2222-2222-222222222222')
  returning id into v_id;

  perform pg_temp.assert_eq('legacy bill wrote its own ledger row', (select count(*) from public.ledger), 5);

  v_res := public.edit_purchase_bill(
    v_id,
    jsonb_build_array(jsonb_build_object('id', v_id, 'item_id', '55555555-5555-5555-5555-555555555553',
                                         'quantity', 12, 'purchase_rate', 30)),
    'OLD-1', null, 0, 0, 0, null);
  raise notice 'legacy result: %', v_res;
  perform pg_temp.assert_eq('legacy difference', (v_res->>'difference')::numeric, 60);
  perform pg_temp.assert_eq('legacy bill now grouped',
    (select count(*) from public.purchases where id = v_id and purchase_group_id is not null), 1);
end $$;

do $$ begin
  perform pg_temp.assert_eq('stock C after legacy edit', (select quantity from public.items where item_no='SHOP-0003'), 12);
  perform pg_temp.assert_eq('supplier balance after legacy edit', (select balance_due from public.suppliers), 2390);
end $$;

-- ── TEST 6: an empty bill is refused ──────────────────────────────────────
do $$
declare v_a uuid; v_ok boolean := false;
begin
  select id into v_a from public.purchases where item_id='55555555-5555-5555-5555-555555555551' and deleted_at is null;
  begin
    perform public.edit_purchase_bill(v_a, '[]'::jsonb, 'x', null, 0, 0, 0, null);
  exception when others then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL: an empty bill should be refused'; end if;
  raise notice 'ok  empty bill refused';
end $$;

-- ── TEST 7: entering a NEW bill still behaves exactly as before ───────────
do $$
declare v_before int; v_bal numeric;
begin
  select count(*) into v_before from public.ledger;
  select balance_due into v_bal from public.suppliers;
  insert into public.purchases (shop_id, item_id, supplier_id, quantity, purchase_rate,
                                total_cost, entered_by, invoice_no, purchase_group_id)
  values ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555551', '44444444-4444-4444-4444-444444444444', 5, 12, 60, '22222222-2222-2222-2222-222222222222', 'INV-999', '77777777-7777-7777-7777-777777777777'),
         ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555552', '44444444-4444-4444-4444-444444444444', 5, 20, 100, '22222222-2222-2222-2222-222222222222', 'INV-999', '77777777-7777-7777-7777-777777777777');
  insert into public.purchase_bills (shop_id, supplier_id, purchase_group_id, goods_total, postage, cgst_amount, sgst_amount, grand_total)
  values ('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', '77777777-7777-7777-7777-777777777777', 160, 40, 0, 0, 200);

  perform pg_temp.assert_eq('new bill wrote 2 ledger rows', (select count(*) from public.ledger) - v_before, 2);
  perform pg_temp.assert_eq('new bill raised balance by 200', (select balance_due from public.suppliers) - v_bal, 200);
end $$;

select 'ALL TESTS PASSED' as result;

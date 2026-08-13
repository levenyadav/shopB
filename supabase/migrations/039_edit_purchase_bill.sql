-- =============================================================================
-- 039_edit_purchase_bill.sql — correcting a supplier bill after it was entered.
--
-- Until now a purchase bill was write-once. Everything about the books assumed
-- it: stock and the supplier balance move on INSERT only (002 / 033), and the
-- ledger is append-only (Golden Rule #9). A typo in a quantity, a product keyed
-- onto the wrong bill, a line missed at the bottom of the paper invoice — none
-- of it could be fixed, and the owner's stock and supplier balance stayed wrong.
--
-- This migration makes a bill correctable WITHOUT weakening any of that:
--
--  * Stock and balances are still moved by TRIGGERS, never by the app
--    (Golden Rule #10). This adds the two triggers that were missing —
--    UPDATE and DELETE on purchases — so a line that changes or goes away
--    unwinds exactly what its INSERT did.
--
--  * The ledger is still append-only. An edit never rewrites the bill's
--    original ledger entry; it appends ONE correction entry for the
--    difference — debit when the bill grew, credit when it shrank. The
--    supplier's ledger therefore reads as a history of what happened, which
--    is the whole point of a ledger.
--
--  * Stock can never go negative. If some of the goods have already been sold,
--    an edit that would take an item below zero is REFUSED, naming the item and
--    the shortfall. Enforced in the trigger, so no code path can dodge it.
--
--  * A removed line is SOFT-deleted (deleted_at), never destroyed. Two reasons:
--    the bill stays auditable — you can see what was taken off it and when —
--    and, critically, the ledger's reference_id points at a real purchases row
--    (033 anchors a bill's entry on its FIRST line). Physically deleting that
--    row would leave the supplier's ledger with a link to nothing.
--
-- Owner only, any bill, however old. Every correction is visible in the ledger,
-- so nothing is hidden by allowing it.
--
-- COST RATE: when an edit changes a line's cost rate, the product's catalogue
-- cost (items.purchase_rate) is updated to match. Profit on FUTURE sales
-- (Golden Rule #6) therefore uses the corrected cost. Past sales are untouched —
-- they carry their own locked rate_at_order and purchase_rate.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Soft delete on a purchase line.
--
-- A deleted line counts for NOTHING: no stock, no money, not on the bill. It is
-- kept only as a record of what the bill used to say. Every read of `purchases`
-- that totals anything must filter `deleted_at is null`.
-- ---------------------------------------------------------------------------
alter table public.purchases
  add column if not exists deleted_at timestamptz;

comment on column public.purchases.deleted_at is
  'Set when a line is taken off its bill by an edit (039). The row is kept for audit and to keep ledger reference_ids valid; it contributes no stock and no money. NULL = a live line.';

create index if not exists purchases_live_idx
  on public.purchases (purchase_group_id)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 2. UPDATE / DELETE triggers on purchases.
--
-- The INSERT trigger (033) raises stock and the supplier balance. These two
-- unwind and re-apply that as a line changes, so the golden rules hold no
-- matter who does the writing — the RPC below, or an owner's direct SQL.
--
-- "Effective" quantity and cost are what the line is worth to the books right
-- now: zero once it is soft-deleted. Removing a line, restoring one, and simply
-- editing its numbers are then all the same arithmetic.
--
-- No ledger row is written here. A bill edit is ONE correction entry for the
-- whole bill, written by edit_purchase_bill() after all the lines have settled;
-- a row-by-row ledger would give the owner six entries for one correction.
-- ---------------------------------------------------------------------------
create or replace function public.on_purchase_update()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old_qty  numeric(14,2);
  v_new_qty  numeric(14,2);
  v_old_cost numeric(14,2);
  v_new_cost numeric(14,2);
  v_left     numeric(14,2);
  v_name     text;
begin
  -- Moving a bill to a different supplier would take money off one party and
  -- put it on another with a single ledger entry between them. That is not an
  -- edit, it is two transactions, and the app never offers it.
  if new.supplier_id is distinct from old.supplier_id then
    raise exception 'A bill cannot be moved to another supplier. Remove these lines and enter the bill under the right supplier.';
  end if;

  v_old_qty  := case when old.deleted_at is null then coalesce(old.quantity, 0)   else 0 end;
  v_new_qty  := case when new.deleted_at is null then coalesce(new.quantity, 0)   else 0 end;
  v_old_cost := case when old.deleted_at is null then coalesce(old.total_cost, 0) else 0 end;
  v_new_cost := case when new.deleted_at is null then coalesce(new.total_cost, 0) else 0 end;

  -- Stock. A line that changed product hands the goods back to the old item and
  -- takes them out on the new one; otherwise it is a straight delta.
  if new.item_id is distinct from old.item_id then
    if old.item_id is not null and v_old_qty <> 0 then
      update public.items set quantity = quantity - v_old_qty where id = old.item_id;
    end if;
    if new.item_id is not null and v_new_qty <> 0 then
      update public.items set quantity = quantity + v_new_qty where id = new.item_id;
    end if;
  elsif new.item_id is not null and v_new_qty <> v_old_qty then
    update public.items
       set quantity = quantity + (v_new_qty - v_old_qty)
     where id = new.item_id;
  end if;

  -- Stock may never go negative: that would mean this edit erased goods that
  -- have already been sold, and every stock figure after it would be a lie.
  if new.item_id is not null then
    select quantity, name into v_left, v_name from public.items where id = new.item_id;
    if v_left < 0 then
      raise exception
        'Not enough stock to make this change: % would go to % pcs. % pcs of it have already been sold.',
        coalesce(v_name, 'this item'), v_left, abs(v_left);
    end if;
  end if;
  if old.item_id is not null and old.item_id is distinct from new.item_id then
    select quantity, name into v_left, v_name from public.items where id = old.item_id;
    if v_left < 0 then
      raise exception
        'Not enough stock to make this change: % would go to % pcs. % pcs of it have already been sold.',
        coalesce(v_name, 'this item'), v_left, abs(v_left);
    end if;
  end if;

  -- Money owed to the supplier.
  if v_new_cost <> v_old_cost then
    update public.suppliers
       set balance_due = balance_due + (v_new_cost - v_old_cost)
     where id = new.supplier_id;
  end if;

  return null;
end $$;

drop trigger if exists trg_purchase_update on public.purchases;
create trigger trg_purchase_update after update on public.purchases
  for each row execute function public.on_purchase_update();

-- A hard DELETE is not something the app does (removal is a soft delete), but if
-- a row is ever destroyed by hand the books must still come out right.
create or replace function public.on_purchase_delete()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_left numeric(14,2); v_name text;
begin
  if old.deleted_at is not null then
    return old;   -- already worth nothing; its stock and money came off long ago
  end if;

  if old.item_id is not null then
    update public.items
       set quantity = quantity - coalesce(old.quantity, 0)
     where id = old.item_id
     returning quantity, name into v_left, v_name;
    if v_left < 0 then
      raise exception
        'Not enough stock to remove this line: % would go to % pcs. % pcs of it have already been sold.',
        coalesce(v_name, 'this item'), v_left, abs(v_left);
    end if;
  end if;

  update public.suppliers
     set balance_due = balance_due - coalesce(old.total_cost, 0)
   where id = old.supplier_id;

  return old;
end $$;

drop trigger if exists trg_purchase_delete on public.purchases;
create trigger trg_purchase_delete after delete on public.purchases
  for each row execute function public.on_purchase_delete();

-- ---------------------------------------------------------------------------
-- 3. Let the bill-level triggers stand down during an edit.
--
-- Both existing bill triggers write a ledger row of their own, which is right
-- when a bill is being ENTERED and wrong when one is being CORRECTED: an edit
-- that adds two products and raises the postage would post three separate
-- entries against the supplier for one correction. edit_purchase_bill() sets a
-- transaction-local flag; the triggers keep moving money (that is their job)
-- but leave the single correction entry to the RPC.
--
-- current_setting(..., true) returns NULL when the flag was never set, so
-- ordinary Purchase Entry is completely unaffected.
-- ---------------------------------------------------------------------------
create or replace function public.on_purchase_bill_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare g record;
begin
  if coalesce(current_setting('app.bill_edit', true), '') = 'on' then
    return null;
  end if;

  for g in
    select purchase_group_id,
           shop_id,
           supplier_id,
           -- Postgres has no min(uuid) aggregate, so take the first id by sort order.
           (array_agg(id order by id))[1] as first_line_id,
           sum(total_cost)                as bill_total,
           count(*)                       as line_count,
           min(invoice_no)                as invoice_no
      from new_rows
     where purchase_group_id is not null
     group by purchase_group_id, shop_id, supplier_id
  loop
    insert into public.ledger (shop_id, entry_type, party_id, party_type,
                               reference_id, reference_table, debit, credit,
                               running_balance, description)
    select g.shop_id, 'purchase', g.supplier_id, 'supplier',
           g.first_line_id, 'purchases', g.bill_total, 0,
           s.balance_due,
           'Purchase: '
             || case when coalesce(trim(g.invoice_no), '') = ''
                     then 'bill'
                     else 'Bill ' || trim(g.invoice_no) end
             || ' (' || g.line_count || ' item'
             || case when g.line_count = 1 then '' else 's' end || ')'
      from public.suppliers s
     where s.id = g.supplier_id;
  end loop;
  return null;
end $$;

-- Postage / GST: now fires on UPDATE too, so correcting them books the
-- DIFFERENCE rather than charging the supplier twice. On insert the old figures
-- are zero, which is exactly the 036 behaviour it replaces.
create or replace function public.on_purchase_bill_charges()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old       numeric(14,2);
  v_new       numeric(14,2);
  v_delta     numeric(14,2);
  v_first_id  uuid;
  v_bal       numeric(14,2);
  v_label     text;
begin
  v_new := round(coalesce(new.postage, 0)
                + coalesce(new.cgst_amount, 0)
                + coalesce(new.sgst_amount, 0), 2);
  if tg_op = 'UPDATE' then
    v_old := round(coalesce(old.postage, 0)
                  + coalesce(old.cgst_amount, 0)
                  + coalesce(old.sgst_amount, 0), 2);
  else
    v_old := 0;
  end if;
  v_delta := round(v_new - v_old, 2);

  -- A bill with no postage and no tax is just goods: 033 has already booked all
  -- of it. Keep the row (it records the grand total) but move no money.
  if v_delta = 0 then
    return new;
  end if;

  select id into v_first_id
    from public.purchases
   where purchase_group_id = new.purchase_group_id
   order by id
   limit 1;

  if v_first_id is null then
    raise exception
      'No purchase lines for this bill, so postage/GST cannot be recorded against it';
  end if;

  update public.suppliers
     set balance_due = balance_due + v_delta
   where id = new.supplier_id
   returning balance_due into v_bal;

  -- During a bill edit the money above is this trigger's job, but the ledger
  -- entry is not: the RPC posts one correction for the whole bill.
  if coalesce(current_setting('app.bill_edit', true), '') = 'on' then
    return new;
  end if;

  v_label := trim(both ', ' from concat_ws(', ',
    case when coalesce(new.postage, 0)     > 0 then 'postage ' || new.postage else null end,
    case when coalesce(new.cgst_amount, 0) > 0 then 'CGST '    || new.cgst_amount else null end,
    case when coalesce(new.sgst_amount, 0) > 0 then 'SGST '    || new.sgst_amount else null end));

  insert into public.ledger (shop_id, entry_type, party_id, party_type,
                             reference_id, reference_table, debit, credit,
                             running_balance, description)
  values (new.shop_id, 'purchase', new.supplier_id, 'supplier',
          v_first_id, 'purchases',
          case when v_delta > 0 then v_delta else 0 end,
          case when v_delta < 0 then -v_delta else 0 end,
          coalesce(v_bal, 0),
          'Bill charges: ' || coalesce(nullif(v_label, ''), 'removed'));

  return new;
end $$;

drop trigger if exists trg_purchase_bill_charges on public.purchase_bills;
create trigger trg_purchase_bill_charges
  after insert or update on public.purchase_bills
  for each row execute function public.on_purchase_bill_charges();

-- ---------------------------------------------------------------------------
-- 4. edit_purchase_bill() — the one write path for a correction.
--
-- Atomic, exactly like create_counter_sale (014): a half-corrected bill can
-- never be left behind. SECURITY DEFINER so it may touch stock and balances
-- regardless of RLS, but it re-checks the role and the shop itself.
--
--   p_bill_id  any purchases row on the bill (the route id of the detail page)
--   p_lines    jsonb array of
--                { id, item_id, quantity, purchase_rate, notes }
--              id = an existing line to keep (edited or not);
--              id absent/null = a product being added to the bill.
--              Existing lines NOT listed here are removed from the bill.
--
-- Returns a summary the screen can show back to the owner: what the bill was
-- worth, what it is worth now, and the difference booked to the supplier.
-- ---------------------------------------------------------------------------
create or replace function public.edit_purchase_bill(
  p_bill_id      uuid,
  p_lines        jsonb,
  p_invoice_no   text default null,
  p_invoice_date date default null,
  p_postage      numeric default 0,
  p_cgst         numeric default 0,
  p_sgst         numeric default 0,
  p_notes        text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_shop        uuid;
  v_role        text;
  v_bill_shop   uuid;
  v_group       uuid;
  v_supplier    uuid;
  v_old_goods   numeric(14,2);
  v_new_goods   numeric(14,2);
  v_old_charges numeric(14,2);
  v_new_charges numeric(14,2);
  v_delta       numeric(14,2);
  v_bal         numeric(14,2);
  v_first       uuid;
  v_lines       int;
  v_short       text;
  v_bad         text;
  v_invoice     text;
  v_postage     numeric(14,2) := round(coalesce(p_postage, 0), 2);
  v_cgst        numeric(14,2) := round(coalesce(p_cgst, 0), 2);
  v_sgst        numeric(14,2) := round(coalesce(p_sgst, 0), 2);
begin
  select shop_id, role into v_shop, v_role
    from public.profiles where id = auth.uid();

  if v_role is distinct from 'owner' then
    raise exception 'Only the owner can edit a purchase bill';
  end if;

  select purchase_group_id, supplier_id, shop_id
    into v_group, v_supplier, v_bill_shop
    from public.purchases where id = p_bill_id;
  if not found then
    raise exception 'That purchase bill no longer exists';
  end if;
  if v_bill_shop is distinct from v_shop then
    raise exception 'That purchase bill belongs to another shop';
  end if;

  if jsonb_typeof(coalesce(p_lines, 'null'::jsonb)) is distinct from 'array'
     or jsonb_array_length(p_lines) = 0 then
    raise exception 'A bill must have at least one product. To take the whole bill off the books, remove its lines one at a time.';
  end if;

  if v_postage < 0 or v_cgst < 0 or v_sgst < 0 then
    raise exception 'Postage and GST cannot be negative';
  end if;

  -- A bill entered before migration 033 has no group. Give it one now so it can
  -- hold several lines and carry postage/GST like any other bill. The ledger
  -- entry it already has points at this row by id, which does not change.
  if v_group is null then
    v_group := gen_random_uuid();
    update public.purchases set purchase_group_id = v_group where id = p_bill_id;
  end if;

  -- ---- validate the submitted lines -------------------------------------
  select string_agg(msg, '; ') into v_bad from (
    select case
             when (l->>'item_id') is null then 'a line has no product'
             when coalesce((l->>'quantity')::numeric, 0) <= 0
               then 'quantity must be more than zero'
             when coalesce((l->>'purchase_rate')::numeric, -1) < 0
               then 'cost rate cannot be negative'
           end as msg
      from jsonb_array_elements(p_lines) l
  ) x where msg is not null;
  if v_bad is not null then
    raise exception 'Check the lines on this bill: %', v_bad;
  end if;

  -- One line, one row. A repeated id would make the UPDATE below ambiguous and
  -- Postgres would refuse it with a message that means nothing to the owner.
  select count(*) into v_lines from (
    select (l->>'id') as id
      from jsonb_array_elements(p_lines) l
     where (l->>'id') is not null
     group by 1 having count(*) > 1
  ) d;
  if v_lines > 0 then
    raise exception 'The same line appears twice on this bill. Reopen it and make the change again.';
  end if;

  -- Every id sent must actually be a live line of THIS bill. Anything else is a
  -- stale screen or a mistake, and silently ignoring it would lose an edit.
  select count(*) into v_lines
    from jsonb_array_elements(p_lines) l
   where (l->>'id') is not null
     and not exists (
       select 1 from public.purchases p
        where p.id = (l->>'id')::uuid
          and p.purchase_group_id = v_group
          and p.deleted_at is null);
  if v_lines > 0 then
    raise exception 'This bill changed while you were editing it. Reopen it and make the change again.';
  end if;

  -- ---- what the bill is worth right now ---------------------------------
  select coalesce(sum(total_cost), 0) into v_old_goods
    from public.purchases
   where purchase_group_id = v_group and deleted_at is null;

  select coalesce(round(postage + cgst_amount + sgst_amount, 2), 0)
    into v_old_charges
    from public.purchase_bills where purchase_group_id = v_group;
  v_old_charges := coalesce(v_old_charges, 0);

  -- ---- refuse before touching anything if stock would go short -----------
  -- Net change per product across the WHOLE edit: lines removed give stock
  -- back, lines added take it, and a changed quantity does both. Checking the
  -- net (rather than line by line) means an edit that only moves quantity
  -- between two lines of the same product is never wrongly refused.
  with want as (
    select (l->>'item_id')::uuid as item_id,
           round((l->>'quantity')::numeric, 2) as quantity
      from jsonb_array_elements(p_lines) l
  ),
  have as (
    select item_id, quantity
      from public.purchases
     where purchase_group_id = v_group and deleted_at is null
  ),
  net as (
    select item_id, sum(q) as d
      from (select item_id,  quantity as q from want
            union all
            select item_id, -quantity     from have) z
     where item_id is not null
     group by item_id
  )
  select string_agg(
           i.name || ' (short by ' || abs(i.quantity + n.d) || ' pcs)', ', ')
    into v_short
    from net n join public.items i on i.id = n.item_id
   where n.d < 0 and i.quantity + n.d < 0;
  if v_short is not null then
    raise exception
      'Not enough stock for this change: %. Those pcs have already been sold, so the bill cannot be cut that far.',
      v_short;
  end if;

  -- ---- apply -------------------------------------------------------------
  perform set_config('app.bill_edit', 'on', true);

  v_invoice := nullif(trim(coalesce(p_invoice_no, '')), '');

  -- Lines taken off the bill. Soft delete: the row stays for audit and keeps
  -- any ledger reference to it valid; the UPDATE trigger unwinds its stock and
  -- its money.
  update public.purchases p
     set deleted_at = now()
   where p.purchase_group_id = v_group
     and p.deleted_at is null
     and not exists (
       select 1 from jsonb_array_elements(p_lines) l
        where (l->>'id') is not null and (l->>'id')::uuid = p.id);

  -- Lines that stayed. invoice_no / invoice_date are carried on every line
  -- (033), so a change to the bill header rewrites all of them.
  update public.purchases p
     set quantity      = w.quantity,
         purchase_rate = w.purchase_rate,
         total_cost    = round(w.quantity * w.purchase_rate, 2),
         notes         = w.notes,
         invoice_no    = v_invoice,
         invoice_date  = p_invoice_date
    from (
      select (l->>'id')::uuid                            as id,
             round((l->>'quantity')::numeric, 2)         as quantity,
             round((l->>'purchase_rate')::numeric, 2)    as purchase_rate,
             nullif(trim(coalesce(l->>'notes', '')), '') as notes
        from jsonb_array_elements(p_lines) l
       where (l->>'id') is not null
    ) w
   where p.id = w.id;

  -- Products added to the bill. One statement, so the 033 statement trigger
  -- sees them together — and stands down anyway, because the flag is set.
  insert into public.purchases (shop_id, item_id, supplier_id, quantity,
                                purchase_rate, total_cost, entered_by, notes,
                                invoice_no, invoice_date, purchase_group_id)
  select v_shop, (l->>'item_id')::uuid, v_supplier,
         round((l->>'quantity')::numeric, 2),
         round((l->>'purchase_rate')::numeric, 2),
         round(round((l->>'quantity')::numeric, 2)
             * round((l->>'purchase_rate')::numeric, 2), 2),
         auth.uid(),
         nullif(trim(coalesce(l->>'notes', '')), ''),
         v_invoice, p_invoice_date, v_group
    from jsonb_array_elements(p_lines) l
   where (l->>'id') is null;

  -- The corrected cost becomes the product's cost. Profit on future sales uses
  -- it; sales already made keep the cost they were booked with.
  update public.items i
     set purchase_rate = w.purchase_rate
    from (
      select distinct on (item_id) item_id, purchase_rate
        from (
          select (l->>'item_id')::uuid                     as item_id,
                 round((l->>'purchase_rate')::numeric, 2)  as purchase_rate,
                 ord
            from jsonb_array_elements(p_lines) with ordinality as t(l, ord)
        ) y
       order by item_id, ord desc
    ) w
   where i.id = w.item_id
     and i.shop_id = v_shop
     and i.purchase_rate is distinct from w.purchase_rate;

  -- ---- postage / GST -----------------------------------------------------
  select coalesce(sum(total_cost), 0) into v_new_goods
    from public.purchases
   where purchase_group_id = v_group and deleted_at is null;

  v_new_charges := round(v_postage + v_cgst + v_sgst, 2);

  -- Written whenever the bill has charges OR already had a row to correct;
  -- a bill that never had any and still has none needs no row at all.
  if v_new_charges > 0 or v_old_charges > 0 then
    insert into public.purchase_bills (shop_id, supplier_id, purchase_group_id,
                                       goods_total, postage, cgst_amount,
                                       sgst_amount, grand_total, notes)
    values (v_shop, v_supplier, v_group, v_new_goods, v_postage, v_cgst, v_sgst,
            round(v_new_goods + v_new_charges, 2),
            nullif(trim(coalesce(p_notes, '')), ''))
    on conflict (purchase_group_id) do update
      set goods_total = excluded.goods_total,
          postage     = excluded.postage,
          cgst_amount = excluded.cgst_amount,
          sgst_amount = excluded.sgst_amount,
          grand_total = excluded.grand_total,
          -- The screen correcting a bill has no bill-note field, so it sends
          -- nothing. That must not erase a note the bill already carries.
          notes       = coalesce(excluded.notes, public.purchase_bills.notes);
  end if;

  -- ---- one correction entry for the whole bill ---------------------------
  select count(*) into v_lines
    from public.purchases
   where purchase_group_id = v_group and deleted_at is null;

  select id into v_first
    from public.purchases
   where purchase_group_id = v_group and deleted_at is null
   order by id limit 1;

  v_delta := round((v_new_goods + v_new_charges) - (v_old_goods + v_old_charges), 2);

  if v_delta <> 0 and v_first is not null then
    select balance_due into v_bal from public.suppliers where id = v_supplier;
    insert into public.ledger (shop_id, entry_type, party_id, party_type,
                               reference_id, reference_table, debit, credit,
                               running_balance, description)
    values (v_shop, 'purchase', v_supplier, 'supplier',
            v_first, 'purchases',
            case when v_delta > 0 then v_delta else 0 end,
            case when v_delta < 0 then -v_delta else 0 end,
            coalesce(v_bal, 0),
            'Bill corrected: '
              || case when v_invoice is null then 'bill' else 'Bill ' || v_invoice end
              || ' (' || v_lines || ' item'
              || case when v_lines = 1 then '' else 's' end || ')');
  end if;

  return jsonb_build_object(
    'purchase_group_id', v_group,
    'first_line_id',     v_first,
    'lines',             v_lines,
    'old_total',         round(v_old_goods + v_old_charges, 2),
    'new_total',         round(v_new_goods + v_new_charges, 2),
    'difference',        v_delta
  );
end $$;

revoke all on function public.edit_purchase_bill(uuid, jsonb, text, date, numeric, numeric, numeric, text) from public, anon;
grant execute on function public.edit_purchase_bill(uuid, jsonb, text, date, numeric, numeric, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. RLS — the owner already has `for all` on purchases (003) and on
--    purchase_bills (036), which covers the UPDATE the soft delete needs. The
--    RPC is the only path the app uses; these policies are the backstop.
--    Staff keep select + insert only: correcting a bill is owner work, because
--    it changes cost rates and the supplier's balance.
-- ---------------------------------------------------------------------------

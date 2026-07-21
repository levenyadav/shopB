-- =============================================================================
-- 033_purchase_bills.sql — Multi-item supplier bills.
--
-- A supplier invoice usually carries MANY products. Until now Purchase Entry
-- took one item per save and the bill number was typed into free-text `notes`
-- ("Bill #4521"), so it could not be searched or totalled.
--
-- We keep the proven one-row-per-item model — each line still fires the row
-- trigger that raises items.quantity and the supplier balance, so Golden Rules
-- #1 (stock in only via Purchase Entry) and #10 (triggers own the mutations)
-- are untouched — and simply TIE the lines of one bill together:
--
--   * invoice_no        the supplier's own bill number (free text; suppliers
--                       number their bills however they like). Not unique —
--                       the owner may legitimately re-use or re-enter one.
--   * invoice_date      the date printed on the bill, which is often NOT the
--                       day it was entered.
--   * purchase_group_id one client-generated uuid per bill, exactly like
--                       orders.order_group_id (migration 018). NULL for every
--                       purchase entered before this migration, so each legacy
--                       row stays valid and reads as a bill of one.
--
-- LEDGER: a 12-line bill must read as ONE entry against the supplier, not 12.
-- The ledger is append-only (Golden Rule #9) so we cannot insert per line and
-- then roll up. Instead the per-row trigger now writes a ledger row ONLY for
-- ungrouped purchases, and a new STATEMENT-level trigger writes exactly one row
-- per bill. Statement triggers fire after every row trigger in the statement,
-- so the supplier's balance_due is already final when we record running_balance.
--
-- This depends on all lines of a bill being inserted in ONE statement
-- (supabase-js `.insert([...])` with an array). Inserting them one at a time
-- would produce one ledger row per line.
-- =============================================================================

alter table public.purchases
  add column if not exists invoice_no        text,
  add column if not exists invoice_date      date,
  add column if not exists purchase_group_id uuid;

comment on column public.purchases.invoice_no is
  'Supplier''s own bill / invoice number. Free text, not unique — the same number may be re-entered.';
comment on column public.purchases.invoice_date is
  'Date printed on the supplier''s bill. May differ from created_at (the day it was keyed in).';
comment on column public.purchases.purchase_group_id is
  'Ties the lines of one supplier bill together. One uuid per bill, set by the client. NULL = purchase entered before migration 033 (a bill of one).';

-- Fan out from any line to its siblings (bill detail view).
create index if not exists purchases_group_idx
  on public.purchases (purchase_group_id)
  where purchase_group_id is not null;

-- "Which bill was this?" — look up a supplier's bill by its number.
create index if not exists purchases_invoice_idx
  on public.purchases (shop_id, supplier_id, invoice_no)
  where invoice_no is not null;

-- ---------------------------------------------------------------------------
-- Row trigger — unchanged except that grouped lines no longer write a ledger
-- row of their own (the statement trigger below does it once for the bill).
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

  if new.purchase_group_id is null then
    insert into public.ledger (shop_id, entry_type, party_id, party_type,
                               reference_id, reference_table, debit, credit,
                               running_balance, description)
    values (new.shop_id, 'purchase', new.supplier_id, 'supplier',
            new.id, 'purchases', new.total_cost, 0,
            sup_bal, 'Purchase: ' || coalesce(item_name,'item'));
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Statement trigger — one ledger row per bill.
--
-- reference_id points at a real purchases row (the first line of the bill) so
-- the ledger's reference_id/reference_table pairing stays honest; every sibling
-- line is reachable from it via purchase_group_id.
-- ---------------------------------------------------------------------------
create or replace function public.on_purchase_bill_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare g record;
begin
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

drop trigger if exists trg_purchase_bill_insert on public.purchases;
create trigger trg_purchase_bill_insert
  after insert on public.purchases
  referencing new table as new_rows
  for each statement execute function public.on_purchase_bill_insert();

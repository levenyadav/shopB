-- =============================================================================
-- 036_purchase_bill_charges.sql — postage + purchase GST on a supplier bill.
--
-- A supplier bill is not just goods. It also carries POSTAGE / freight (what it
-- cost to get the stock here) and the GST the supplier charged on top. Both are
-- money owed to that supplier, but neither is part of the product's cost:
--
--   * POSTAGE is pass-through. It raises the supplier's balance and is recorded
--     on the bill, but items.purchase_rate stays pure goods cost, so profit
--     (Golden Rule #6) keeps meaning the same thing it did before this migration
--     and old profit stays comparable to new profit.
--   * GST is recoverable — the shop claims input tax credit — so it is likewise
--     never folded into cost. Recording it separately IS the point: the sum of
--     cgst_amount + sgst_amount over a period is the input credit to claim.
--
-- So purchase_rate stays the PRE-TAX goods rate (Golden Rule #4 untouched) and
-- the bill reads:
--
--     goods_total  (sum of the lines' total_cost, booked by 033)
--   + postage
--   + cgst_amount + sgst_amount
--   = grand_total  (what the supplier is actually owed)
--
-- Intra-state only: every supplier is in-state, so tax splits CGST/SGST and
-- there is no IGST column. Adding one later means a column plus a supplier
-- state_code, not a rewrite.
--
-- HOW THE MONEY IS BOOKED (Golden Rules #9/#10 — triggers only, never the app):
-- the verified 033 triggers are left completely alone. They book the GOODS: the
-- row trigger raises stock and the supplier balance per line, the statement
-- trigger writes one ledger row per bill. This migration adds a SECOND, separate
-- booking for the non-goods money — one balance move and one append-only ledger
-- entry for postage + tax — fired by the insert into purchase_bills. That is the
-- same shape migration 023 uses for order_bills on the selling side.
--
-- Ordering: the client inserts the purchases rows FIRST (goods booked), then the
-- purchase_bills row (charges booked). If the second insert fails, the bill is
-- simply missing its charges — recoverable by inserting it again — and the
-- supplier balance is never left half-moved.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. purchase_bills — one row per supplier bill, holding the non-goods money.
--    Keyed on purchase_group_id (033), which is exactly one bill. Legacy rows
--    predate grouping and simply never get a charges row.
-- ---------------------------------------------------------------------------
create table if not exists public.purchase_bills (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references public.shops(id),
  supplier_id       uuid not null references public.suppliers(id),
  purchase_group_id uuid not null unique,                 -- the bill these charges belong to
  goods_total       numeric(14,2) not null default 0,     -- sum of the lines, as the client saw it
  postage           numeric(14,2) not null default 0,     -- freight / courier — pass-through
  cgst_amount       numeric(14,2) not null default 0,     -- input credit
  sgst_amount       numeric(14,2) not null default 0,     -- input credit
  grand_total       numeric(14,2) not null default 0,     -- goods + postage + cgst + sgst
  notes             text,
  created_at        timestamptz not null default now(),
  check (goods_total >= 0 and postage >= 0
         and cgst_amount >= 0 and sgst_amount >= 0)
);
create index if not exists idx_purchase_bills_shop
  on public.purchase_bills(shop_id);
create index if not exists idx_purchase_bills_supplier
  on public.purchase_bills(supplier_id);

comment on table public.purchase_bills is
  'Non-goods money on a supplier bill: postage (pass-through) and purchase GST (input credit). Neither is part of items.purchase_rate. Keyed 1:1 to a purchase_group_id.';
comment on column public.purchase_bills.postage is
  'Freight / courier / other cost of getting this bill delivered. Pass-through: raises the supplier balance, never the product cost.';
comment on column public.purchase_bills.cgst_amount is
  'CGST the supplier charged on this bill. Recoverable input tax credit, so it is NOT part of cost.';
comment on column public.purchase_bills.grand_total is
  'goods_total + postage + cgst_amount + sgst_amount = what the supplier is owed for this bill.';

-- ---------------------------------------------------------------------------
-- 2. RLS — mirrors the purchases policies exactly (003), so whoever may enter a
--    bill may enter its charges. Owner manages; staff may read and add.
-- ---------------------------------------------------------------------------
alter table public.purchase_bills enable row level security;

drop policy if exists purchase_bills_owner_all    on public.purchase_bills;
drop policy if exists purchase_bills_staff_select on public.purchase_bills;
drop policy if exists purchase_bills_staff_insert on public.purchase_bills;

create policy purchase_bills_owner_all on public.purchase_bills for all
  using (auth_role() = 'owner' and shop_id = auth_shop_id())
  with check (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy purchase_bills_staff_select on public.purchase_bills for select
  using (auth_role() = 'staff' and shop_id = auth_shop_id());
create policy purchase_bills_staff_insert on public.purchase_bills for insert
  with check (auth_role() = 'staff' and shop_id = auth_shop_id());

-- ---------------------------------------------------------------------------
-- 3. Trigger — book postage + tax onto the supplier, once, append-only.
--
--    The ledger demands a real reference row (reference_id is NOT NULL and
--    reference_table is constrained to sales/purchases/payments), so the entry
--    points at the first line of the bill — the same anchor the 033 statement
--    trigger uses. A charges row for a bill with no purchase lines therefore has
--    nothing to hang off and is rejected rather than silently dropped.
-- ---------------------------------------------------------------------------
create or replace function public.on_purchase_bill_charges()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_charges   numeric(14,2);
  v_first_id  uuid;
  v_bal       numeric(14,2);
  v_label     text;
begin
  v_charges := round(coalesce(new.postage, 0)
                   + coalesce(new.cgst_amount, 0)
                   + coalesce(new.sgst_amount, 0), 2);

  -- A bill with no postage and no tax is just goods: 033 has already booked all
  -- of it. Keep the row (it records the grand total) but move no money.
  if v_charges = 0 then
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
     set balance_due = balance_due + v_charges
   where id = new.supplier_id
   returning balance_due into v_bal;

  v_label := trim(both ', ' from concat_ws(', ',
    case when coalesce(new.postage, 0)     > 0 then 'postage ' || new.postage else null end,
    case when coalesce(new.cgst_amount, 0) > 0 then 'CGST '    || new.cgst_amount else null end,
    case when coalesce(new.sgst_amount, 0) > 0 then 'SGST '    || new.sgst_amount else null end));

  insert into public.ledger (shop_id, entry_type, party_id, party_type,
                             reference_id, reference_table, debit, credit,
                             running_balance, description)
  values (new.shop_id, 'purchase', new.supplier_id, 'supplier',
          v_first_id, 'purchases', v_charges, 0,
          coalesce(v_bal, 0),
          'Bill charges: ' || v_label);

  return new;
end $$;

drop trigger if exists trg_purchase_bill_charges on public.purchase_bills;
create trigger trg_purchase_bill_charges
  after insert on public.purchase_bills
  for each row execute function public.on_purchase_bill_charges();

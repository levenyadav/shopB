-- =============================================================================
-- 035_dealer_invoice_series.sql — a separate invoice series for dealers.
--
-- 016 gave the shop ONE invoice number line: shops.invoice_prefix +
-- shops.invoice_counter, bumped by create_invoice_for_sale() for every sale. So
-- retail walk-ins and wholesale dealer bills were interleaved in one running
-- series — SHOP-0001, SHOP-0002, SHOP-0003 — with no way to read the two kinds
-- of business apart.
--
-- The shop keeps two books. This gives each its own gap-free series:
--
--   customer sale → invoice_prefix        + invoice_counter        (unchanged)
--   dealer   sale → dealer_invoice_prefix + dealer_invoice_counter (new)
--
-- NOTHING ALREADY ISSUED IS RENUMBERED. Every bill a buyer holds keeps the
-- number printed on it, including past dealer sales that drew from the single
-- series — invoices.series records them honestly as 'customer', which is where
-- their number actually came from. The dealer series starts fresh at 0001.
--
-- The buyer type is already on the sale row (sales.buyer_type, locked at
-- approval), so this is a one-branch change inside the existing trigger. The
-- allocation stays exactly as safe as 016 made it: UPDATE ... RETURNING takes a
-- row lock on the shops row, so two concurrent approvals cannot take the same
-- number, and a counter bill (many lines, shared bill_id) is still invoiced once
-- by its first line. Golden Rules #5/#6/#10 untouched — the locked Sale is never
-- rewritten, and no client code allocates a number.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The dealer series. Rides the existing shops_select (public read — the
--    prefix is printed on the bill) and shops_update (owner only) policies.
--    dealer_invoice_counter is mutated ONLY by the SECURITY DEFINER trigger.
-- ---------------------------------------------------------------------------
alter table public.shops
  add column if not exists dealer_invoice_prefix  text not null default 'DLR',
  add column if not exists dealer_invoice_counter int  not null default 0;

comment on column public.shops.dealer_invoice_prefix  is
  'Invoice number prefix for DEALER sales, e.g. DLR-0001. Must differ from invoice_prefix (see shops_invoice_prefixes_differ) or the two series would collide on invoices.unique(shop_id, invoice_no).';
comment on column public.shops.dealer_invoice_counter is
  'Last dealer invoice serial issued (per shop). Bumped only by create_invoice_for_sale().';
comment on column public.shops.invoice_prefix        is
  'Invoice number prefix for CUSTOMER sales, e.g. SHOP-0001. Dealers use dealer_invoice_prefix.';

-- ---------------------------------------------------------------------------
-- 2. The two prefixes must differ. invoices has unique (shop_id, invoice_no):
--    if both series shared a prefix they would eventually mint the same string,
--    the invoice insert would fail, and because that insert happens inside the
--    sale's AFTER-INSERT trigger, the whole ORDER APPROVAL would fail. Cheap
--    constraint, nasty failure — so guard it in the database, not just the UI.
--
--    Nudge any shop that already types 'DLR' out of the way first, so adding
--    the constraint can never fail on live data.
-- ---------------------------------------------------------------------------
update public.shops
   set dealer_invoice_prefix = 'DLR-B'
 where upper(trim(dealer_invoice_prefix)) = upper(trim(coalesce(invoice_prefix, 'INV')));

alter table public.shops
  drop constraint if exists shops_invoice_prefixes_differ;
alter table public.shops
  add constraint shops_invoice_prefixes_differ
  check (upper(trim(dealer_invoice_prefix)) <> upper(trim(coalesce(invoice_prefix, 'INV'))));

-- ---------------------------------------------------------------------------
-- 3. Which series an invoice was drawn from. Recorded at allocation time so the
--    books stay auditable across this split: a dealer sale from BEFORE today
--    legitimately carries a customer-series number, and this column says so
--    rather than pretending otherwise.
-- ---------------------------------------------------------------------------
alter table public.invoices
  add column if not exists series text
  check (series is null or series in ('customer','dealer'));

comment on column public.invoices.series is
  'Which numbering series this invoice_no came from: customer (invoice_counter) or dealer (dealer_invoice_counter). Every row issued before 035 is customer — that was the only series.';

-- Backfill: every existing number came from the single (now customer) counter.
update public.invoices set series = 'customer' where series is null;

-- ---------------------------------------------------------------------------
-- 4. Allocate from the series that matches the buyer. Everything else is 016's
--    function verbatim — the counter-bill early return, SECURITY DEFINER, the
--    locking UPDATE ... RETURNING, the 4-digit zero padding.
-- ---------------------------------------------------------------------------
create or replace function public.create_invoice_for_sale()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_n int; v_prefix text;
begin
  -- counter bill already invoiced by an earlier line of the same bill?
  if new.bill_id is not null
     and exists (select 1 from public.invoices where bill_id = new.bill_id) then
    return new;
  end if;

  if new.buyer_type = 'dealer' then
    update public.shops
       set dealer_invoice_counter = dealer_invoice_counter + 1
     where id = new.shop_id
     returning dealer_invoice_counter, coalesce(nullif(trim(dealer_invoice_prefix), ''), 'DLR')
          into v_n, v_prefix;
  else
    update public.shops
       set invoice_counter = invoice_counter + 1
     where id = new.shop_id
     returning invoice_counter, coalesce(nullif(trim(invoice_prefix), ''), 'INV')
          into v_n, v_prefix;
  end if;

  insert into public.invoices (shop_id, invoice_no, sale_id, bill_id, series)
  values (new.shop_id,
          v_prefix || '-' || lpad(v_n::text, 4, '0'),
          case when new.bill_id is null then new.id else null end,
          new.bill_id,
          case when new.buyer_type = 'dealer' then 'dealer' else 'customer' end);
  return new;
end $$;

-- The trigger itself (trg_sale_create_invoice, 016) is unchanged — CREATE OR
-- REPLACE swaps the body underneath it.
--
-- customer_invoices is deliberately NOT rebuilt. `series` is internal
-- bookkeeping: the buyer's copy already carries the number itself, which is all
-- they need, and leaving the view alone keeps this migration independent of
-- 034's column list.

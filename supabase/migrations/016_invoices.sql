-- =============================================================================
-- 016_invoices.sql — customer-facing Tax Invoice (SPEC §15; client feat #4/#6/#7).
--
-- On approval a Sale is created (Golden Rules #2/#3). The Sale is the immutable,
-- trigger-owned record (#5/#6/#10) and must never be edited. A customer INVOICE
-- is a separate presentation of that Sale, so its editable parts live in their
-- own `invoices` table — editing an invoice NEVER touches the locked Sale.
--
-- What this migration adds:
--   1. Seller billing identity on shops (legal name, PAN, e-mail, state, bank).
--   2. A gap-free per-shop invoice number (shops.invoice_counter + prefix).
--   3. Buyer state fields on profiles (gstin + address already exist — 010).
--   4. Optional HSN/SAC on items (printed per line + an HSN-wise tax summary).
--   5. invoices table: invoice_no + editable Bill-To override + notes.
--   6. AFTER-INSERT trigger on sales that allocates the number and creates the
--      invoice row — once per shopfront sale, once per counter bill (bill_id).
--   7. customer_invoices view: buyer-safe columns only, and DROP of the buyer's
--      direct SELECT on sales (which leaked purchase_rate/profit — same hole as
--      007 fixed for items). Buyers now read invoices only through the view.
--   8. Backfill: number every pre-existing sale/bill in chronological order.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1 + 2. Seller billing identity + invoice numbering on the single shops row.
--    These ride the existing shops_select (public read — buyer-facing on the
--    bill) and shops_update (owner only). invoice_counter is mutated only by the
--    SECURITY DEFINER trigger below, never by the client.
-- ---------------------------------------------------------------------------
alter table public.shops
  add column if not exists legal_name      text,   -- e.g. "Khattri Card Pratham - 2026-27"
  add column if not exists email           text,
  add column if not exists pan             text,
  add column if not exists state_name      text,
  add column if not exists state_code      text,   -- GST state code, e.g. "09"
  add column if not exists bank_details    text,   -- bank / UPI line for the footer
  add column if not exists invoice_prefix  text not null default 'INV',
  add column if not exists invoice_counter int  not null default 0;

comment on column public.shops.legal_name      is 'Registered legal name printed as the seller on tax invoices; falls back to name.';
comment on column public.shops.invoice_counter is 'Last invoice serial issued (per shop). Bumped only by create_invoice_for_sale().';

-- ---------------------------------------------------------------------------
-- 3. Buyer state (for the "State Name : ..., Code : 09" Bill-To line).
--    gstin + address already added in 010. Ride existing profiles policies.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists state_name text,
  add column if not exists state_code text;

-- ---------------------------------------------------------------------------
-- 4. Optional HSN/SAC code per item. Buyer-safe (printed on the bill), so it is
--    exposed through both shopfront_items (rebuilt below) and customer_invoices.
-- ---------------------------------------------------------------------------
alter table public.items
  add column if not exists hsn_sac text;

comment on column public.items.hsn_sac is 'Optional HSN/SAC code; printed on tax invoices and the HSN-wise tax summary.';

-- shopfront_items (015) is fixed-column. CREATE OR REPLACE can only APPEND new
-- columns at the end, so hsn_sac goes last — after the 015 columns
-- (moq/description/tags/images), which must be preserved or the buyer view breaks.
create or replace view public.shopfront_items
with (security_invoker = false) as
select
  i.id, i.shop_id, i.item_no, i.name, i.category_id,
  i.quantity, i.dealer_rate, i.rate, i.photo_url,
  i.low_stock_threshold, i.created_at,
  i.moq, i.description, i.tags, i.images,
  i.hsn_sac
from public.items i
where i.is_active = true and i.quantity > 0;
grant select on public.shopfront_items to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. invoices — the editable, presentational layer over an immutable Sale.
--    Linked by sale_id (shopfront: one sale) OR bill_id (counter: a bill of many
--    sale lines). Bill-To override columns are NULL by default and fall back to
--    the buyer's profile at render time; only billing/presentation is editable,
--    never amount/qty/rate/profit (those stay on the locked Sale — Rule #5/#6).
-- ---------------------------------------------------------------------------
create table if not exists public.invoices (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references public.shops(id),
  invoice_no         text not null,
  sale_id            uuid unique references public.sales(id) on delete cascade,
  bill_id            uuid unique,
  bill_to_name       text,
  bill_to_address    text,
  bill_to_gstin      text,
  bill_to_state_name text,
  bill_to_state_code text,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (shop_id, invoice_no),
  -- exactly one link: a shopfront sale, or a counter bill — never both/neither.
  check ((sale_id is null) <> (bill_id is null))
);
create index if not exists idx_invoices_shop on public.invoices(shop_id);

create trigger trg_invoices_touch before update on public.invoices
  for each row execute function public.touch_updated_at();

alter table public.invoices enable row level security;
-- Owner manages every invoice in their shop. Buyers never read this table
-- directly — they go through customer_invoices (below), which is buyer-safe.
create policy invoices_owner_all on public.invoices for all
  using (auth_role() = 'owner' and shop_id = auth_shop_id())
  with check (auth_role() = 'owner' and shop_id = auth_shop_id());

-- ---------------------------------------------------------------------------
-- 6. Allocate the invoice number + create the invoice row, AFTER a sale insert.
--    Gap-free + concurrency-safe: the UPDATE ... RETURNING on the shops row takes
--    a row lock, so two concurrent approvals can't grab the same serial. A
--    counter bill (many sale lines, shared bill_id) is invoiced once — the first
--    line creates it; later lines in the same transaction see it and skip.
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

  update public.shops
     set invoice_counter = invoice_counter + 1
   where id = new.shop_id
   returning invoice_counter, coalesce(invoice_prefix, 'INV')
        into v_n, v_prefix;

  insert into public.invoices (shop_id, invoice_no, sale_id, bill_id)
  values (new.shop_id,
          v_prefix || '-' || lpad(v_n::text, 4, '0'),
          case when new.bill_id is null then new.id else null end,
          new.bill_id);
  return new;
end $$;

create trigger trg_sale_create_invoice after insert on public.sales
  for each row execute function public.create_invoice_for_sale();

-- ---------------------------------------------------------------------------
-- 7. customer_invoices — buyer-safe view. Exposes ONLY buyer-facing figures
--    (Golden Rule #4: never purchase_rate / profit) for the signed-in buyer's
--    own sales, joined to the item's printable fields and the editable invoice
--    row. postgres-owned (security_invoker off) so it bypasses base-table RLS;
--    the buyer-scoping is baked in via `s.buyer_id = auth.uid()`.
-- ---------------------------------------------------------------------------
create or replace view public.customer_invoices
with (security_invoker = false) as
select
  s.id            as sale_id,
  s.shop_id,
  s.order_id,
  s.bill_id,
  s.quantity,
  s.rate_charged,
  s.amount,
  s.payment_type,
  s.buyer_type,
  s.buyer_id,
  s.created_at,
  i.name          as item_name,
  i.item_no,
  i.hsn_sac,
  inv.invoice_no,
  -- Bill-To: invoice override, else the buyer's own profile (safe — it's theirs).
  coalesce(inv.bill_to_name,       p.full_name)  as bill_to_name,
  coalesce(inv.bill_to_address,    p.address)    as bill_to_address,
  coalesce(inv.bill_to_gstin,      p.gstin)      as bill_to_gstin,
  coalesce(inv.bill_to_state_name, p.state_name) as bill_to_state_name,
  coalesce(inv.bill_to_state_code, p.state_code) as bill_to_state_code,
  inv.notes       as invoice_notes
from public.sales s
join public.items i on i.id = s.item_id
join public.profiles p on p.id = s.buyer_id
left join public.invoices inv
       on (inv.sale_id = s.id) or (inv.bill_id is not null and inv.bill_id = s.bill_id)
where s.buyer_id = auth.uid();

grant select on public.customer_invoices to authenticated;

-- Close the cost-price leak: buyers had direct SELECT on whole sales rows (which
-- include purchase_rate + profit). Route them through the view instead. Owner's
-- sales_owner_select is untouched — the owner legitimately needs cost/profit.
drop policy if exists sales_buyer_select on public.sales;

-- ---------------------------------------------------------------------------
-- 8. Backfill — give every pre-existing sale (or counter bill) an invoice number
--    in chronological order, so the books don't start mid-sequence. Idempotent:
--    skips any sale/bill that already has an invoice, so re-running is a no-op.
-- ---------------------------------------------------------------------------
do $$
declare r record; v_n int; v_prefix text;
begin
  for r in
    select coalesce(s.bill_id, s.id) as unit,
           -- shop_id & bill_id are constant within each group, but uuid has no
           -- min/max aggregate, so pick one row's value via array_agg.
           (array_agg(s.shop_id order by s.created_at))[1] as shop_id,
           (array_agg(s.bill_id  order by s.created_at))[1] as bill_id, -- null = shopfront
           (array_agg(s.id       order by s.created_at))[1] as first_sale_id,
           min(s.created_at)         as ts
      from public.sales s
     where not exists (select 1 from public.invoices i where i.sale_id = s.id)
       and (s.bill_id is null
            or not exists (select 1 from public.invoices i where i.bill_id = s.bill_id))
     group by coalesce(s.bill_id, s.id)
     order by ts
  loop
    update public.shops
       set invoice_counter = invoice_counter + 1
     where id = r.shop_id
     returning invoice_counter, coalesce(invoice_prefix, 'INV')
          into v_n, v_prefix;

    insert into public.invoices (shop_id, invoice_no, sale_id, bill_id)
    values (r.shop_id,
            v_prefix || '-' || lpad(v_n::text, 4, '0'),
            case when r.bill_id is null then r.first_sale_id else null end,
            r.bill_id);
  end loop;
end $$;

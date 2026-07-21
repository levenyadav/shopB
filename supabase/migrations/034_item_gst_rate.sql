-- =============================================================================
-- 034_item_gst_rate.sql — per-product GST rate.
--
-- shops.gst_rate (009) is a SINGLE rate applied to every invoice. Real stock does
-- not work that way: cards/boxes/gift items sit in different GST slabs (0 / 5 /
-- 12 / 18 / 28 %). So each item may carry its own rate, set on Purchase Entry
-- when the product is created (and editable later from Inventory).
--
--   items.gst_rate IS NULL  → use the shop's default rate (shops.gst_rate)
--   items.gst_rate = 0      → this product is exempt / nil-rated
--   items.gst_rate = 12     → this product is taxed at 12 %, whatever the default
--
-- Nullable with no default, so every existing item keeps behaving exactly as it
-- does today (shop rate). GST stays tax-INCLUSIVE (SPEC §15 / helpers.gstBreakup):
-- the locked sale amount is what the buyer pays and the tax is backed out of it,
-- now per line rather than over the whole bill. Rule #5 still holds — the invoice
-- never changes the amount, only how it is split.
-- =============================================================================

alter table public.items
  add column if not exists gst_rate numeric(5,2)
  check (gst_rate is null or (gst_rate >= 0 and gst_rate <= 100));

comment on column public.items.gst_rate is
  'GST slab (%) for this product, tax-inclusive. NULL = fall back to shops.gst_rate (the shop default); 0 = exempt. Buyer-facing (printed on the tax invoice), so it is exposed through shopfront_items and customer_invoices.';

-- ---------------------------------------------------------------------------
-- Buyer-facing views. CREATE OR REPLACE may only APPEND columns (42P16
-- otherwise), so gst_rate goes last in each. shopfront_items column list is the
-- 022 one; customer_invoices the 016 one. purchase_rate is still never selected
-- (Golden Rule #4).
-- ---------------------------------------------------------------------------
create or replace view public.shopfront_items
with (security_invoker = false) as
select
  i.id, i.shop_id, i.item_no, i.name, i.category_id,
  i.quantity, i.dealer_rate, i.rate, i.photo_url,
  i.low_stock_threshold, i.created_at,
  i.moq, i.description, i.tags, i.images,
  i.hsn_sac,
  i.made_to_order,
  i.gst_rate
from public.items i
where i.is_active = true
  and i.discontinued = false
  and (i.quantity > 0 or i.made_to_order = true);

grant select on public.shopfront_items to anon, authenticated;

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
  coalesce(inv.bill_to_name,       p.full_name)  as bill_to_name,
  coalesce(inv.bill_to_address,    p.address)    as bill_to_address,
  coalesce(inv.bill_to_gstin,      p.gstin)      as bill_to_gstin,
  coalesce(inv.bill_to_state_name, p.state_name) as bill_to_state_name,
  coalesce(inv.bill_to_state_code, p.state_code) as bill_to_state_code,
  inv.notes       as invoice_notes,
  i.gst_rate      as item_gst_rate
from public.sales s
join public.items i on i.id = s.item_id
join public.profiles p on p.id = s.buyer_id
left join public.invoices inv
       on (inv.sale_id = s.id) or (inv.bill_id is not null and inv.bill_id = s.bill_id)
where s.buyer_id = auth.uid();

grant select on public.customer_invoices to authenticated;

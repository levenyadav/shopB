-- =============================================================================
-- 009_shop_invoice_fields.sql — GST details on the shop, for customer invoices.
--
-- The Order Supply Slip (§13) is an internal packing slip. Customer-facing
-- invoices (§15 future enhancement) need the shop's GST identity. These two
-- columns are optional: a shop that doesn't bill with GST leaves gstin NULL and
-- gst_rate 0, and the invoice prints as a plain bill.
--
-- No new RLS: shops already has shops_select (readable by all — the public
-- shopfront reads name/currency) and shops_update (owner only). These columns
-- ride those existing policies. gstin is buyer-safe (it is printed on the bill),
-- so the public read is fine.
-- =============================================================================

alter table public.shops
  add column if not exists gstin    text,
  add column if not exists gst_rate numeric(5,2) not null default 0;

comment on column public.shops.gstin    is 'Shop GST number; NULL = not GST-registered. Printed on customer invoices.';
comment on column public.shops.gst_rate is 'Single GST rate (%) applied to invoices, treated as tax-inclusive. 0 = no GST.';

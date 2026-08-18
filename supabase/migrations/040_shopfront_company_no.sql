-- =============================================================================
-- 040_shopfront_company_no.sql — expose Company No. on the shopfront search.
--
-- company_no (025) was documented as owner-only, never shown to buyers, because
-- it's the raw manufacturer design/article code the owner reads off the product
-- to re-order stock. In practice dealers already know these codes themselves
-- (their own suppliers print the same numbers) and ask for items by them, so the
-- owner wants buyers able to find a product by typing its company no on the
-- public shopfront search. This is a deliberate reversal of that earlier note —
-- still free text, still nullable, still never reveals purchase_rate (Golden
-- Rule #4 is unaffected; this column carries no cost information).
--
-- CREATE OR REPLACE may only APPEND columns (42P16 otherwise), so company_no
-- goes last, after the 034 column list.
-- =============================================================================

create or replace view public.shopfront_items
with (security_invoker = false) as
select
  i.id, i.shop_id, i.item_no, i.name, i.category_id,
  i.quantity, i.dealer_rate, i.rate, i.photo_url,
  i.low_stock_threshold, i.created_at,
  i.moq, i.description, i.tags, i.images,
  i.hsn_sac,
  i.made_to_order,
  i.gst_rate,
  i.company_no
from public.items i
where i.is_active = true
  and i.discontinued = false
  and (i.quantity > 0 or i.made_to_order = true);

grant select on public.shopfront_items to anon, authenticated;

comment on column public.items.company_no is
  'The company/manufacturer''s own design/article/model number for this product, as printed by them — used to re-order from the supplier, and searchable by buyers on the shopfront (040).';

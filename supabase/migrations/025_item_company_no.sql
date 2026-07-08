-- =============================================================================
-- 025_item_company_no.sql — "Company No." on items (manufacturer's design code).
--
-- Card / box shops re-order stock by quoting the number the COMPANY (manufacturer)
-- prints on the product — its own design / article / model number. That is not our
-- internal item_no (SHOP-0001…, assigned by us) and not the barcode; it is the
-- supplier's own reference the owner reads off the card to say "send me 50 more of
-- design 1420". The owner wants to capture it at Purchase Entry, next to the item
-- name, and see it in the Inventory + Bulk-import tables.
--
-- Purely additive, free text, nullable — old rows stay NULL and nothing else is
-- affected. It is NOT shown to buyers, so the shopfront_items view is untouched
-- (still never leaks internal/company references; Golden Rule #4 holds).
-- =============================================================================

alter table public.items
  add column if not exists company_no text;

comment on column public.items.company_no is
  'The company/manufacturer''s own design/article/model number for this product, as printed by them — used to re-order from the supplier. Distinct from item_no (our internal SHOP-#### code) and barcode. Owner-facing only; never exposed on the shopfront.';

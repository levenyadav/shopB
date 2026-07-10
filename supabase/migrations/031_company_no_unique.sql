-- =============================================================================
-- 031_company_no_unique.sql — Company No. must be unique within a shop.
--
-- company_no (025) is the manufacturer's design/article number the owner reads
-- off the product to re-order ("send 50 more of design 1420"). If two different
-- catalogue rows in the same shop carry the SAME company_no, that re-order code
-- becomes ambiguous. Enforce one company_no per item, per shop.
--
-- CONDITIONAL uniqueness (partial index): only rows that actually HAVE a value
-- are constrained. Old / blank rows stay NULL and are exempt, so this is additive
-- and never blocks an item that simply has no company number. Case-insensitive
-- (lower()) and shop-scoped, mirroring the case-insensitive duplicate-name guard
-- and the per-shop `unique (shop_id, item_no)` from 001 — each shop is its own
-- tenant, so codes only need to be unique inside a shop, never globally.
--
-- NOTE: if the live table already holds duplicate company_no values within a
-- shop, creating this index will fail with a unique_violation naming the clashing
-- rows — clean those up (blank or renumber one) and re-run. Find them with:
--   select shop_id, lower(company_no), count(*)
--     from public.items
--    where company_no is not null and company_no <> ''
--    group by 1, 2 having count(*) > 1;
-- =============================================================================

create unique index if not exists items_shop_company_no_uidx
  on public.items (shop_id, lower(company_no))
  where company_no is not null and company_no <> '';

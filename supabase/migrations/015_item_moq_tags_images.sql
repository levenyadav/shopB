-- =============================================================================
-- 015_item_moq_tags_images.sql — product enrichment (Group A).
--
-- Adds four optional columns to items and re-exposes them through the
-- column-safe shopfront_items view (007) so buyers can see/description/tags and
-- the order box can enforce the minimum order quantity:
--   * moq         — Minimum Order Quantity a customer must order (enforced on the
--                   shopfront). Default 1 = no restriction.
--   * description — free-text product description, shown on the item page.
--   * tags        — text[] labels for search & filtering (e.g. {wedding,premium}).
--   * images      — text[] of EXTRA image URLs (a gallery). photo_url stays the
--                   cover/primary image for thumbnails and cards.
--
-- All four are buyer-safe (meant to be shown publicly), so they ride the existing
-- shops/items policies. purchase_rate is STILL excluded from the view (Golden
-- Rule #4) — we only add the new buyer-safe columns.
-- =============================================================================

alter table public.items
  add column if not exists moq         numeric(14,2) not null default 1,
  add column if not exists description text,
  add column if not exists tags        text[]        not null default '{}',
  add column if not exists images      text[]        not null default '{}';

comment on column public.items.moq         is 'Minimum Order Quantity a customer must order on the shopfront. 1 = no restriction.';
comment on column public.items.description is 'Free-text product description, shown on the public item page.';
comment on column public.items.tags        is 'Search/filter labels, e.g. {wedding,premium}.';
comment on column public.items.images      is 'Extra image URLs (gallery). photo_url remains the cover image.';

-- ---------------------------------------------------------------------------
-- Re-expose the buyer-safe view with the new columns. purchase_rate stays out.
-- (security_invoker = false so the §9.1 active + in-stock rule stays baked in.)
-- ---------------------------------------------------------------------------
create or replace view public.shopfront_items
with (security_invoker = false) as
select
  i.id, i.shop_id, i.item_no, i.name, i.category_id,
  i.quantity, i.dealer_rate, i.rate, i.photo_url,
  i.low_stock_threshold, i.created_at,
  i.moq, i.description, i.tags, i.images
from public.items i
where i.is_active = true and i.quantity > 0;

grant select on public.shopfront_items to anon, authenticated;

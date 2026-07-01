-- =============================================================================
-- 017_shopfront.sql — Shopfront revamp (Group D, feature #8).
--
-- All additive on shops. Everything here is buyer-facing (banners, social links,
-- footer pages), so it rides the EXISTING policies — no new RLS:
--   * shops_select — public read (anon + authenticated). The shopfront, footer
--     and the /about /privacy /terms /contact pages read these columns with no
--     login.
--   * shops_update — owner only. The owner edits all of this from Settings.
--
--   1. banners      — ordered carousel slides shown on the shopfront. JSONB array
--                     of { image_url, caption, link } objects; order = array order.
--                     Images live in the existing public 'brand-assets' bucket
--                     (012), so no new bucket is needed.
--   2. social links — whatsapp / instagram / facebook / youtube / map_url, each
--                     optional. Rendered as footer icons only when set.
--   3. content pages — about_us / privacy_policy / terms / contact_info free text
--                     (plain text or light Markdown), edited from Settings so the
--                     owner never needs a code change to reword a page.
-- =============================================================================

alter table public.shops
  add column if not exists banners        jsonb not null default '[]'::jsonb,
  add column if not exists whatsapp        text,
  add column if not exists instagram       text,
  add column if not exists facebook        text,
  add column if not exists youtube         text,
  add column if not exists map_url         text,
  add column if not exists about_us        text,
  add column if not exists privacy_policy  text,
  add column if not exists terms           text,
  add column if not exists contact_info    text;

comment on column public.shops.banners        is 'Shopfront carousel slides: JSONB array of { image_url, caption, link }. Array order = display order. Images stored in the brand-assets bucket.';
comment on column public.shops.whatsapp        is 'WhatsApp number or wa.me link for the footer. NULL = hide the icon.';
comment on column public.shops.instagram       is 'Instagram profile URL for the footer. NULL = hide the icon.';
comment on column public.shops.facebook        is 'Facebook page URL for the footer. NULL = hide the icon.';
comment on column public.shops.youtube         is 'YouTube channel URL for the footer. NULL = hide the icon.';
comment on column public.shops.map_url         is 'Google Maps (or similar) link to the shop location. NULL = hide the icon.';
comment on column public.shops.about_us        is 'About Us page body (plain text / light Markdown), edited from Settings. NULL = page hidden.';
comment on column public.shops.privacy_policy  is 'Privacy Policy page body. NULL = page hidden.';
comment on column public.shops.terms           is 'Terms & Conditions page body. NULL = page hidden.';
comment on column public.shops.contact_info    is 'Contact page body. NULL = page hidden.';

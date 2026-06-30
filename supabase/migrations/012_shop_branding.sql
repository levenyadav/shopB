-- =============================================================================
-- 012_shop_branding.sql — shop logo, app icon and text wordmark (Settings §6.11).
--
-- The shop identity already lives in the single shops row (name, address, GST).
-- These three optional columns add visual branding shown in the owner sidebar,
-- the public shopfront header and on printed slips:
--   * logo_url   — wide/main image logo. When set, replaces the text stamp.
--   * icon_url   — square app icon, also used as the browser favicon.
--   * brand_text — text wordmark shown when there is no image logo. Lets the
--                  owner style the displayed name independently of the legal
--                  shop name (which still prints on invoices).
--
-- No new RLS on shops: these ride the existing shops_select (public read — the
-- shopfront shows the logo without a login) and shops_update (owner only). All
-- three are buyer-safe; they are meant to be seen publicly.
--
-- Storage: a dedicated public 'brand-assets' bucket, mirroring 005_storage.sql's
-- 'item-photos' policies. Public READ so getPublicUrl works on the shopfront;
-- WRITE limited to owner/staff inside their own shop's folder (<shop_id>/<uuid>).
-- =============================================================================

alter table public.shops
  add column if not exists logo_url   text,
  add column if not exists icon_url   text,
  add column if not exists brand_text text;

comment on column public.shops.logo_url   is 'Public URL of the shop''s image logo. NULL = fall back to brand_text / name.';
comment on column public.shops.icon_url    is 'Public URL of the square app icon; also used as the browser favicon.';
comment on column public.shops.brand_text  is 'Display wordmark shown when logo_url is NULL. NULL = fall back to shop name.';

-- ---------------------------------------------------------------------------
-- brand-assets bucket — public read, owner/staff write within their shop folder.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('brand-assets', 'brand-assets', true)
on conflict (id) do nothing;

-- Public read (anon + authenticated) — shopfront logo/favicon.
create policy "brand-assets read"
  on storage.objects for select
  using (bucket_id = 'brand-assets');

-- Owner/staff may upload into their own shop's folder.
create policy "brand-assets insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'brand-assets'
    and public.auth_role() in ('owner','staff')
    and (storage.foldername(name))[1] = public.auth_shop_id()::text
  );

-- Owner/staff may replace/remove their own shop's assets.
create policy "brand-assets update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'brand-assets'
    and public.auth_role() in ('owner','staff')
    and (storage.foldername(name))[1] = public.auth_shop_id()::text
  );

create policy "brand-assets delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'brand-assets'
    and public.auth_role() in ('owner','staff')
    and (storage.foldername(name))[1] = public.auth_shop_id()::text
  );

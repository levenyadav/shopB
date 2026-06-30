-- One-shot, idempotent fix: create the storage buckets + policies that
-- migrations 005_storage.sql and 012_shop_branding.sql define, in case they
-- were never applied to the live DB ("Bucket not found" on photo upload).
-- Safe to run multiple times. Relies on public.auth_role() / public.auth_shop_id()
-- from 003_row_level_security.sql.

-- ---------------------------------------------------------------------------
-- item-photos  (purchase / inventory photos)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('item-photos', 'item-photos', true)
on conflict (id) do nothing;

drop policy if exists "item-photos read"   on storage.objects;
drop policy if exists "item-photos insert" on storage.objects;
drop policy if exists "item-photos update" on storage.objects;
drop policy if exists "item-photos delete" on storage.objects;

create policy "item-photos read"
  on storage.objects for select
  using (bucket_id = 'item-photos');

create policy "item-photos insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'item-photos'
    and public.auth_role() in ('owner','staff')
    and (storage.foldername(name))[1] = public.auth_shop_id()::text
  );

create policy "item-photos update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'item-photos'
    and public.auth_role() in ('owner','staff')
    and (storage.foldername(name))[1] = public.auth_shop_id()::text
  );

create policy "item-photos delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'item-photos'
    and public.auth_role() in ('owner','staff')
    and (storage.foldername(name))[1] = public.auth_shop_id()::text
  );

-- ---------------------------------------------------------------------------
-- brand-assets  (shop logo / app icon)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('brand-assets', 'brand-assets', true)
on conflict (id) do nothing;

drop policy if exists "brand-assets read"   on storage.objects;
drop policy if exists "brand-assets insert" on storage.objects;
drop policy if exists "brand-assets update" on storage.objects;
drop policy if exists "brand-assets delete" on storage.objects;

create policy "brand-assets read"
  on storage.objects for select
  using (bucket_id = 'brand-assets');

create policy "brand-assets insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'brand-assets'
    and public.auth_role() in ('owner','staff')
    and (storage.foldername(name))[1] = public.auth_shop_id()::text
  );

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

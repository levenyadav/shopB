-- =============================================================================
-- 005_storage.sql — item photo storage (SPEC §6.1 field 10, §6.2)
-- One public bucket, 'item-photos'. Public READ so getPublicUrl works on the
-- shopfront without signing. WRITE limited to owner/staff, and only inside their
-- own shop's folder: object path is  <shop_id>/<uuid>.<ext>.
-- Relies on auth_role() / auth_shop_id() defined in 003_row_level_security.sql.
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('item-photos', 'item-photos', true)
on conflict (id) do nothing;

-- Public read (anon + authenticated) — shopfront photos.
create policy "item-photos read"
  on storage.objects for select
  using (bucket_id = 'item-photos');

-- Owner/staff may upload into their own shop's folder.
create policy "item-photos insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'item-photos'
    and public.auth_role() in ('owner','staff')
    and (storage.foldername(name))[1] = public.auth_shop_id()::text
  );

-- Owner/staff may replace/remove their own shop's photos.
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

-- 054 — A user may not promote themselves or clear their own udhaar.
--
-- profiles_self_update (id = auth.uid(), no column limits) let ANY signed-in
-- user — and anyone can self-register on the storefront with a phone number —
-- update every column of their own row: role → 'owner' (full access to rates,
-- profit, ledger, approvals), balance_due → 0 (wipes their udhaar), shop_id,
-- is_active, phone (a phone is the login key). The app only ever edits name /
-- email / billing details, so everything else is locked for self-edits.
--
-- The owner is exempt (owner edits parties and staff via profiles_owner_update,
-- and may edit their own row). Service-role calls (Edge Functions creating
-- accounts) have no auth.uid() and pass. Triggers that move balance_due act on
-- the BUYER's row while auth.uid() is the owner/staff approving, so they pass.

create or replace function public.guard_profile_self_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and old.id = auth.uid()
     and coalesce(public.auth_role(), '') <> 'owner'
     and (new.id          is distinct from old.id
       or new.shop_id     is distinct from old.shop_id
       or new.role        is distinct from old.role
       or new.balance_due is distinct from old.balance_due
       or new.is_active   is distinct from old.is_active
       or new.phone       is distinct from old.phone
       or new.created_at  is distinct from old.created_at)
  then
    raise exception 'You can only change your name, email and billing details. Ask the shop to change anything else.'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_profiles_self_update_guard on public.profiles;
create trigger trg_profiles_self_update_guard
  before update on public.profiles
  for each row execute function public.guard_profile_self_update();

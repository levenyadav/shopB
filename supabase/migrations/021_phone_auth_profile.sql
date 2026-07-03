-- 021_phone_auth_profile.sql
-- Mobile number becomes the primary login identifier (Supabase phone OTP auth);
-- email is now an optional contact field on the profile, not the login handle.
--
--  * Buyers sign in with their phone number + a one-time SMS code. Phone-auth
--    users have NO email on auth.users, so the optional email they type at
--    signup has to live on profiles instead.
--  * handle_new_user() already copied new.phone and honoured role/full_name; here
--    we also carry the optional email through from the signup metadata.
--
-- NOTE (manual, outside this migration): phone OTP only works once an SMS
-- provider (Twilio / MSG91 / etc.) is enabled under Supabase Auth → Providers →
-- Phone, with the shop's credentials. Until then verifyOtp has nothing to send.
-- For local/dev, Supabase Auth lets you register fixed test OTPs per number.

alter table public.profiles
  add column if not exists email text;

comment on column public.profiles.email is 'Optional contact email. NOT the login identifier — buyers authenticate by phone (SMS OTP). NULL for phone-only / walk-in parties.';

-- Rebuild the signup handler to also carry the optional email through.
-- Owner/staff are still promoted manually; signup may only self-assign
-- customer/dealer (unchanged from 002).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare default_shop uuid; want_role text;
begin
  select id into default_shop from public.shops order by created_at limit 1;

  want_role := coalesce(new.raw_user_meta_data->>'role', 'customer');
  if want_role not in ('customer','dealer') then
    want_role := 'customer';   -- signup may only self-assign customer/dealer
  end if;

  insert into public.profiles (id, shop_id, full_name, phone, email, role)
  values (new.id, default_shop,
          coalesce(new.raw_user_meta_data->>'full_name', ''),
          new.phone,
          -- phone signups have no auth email; take the one typed at signup
          nullif(coalesce(new.email, new.raw_user_meta_data->>'email', ''), ''),
          want_role);
  return new;
end $$;

-- 032_phone_otp_register.sql
-- Storefront self-registration (SPEC §4.3, §6.3): a new buyer signs up on the
-- shopfront with name + mobile number, verifies an SMS OTP, and immediately gets
-- an ACTIVE customer account (retail Rate). Until now the `phone-otp` Edge
-- Function refused unknown numbers ("ask the shop to add you"); this column lets
-- a pending OTP carry the name typed at registration, so `verify` creates the
-- customer profile ONLY AFTER the phone is proven — never for a mistyped or
-- unverified number.
--
-- Only self-service CUSTOMERS are born this way. Dealer (wholesale) accounts stay
-- owner-created via create-party, so nobody can self-grant dealer pricing.
-- handle_new_user() (migration 021) already caps a signup's role to
-- customer/dealer and binds it to the default shop, so no trigger change is
-- needed here.

alter table public.phone_otps
  add column if not exists full_name text;

comment on column public.phone_otps.full_name is
  'Set only for a self-registration OTP (storefront signup). NULL for a normal login OTP. Carries the name from register→verify so the customer profile is created only after the phone is verified.';

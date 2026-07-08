-- 024_phone_otp.sql
-- Pending login OTPs, generated + verified by the `phone-otp` Edge Function.
--
-- Fast2SMS only SENDS the SMS; it does not generate or verify codes. So we mint
-- the 6-digit code server-side, store only its SHA-256 hash here (never the code
-- itself), and check it on verify. On success the row is deleted and a real
-- Supabase session is minted (admin generateLink → token_hash), exactly like the
-- old Firebase bridge did.
--
-- Server-only table: RLS is ON with NO policies, so the anon/authenticated keys
-- can never read or write it — only the service role (Edge Function) touches it.

create table if not exists public.phone_otps (
  phone       text primary key,          -- E.164, e.g. +919876543210
  code_hash   text not null,             -- sha256(phone || ':' || code)
  expires_at  timestamptz not null,
  attempts    int not null default 0
);

alter table public.phone_otps enable row level security;

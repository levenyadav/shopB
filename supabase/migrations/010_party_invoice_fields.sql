-- =============================================================================
-- 010_party_invoice_fields.sql — buyer GST number + full address.
--
-- Customer invoices (§15) need a "Bill To" block: the buyer's name, full address
-- and (for dealers / B2B) their GST number. profiles holds buyers, so these two
-- optional columns live there. Both are buyer-owned details, safe to print.
--
-- No new RLS: profiles already has profiles_owner_update (owner edits any buyer
-- in Party Detail) and profiles_self_update (a buyer edits their own in My
-- Account). These columns ride those existing policies.
-- =============================================================================

alter table public.profiles
  add column if not exists gstin   text,
  add column if not exists address text;

comment on column public.profiles.gstin   is 'Buyer GST number (optional); printed as Bill-To on customer invoices.';
comment on column public.profiles.address is 'Buyer full address (optional); printed as Bill-To on customer invoices.';

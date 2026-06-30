-- =============================================================================
-- 011_rebrand_shop.sql — rebrand the shop to Khattri Card Pratham.
--
-- The shop identity (name, address, GSTIN) is data, not config — it lives in the
-- single shops row. The 004 seed only runs on an empty DB, so existing databases
-- keep the old seeded name; this migration forward-fixes them. Idempotent: it
-- only rewrites the row still carrying the old seed name, so re-running (or running
-- after the owner edits details in Settings) is a no-op.
-- Phone and gst_rate are left as the owner set them.
-- =============================================================================

update public.shops
set name    = 'Khattri Card Pratham',
    address = 'D 58/12 A-13, Sigra Main Road, Varanasi - 221010',
    gstin   = '09AAPFK9899Q1ZN'
where name = 'Shree Card & Gift House';

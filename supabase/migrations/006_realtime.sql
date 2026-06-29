-- =============================================================================
-- 006_realtime.sql — live order notifications (SPEC §6.4, §5.2).
-- The owner console subscribes to changes on public.orders so a new shopfront
-- order updates the pending badge instantly. Realtime still honours RLS, so the
-- owner only receives rows for their own shop (orders_owner_select).
-- =============================================================================

alter publication supabase_realtime add table public.orders;

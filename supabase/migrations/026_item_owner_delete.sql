-- =============================================================================
-- 026_item_owner_delete.sql — let the owner hard-DELETE an item (Inventory).
--
-- The "Delete permanently" action on a discontinued line (Inventory → RowActions
-- → DeleteModal) issues a plain `delete from items where id = …`. RLS is enabled
-- on items (003) but only SELECT / INSERT / UPDATE policies were ever defined —
-- there was NO delete policy. Under Postgres RLS a DELETE with no permissive
-- policy is not an error: it silently matches ZERO rows and PostgREST returns
-- 204 with no error. The frontend saw error === null, treated it as success,
-- closed the modal and reloaded — and the item was still there. The button
-- appeared to "do nothing".
--
-- Add the missing policy: owner may delete their own shop's items. Deletion is
-- still genuinely restricted by the FK references from purchases / orders / sales
-- / ledger (NO ACTION) — Postgres raises 23503 the moment a line has any history,
-- which the DeleteModal already surfaces as "Can't delete… stays discontinued".
-- So this only lets never-transacted lines actually be removed. Golden Rules #1
-- and #9 remain enforced by the FKs, not by the absence of this policy.
-- =============================================================================

create policy items_owner_delete on public.items for delete
  using (auth_role() = 'owner' and shop_id = auth_shop_id());

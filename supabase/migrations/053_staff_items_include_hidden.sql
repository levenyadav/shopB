-- 053 — Staff see items that are hidden from the shopfront.
--
-- items.is_active is the owner's "Active on shopfront" switch. It is meant to
-- hide a product from ONLINE buyers only, but staff_items (027) also filtered on
-- it, so a hidden product vanished from Staff Inventory and Staff Stock Inquiry
-- even though it still sits on the shelf and can be sold at the Counter.
--
-- Same view as live, minus the is_active condition. Columns are unchanged, so
-- CREATE OR REPLACE keeps the existing grants and security_invoker=false.

create or replace view public.staff_items
with (security_invoker = false) as
select
  i.id, i.shop_id, i.item_no, i.name, i.category_id,
  c.name as category_name,
  i.location, i.quantity, i.low_stock_threshold,
  i.dealer_rate, i.rate, i.photo_url, i.created_at
from public.items i
left join public.categories c on c.id = i.category_id
where public.auth_role() = any (array['owner', 'staff'])
  and i.shop_id = public.auth_shop_id();
